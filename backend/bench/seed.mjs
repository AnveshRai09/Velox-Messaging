// Seeds users and chats for load testing and writes their ids + JWTs to fixtures.json.
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { writeFileSync } from "fs";

const MONGO_URI = process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017";
const JWT_SECRET = process.env.JWT_SECRET ?? "bench-secret";
const USERS = Number(process.env.USERS ?? 100);

await mongoose.connect(MONGO_URI, { dbName: "Chatappmicroserviceapp" });
const db = mongoose.connection.db;
await db.dropDatabase();

const users = Array.from({ length: USERS }, (_, i) => ({
  _id: new mongoose.Types.ObjectId(),
  name: `bench${i}`,
  email: `bench${i}@test.com`,
  createdAt: new Date(),
  updatedAt: new Date(),
}));
await db.collection("users").insertMany(users);

// Pair users up: user 2k chats with user 2k+1.
const chats = [];
for (let i = 0; i + 1 < USERS; i += 2) {
  chats.push({
    _id: new mongoose.Types.ObjectId(),
    users: [users[i]._id.toString(), users[i + 1]._id.toString()],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
await db.collection("chats").insertMany(chats);

// Message history: MESSAGES_PER_CHAT messages per chat, half of them unseen,
// so the chat list's unseen-count queries have real data to work through.
const PER_CHAT = Number(process.env.MESSAGES_PER_CHAT ?? 0);
if (PER_CHAT > 0) {
  const batch = [];
  for (const c of chats) {
    for (let m = 0; m < PER_CHAT; m++) {
      const t = new Date(Date.now() - (PER_CHAT - m) * 1000);
      batch.push({
        chatId: c._id,
        sender: c.users[m % 2],
        text: `seed message ${m}`,
        messageType: "text",
        seen: m % 4 !== 0,
        seenAt: null,
        createdAt: t,
        updatedAt: t,
      });
    }
  }
  for (let i = 0; i < batch.length; i += 5000) {
    await db.collection("messages").insertMany(batch.slice(i, i + 5000));
  }
}

const token = (u) =>
  jwt.sign({ user: { _id: u._id.toString(), name: u.name, email: u.email } }, JWT_SECRET, { expiresIn: "1d" });

writeFileSync(
  "fixtures.json",
  JSON.stringify({
    users: users.map((u) => ({ id: u._id.toString(), token: token(u) })),
    chats: chats.map((c) => ({ id: c._id.toString(), users: c.users })),
  })
);
console.log(`seeded ${users.length} users, ${chats.length} chats, ${chats.length * PER_CHAT} messages`);
await mongoose.disconnect();
