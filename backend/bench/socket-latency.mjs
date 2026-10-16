// Measures end-to-end delivery latency: time from POST /message on the sender
// side until the receiver's socket gets the "newMessage" event.
import { io } from "socket.io-client";
import { readFileSync, writeFileSync } from "fs";

const CHAT_URL = process.env.CHAT_URL ?? "http://127.0.0.1:5002";
const PAIRS = Number(process.env.PAIRS ?? 50);
const MESSAGES_PER_PAIR = Number(process.env.MESSAGES ?? 20);
const { users, chats } = JSON.parse(readFileSync("fixtures.json", "utf8"));
const tokenOf = Object.fromEntries(users.map((u) => [u.id, u.token]));

const connect = (userId) =>
  new Promise((resolve, reject) => {
    const s = io(CHAT_URL, { query: { userId }, transports: ["websocket"], forceNew: true });
    s.once("connect", () => resolve(s));
    s.once("connect_error", reject);
  });

const pairs = chats.slice(0, PAIRS);
const receivers = await Promise.all(pairs.map((c) => connect(c.users[1])));
console.log(`connected ${receivers.length} receiver sockets`);

const latencies = [];
await Promise.all(
  pairs.map(async (chat, i) => {
    const sock = receivers[i];
    for (let m = 0; m < MESSAGES_PER_PAIR; m++) {
      const text = `msg-${i}-${m}`;
      const got = new Promise((resolve) => {
        const handler = (msg) => {
          if (msg.text === text) {
            sock.off("newMessage", handler);
            resolve(performance.now());
          }
        };
        sock.on("newMessage", handler);
      });
      const start = performance.now();
      const res = await fetch(`${CHAT_URL}/api/v1/message`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenOf[chat.users[0]]}` },
        body: JSON.stringify({ chatId: chat.id, text }),
      });
      if (res.status !== 201) throw new Error(`send failed: ${res.status}`);
      latencies.push((await got) - start);
    }
  })
);

latencies.sort((a, b) => a - b);
const q = (p) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
const summary = {
  concurrent_pairs: PAIRS,
  messages: latencies.length,
  p50_ms: +q(0.5).toFixed(1),
  p95_ms: +q(0.95).toFixed(1),
  p99_ms: +q(0.99).toFixed(1),
  max_ms: +latencies.at(-1).toFixed(1),
};
console.log(summary);
writeFileSync("socket-results.json", JSON.stringify(summary, null, 2));
receivers.forEach((s) => s.disconnect());
