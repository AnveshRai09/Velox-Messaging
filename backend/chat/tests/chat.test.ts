import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { AddressInfo } from "net";
import { io as ioClient, Socket } from "socket.io-client";

// Replace Cloudinary uploads with an in-process storage engine so the real
// multer limits and file filter run without touching the network.
vi.mock("multer-storage-cloudinary", () => ({
  CloudinaryStorage: class {
    _handleFile(_req: unknown, file: any, cb: (e: unknown, info?: object) => void) {
      let size = 0;
      file.stream.on("data", (chunk: Buffer) => (size += chunk.length));
      file.stream.on("end", () =>
        cb(null, {
          path: `https://res.cloudinary.com/test/${file.originalname}`,
          filename: `chat-images/${file.originalname}`,
          size,
        })
      );
      file.stream.on("error", cb);
    }
    _removeFile(_req: unknown, _file: unknown, cb: (e: unknown) => void) {
      cb(null);
    }
  },
}));

import { server } from "../src/app.js";
import { Chat } from "../src/models/Chat.js";
import { Messages } from "../src/models/Messages.js";
import { newId, startUserServiceStub, tokenFor } from "./helpers.js";

let base: string;
let userStub: Awaited<ReturnType<typeof startUserServiceStub>>;
const sockets: Socket[] = [];

const api = () => request(base);

const connectSocket = (userId: string) =>
  new Promise<Socket>((resolve) => {
    const s = ioClient(base, { query: { userId }, transports: ["websocket"] });
    sockets.push(s);
    s.on("connect", () => resolve(s));
  });

const nextEvent = <T = any>(s: Socket, event: string, ms = 3000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    s.once(event, (data: T) => {
      clearTimeout(t);
      resolve(data);
    });
  });

const createChat = async (a: string, b: string) => {
  const res = await api()
    .post("/api/v1/chat/new")
    .set("Authorization", `Bearer ${tokenFor(a)}`)
    .send({ otherUserId: b });
  return res.body.chatId as string;
};

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_TEST_URI as string, { dbName: "velox_chat_test" });
  userStub = await startUserServiceStub();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await mongoose.connection.db?.dropDatabase();
  await mongoose.disconnect();
  await userStub.close();
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  sockets.splice(0).forEach((s) => s.disconnect());
  userStub.state.fail = false;
  await mongoose.connection.db?.dropDatabase();
});

describe("auth", () => {
  it("rejects every chat route without a token", async () => {
    await api().post("/api/v1/chat/new").send({ otherUserId: "x" }).expect(401);
    await api().get("/api/v1/chat/all").expect(401);
    await api().post("/api/v1/message").send({ chatId: "x", text: "hi" }).expect(401);
    await api().get(`/api/v1/message/${newId()}`).expect(401);
  });

  it("rejects a forged token", async () => {
    await api().get("/api/v1/chat/all").set("Authorization", "Bearer not.a.jwt").expect(401);
  });
});

describe("POST /api/v1/chat/new", () => {
  it("requires the other user's id", async () => {
    await api().post("/api/v1/chat/new").set("Authorization", `Bearer ${tokenFor(newId())}`).send({}).expect(400);
  });

  it("creates a two-person chat", async () => {
    const [a, b] = [newId(), newId()];
    const res = await api()
      .post("/api/v1/chat/new")
      .set("Authorization", `Bearer ${tokenFor(a)}`)
      .send({ otherUserId: b })
      .expect(201);
    const chat = await Chat.findById(res.body.chatId);
    expect(chat?.users).toEqual([a, b]);
  });

  it("returns the existing chat instead of creating a duplicate", async () => {
    const [a, b] = [newId(), newId()];
    const first = await createChat(a, b);
    const res = await api()
      .post("/api/v1/chat/new")
      .set("Authorization", `Bearer ${tokenFor(b)}`)
      .send({ otherUserId: a })
      .expect(200);
    expect(res.body.chatId).toBe(first);
    expect(await Chat.countDocuments()).toBe(1);
  });
});

describe("POST /api/v1/message", () => {
  it("validates chatId and content", async () => {
    const a = newId();
    const auth = `Bearer ${tokenFor(a)}`;
    await api().post("/api/v1/message").set("Authorization", auth).send({ text: "hi" }).expect(400);
    await api().post("/api/v1/message").set("Authorization", auth).send({ chatId: newId() }).expect(400);
  });

  it("returns 404 for an unknown chat", async () => {
    await api()
      .post("/api/v1/message")
      .set("Authorization", `Bearer ${tokenFor(newId())}`)
      .send({ chatId: newId(), text: "hi" })
      .expect(404);
  });

  it("forbids sending into a chat you are not part of", async () => {
    const chatId = await createChat(newId(), newId());
    await api()
      .post("/api/v1/message")
      .set("Authorization", `Bearer ${tokenFor(newId())}`)
      .send({ chatId, text: "intruder" })
      .expect(403);
  });

  it("saves a text message and updates the chat preview", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    const res = await api()
      .post("/api/v1/message")
      .set("Authorization", `Bearer ${tokenFor(a)}`)
      .send({ chatId, text: "hello" })
      .expect(201);
    expect(res.body.message).toMatchObject({ text: "hello", messageType: "text", seen: false });
    const chat = await Chat.findById(chatId);
    expect(chat?.latestMessage).toMatchObject({ text: "hello", sender: a });
  });

  it("uploads an image and stores its URL", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    const res = await api()
      .post("/api/v1/message")
      .set("Authorization", `Bearer ${tokenFor(a)}`)
      .field("chatId", chatId)
      .attach("image", Buffer.from("fake-png"), { filename: "cat.png", contentType: "image/png" })
      .expect(201);
    expect(res.body.message.messageType).toBe("image");
    expect(res.body.message.image.url).toContain("cat.png");
    const chat = await Chat.findById(chatId);
    expect(chat?.latestMessage.text).toBe("📷 Image");
  });

  it("rejects non-image uploads with 400", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    const res = await api()
      .post("/api/v1/message")
      .set("Authorization", `Bearer ${tokenFor(a)}`)
      .field("chatId", chatId)
      .attach("image", Buffer.from("MZ..."), { filename: "virus.exe", contentType: "application/octet-stream" })
      .expect(400);
    expect(res.body.message).toBe("only image allowed");
  });

  it("rejects images over 5 MB with 400", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    const res = await api()
      .post("/api/v1/message")
      .set("Authorization", `Bearer ${tokenFor(a)}`)
      .field("chatId", chatId)
      .attach("image", Buffer.alloc(5 * 1024 * 1024 + 1), { filename: "big.png", contentType: "image/png" })
      .expect(400);
    expect(res.body.message).toMatch(/file too large/i);
  });
});

describe("GET /api/v1/chat/all", () => {
  it("lists chats with the other user's profile and unseen count", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    for (const text of ["one", "two"]) {
      await api().post("/api/v1/message").set("Authorization", `Bearer ${tokenFor(b)}`).send({ chatId, text });
    }
    const res = await api().get("/api/v1/chat/all").set("Authorization", `Bearer ${tokenFor(a)}`).expect(200);
    expect(res.body.chats).toHaveLength(1);
    expect(res.body.chats[0].user).toEqual({ _id: b, name: `name-${b.slice(-4)}` });
    expect(res.body.chats[0].chat.unseenCount).toBe(2);
    expect(res.body.chats[0].chat.latestMessage.text).toBe("two");
  });

  it("falls back to 'Unknown User' when the user service is down", async () => {
    const [a, b] = [newId(), newId()];
    await createChat(a, b);
    userStub.state.fail = true;
    const res = await api().get("/api/v1/chat/all").set("Authorization", `Bearer ${tokenFor(a)}`).expect(200);
    expect(res.body.chats[0].user.name).toBe("Unknown User");
  });
});

describe("GET /api/v1/message/:chatId", () => {
  it("returns messages oldest-first and marks the other user's messages as seen", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    for (const text of ["first", "second"]) {
      await api().post("/api/v1/message").set("Authorization", `Bearer ${tokenFor(b)}`).send({ chatId, text });
    }
    const res = await api().get(`/api/v1/message/${chatId}`).set("Authorization", `Bearer ${tokenFor(a)}`).expect(200);
    expect(res.body.messages.map((m: any) => m.text)).toEqual(["first", "second"]);
    expect(await Messages.countDocuments({ chatId, seen: false })).toBe(0);
  });

  it("returns 404 for an unknown chat", async () => {
    await api().get(`/api/v1/message/${newId()}`).set("Authorization", `Bearer ${tokenFor(newId())}`).expect(404);
  });

  it("forbids reading a chat you are not part of", async () => {
    const chatId = await createChat(newId(), newId());
    await api().post("/api/v1/message").set("Authorization", `Bearer ${tokenFor(newId())}`).send({ chatId, text: "x" });
    const res = await api()
      .get(`/api/v1/message/${chatId}`)
      .set("Authorization", `Bearer ${tokenFor(newId())}`)
      .expect(403);
    expect(res.body.messages).toBeUndefined();
  });

  it("still returns messages when the user service is down", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    userStub.state.fail = true;
    const res = await api().get(`/api/v1/message/${chatId}`).set("Authorization", `Bearer ${tokenFor(a)}`).expect(200);
    expect(res.body.user.name).toBe("Unknown User");
  });
});

describe("real-time events (Socket.IO)", () => {
  it("broadcasts the online-user list on connect and disconnect", async () => {
    const [a, b] = [newId(), newId()];
    const sa = await connectSocket(a);
    const online = nextEvent<string[]>(sa, "getOnlineUser");
    const sb = await connectSocket(b);
    expect(await online).toEqual(expect.arrayContaining([a, b]));
    const afterLeave = nextEvent<string[]>(sa, "getOnlineUser");
    sb.disconnect();
    expect(await afterLeave).not.toContain(b);
  });

  it("relays typing indicators to others in the chat room", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    const sa = await connectSocket(a);
    const sb = await connectSocket(b);
    sb.emit("joinChat", chatId);
    await new Promise((r) => setTimeout(r, 50));
    const typing = nextEvent(sb, "userTyping");
    sa.emit("typing", { chatId, userId: a });
    expect(await typing).toEqual({ chatId, userId: a });
    const stopped = nextEvent(sb, "userStoppedTyping");
    sa.emit("stopTyping", { chatId, userId: a });
    expect(await stopped).toEqual({ chatId, userId: a });
  });

  it("pushes new messages to the receiver instantly", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    const sb = await connectSocket(b);
    const incoming = nextEvent<any>(sb, "newMessage");
    await api().post("/api/v1/message").set("Authorization", `Bearer ${tokenFor(a)}`).send({ chatId, text: "ping" }).expect(201);
    expect((await incoming).text).toBe("ping");
  });

  it("marks a message seen and sends a read receipt when the receiver has the chat open", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    const sa = await connectSocket(a);
    const sb = await connectSocket(b);
    sb.emit("joinChat", chatId);
    await new Promise((r) => setTimeout(r, 50));
    const receipt = nextEvent<any>(sa, "messagesSeen");
    const res = await api().post("/api/v1/message").set("Authorization", `Bearer ${tokenFor(a)}`).send({ chatId, text: "read me" }).expect(201);
    expect(res.body.message.seen).toBe(true);
    expect(await receipt).toMatchObject({ chatId, seenBy: b });
  });

  it("sends a read receipt when the receiver opens the chat later", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    await api().post("/api/v1/message").set("Authorization", `Bearer ${tokenFor(a)}`).send({ chatId, text: "later" });
    const sa = await connectSocket(a);
    const receipt = nextEvent<any>(sa, "messagesSeen");
    await api().get(`/api/v1/message/${chatId}`).set("Authorization", `Bearer ${tokenFor(b)}`).expect(200);
    expect(await receipt).toMatchObject({ chatId, seenBy: b });
  });

  it("stops delivering room events after leaving the chat", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    const sa = await connectSocket(a);
    const sb = await connectSocket(b);
    sb.emit("joinChat", chatId);
    sb.emit("leaveChat", chatId);
    await new Promise((r) => setTimeout(r, 50));
    await expect(nextEvent(sb, "userTyping", 300)).rejects.toThrow(/timeout/);
    sa.emit("typing", { chatId, userId: a });
  });
});

describe("GET /metrics", () => {
  it("exposes HTTP, message and socket metrics", async () => {
    const [a, b] = [newId(), newId()];
    const chatId = await createChat(a, b);
    await api().post("/api/v1/message").set("Authorization", `Bearer ${tokenFor(a)}`).send({ chatId, text: "m" });
    const res = await api().get("/metrics").expect(200);
    expect(res.text).toMatch(/http_requests_total\{[^}]*route="\/api\/v1\/message"[^}]*status="201"/);
    expect(res.text).toMatch(/messages_sent_total\{[^}]*type="text"/);
    expect(res.text).toContain("socket_online_users");
  });

  it("serves a health check", async () => {
    await api().get("/health").expect(200, { status: "ok" });
  });
});
