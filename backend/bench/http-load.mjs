// HTTP load test for the user and chat services using autocannon.
import autocannon from "autocannon";
import { readFileSync, writeFileSync } from "fs";

const USER_URL = process.env.USER_URL ?? "http://127.0.0.1:5000";
const CHAT_URL = process.env.CHAT_URL ?? "http://127.0.0.1:5002";
const DURATION = Number(process.env.DURATION ?? 20);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);
const { users, chats } = JSON.parse(readFileSync("fixtures.json", "utf8"));

let n = 0;
const pick = (arr) => arr[n++ % arr.length];

const scenarios = [
  {
    name: "user: GET /api/v1/me (JWT auth)",
    url: `${USER_URL}/api/v1/me`,
    setupClient: (c) => c.setHeaders({ authorization: `Bearer ${pick(users).token}` }),
  },
  {
    name: "user: GET /api/v1/user/:id (MongoDB read)",
    url: USER_URL,
    requests: [{ method: "GET", setupRequest: (r) => ({ ...r, path: `/api/v1/user/${pick(users).id}` }) }],
  },
  {
    name: "chat: GET /api/v1/message/:chatId (history + mark seen)",
    url: CHAT_URL,
    requests: [
      {
        method: "GET",
        setupRequest: (r) => {
          const chat = pick(chats);
          const reader = users.find((u) => u.id === chat.users[1]);
          return { ...r, path: `/api/v1/message/${chat.id}`, headers: { authorization: `Bearer ${reader.token}` } };
        },
      },
    ],
  },
  {
    name: "chat: GET /api/v1/chat/all (fan-out to user service)",
    url: `${CHAT_URL}/api/v1/chat/all`,
    setupClient: (c) => c.setHeaders({ authorization: `Bearer ${pick(users).token}` }),
  },
  {
    name: "chat: POST /api/v1/message (write + socket emit)",
    url: CHAT_URL,
    requests: [
      {
        method: "POST",
        setupRequest: (r) => {
          const chat = pick(chats);
          const sender = users.find((u) => u.id === chat.users[0]);
          return {
            ...r,
            path: "/api/v1/message",
            headers: { "content-type": "application/json", authorization: `Bearer ${sender.token}` },
            body: JSON.stringify({ chatId: chat.id, text: "load test message" }),
          };
        },
      },
    ],
  },
];

const results = [];
for (const s of scenarios) {
  const r = await autocannon({ connections: CONNECTIONS, duration: DURATION, ...s });
  const row = {
    scenario: s.name,
    requests: r.requests.total,
    rps_avg: Math.round(r.requests.average),
    p50_ms: r.latency.p50,
    p90_ms: r.latency.p90,
    p99_ms: r.latency.p99,
    non2xx: r.non2xx,
    errors: r.errors,
  };
  console.log(row);
  results.push(row);
}
writeFileSync("http-results.json", JSON.stringify({ connections: CONNECTIONS, duration_s: DURATION, results }, null, 2));
