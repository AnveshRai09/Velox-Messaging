# Velox Messaging

Real-time chat built as three Node.js/TypeScript microservices with a Next.js frontend.

| Service | Responsibility | Stack |
|---|---|---|
| `backend/user` | OTP login, JWT auth, profiles | Express, MongoDB, Redis (OTP cache + rate limit), RabbitMQ publisher |
| `backend/mail` | Sends OTP emails from the queue | RabbitMQ consumer, Nodemailer |
| `backend/chat` | Chats, messages, image uploads, real-time events | Express, MongoDB, Socket.IO, Multer + Cloudinary |
| `frontend` | Web client | Next.js, React, Socket.IO client |

Login flow: `POST /login` stores a 6-digit OTP in Redis (5-minute TTL, 1-minute rate limit per email) and publishes it to the durable `send-otp` queue. The mail service consumes it and emails the code. `POST /verify` checks the OTP and returns a 15-day JWT that the chat service verifies on every request.

## Running locally

Each service reads its own `.env`; see the `.env.example` next to each `package.json`.

```bash
cd backend/user && npm install && npm run build && npm start
cd backend/mail && npm install && npm run build && npm start
cd backend/chat && npm install && npm run build && npm start
cd frontend && npm install && npm run dev
```

## Tests

63 tests across the three services (Vitest + Supertest), run in CI against real MongoDB and Redis on every pull request.

| Service | Tests | Line coverage | What is covered |
|---|---|---|---|
| user | 30 | 94% | OTP issue/verify, Redis TTLs, rate limiting, OTP replay, JWT middleware (missing, forged, expired tokens), profile updates, queue publishing |
| chat | 27 | 91% | Chat creation and dedupe, access control, text and image messages, upload limits (type, 5 MB), unseen counts, user-service fallback, Socket.IO presence, typing, delivery and read receipts |
| mail | 6 | 96% | Email sending, ack only on success, malformed messages, broker failures |

```bash
# needs MongoDB on 27017 and Redis on 6379 (override with MONGO_TEST_URI / REDIS_TEST_URL)
cd backend/user && npm test
cd backend/chat && npm run test:coverage
```

## Metrics

Every service exposes Prometheus metrics at `GET /metrics` and a health check at `GET /health`.

| Metric | Service | Meaning |
|---|---|---|
| `http_requests_total{method,route,status}` | user, chat | Request count per route pattern and status |
| `http_request_duration_seconds{method,route,status}` | user, chat | Latency histogram per route |
| `otp_requests_total{outcome}` | user | OTPs sent vs. rate-limited |
| `otp_emails_total{outcome}` | mail | OTP emails sent vs. failed |
| `messages_sent_total{type}` | chat | Messages persisted, text vs. image |
| `socket_online_users` | chat | Users currently connected |
| `socket_events_total{event}` | chat | typing, stopTyping, joinChat, leaveChat |

Plus default Node.js process metrics (CPU, memory, event-loop lag, GC).

## Benchmarks

`backend/bench` seeds 100 users, 50 chats and 10,000 messages, then load-tests the services with autocannon and measures Socket.IO delivery latency. The [Benchmark workflow](.github/workflows/benchmark.yml) runs it on a GitHub-hosted runner against MongoDB 7, Redis 7 and RabbitMQ 3, once for `main` (baseline) and once for the branch (current).

Results with 50 concurrent connections, 20 s per scenario. "Before" is the code without MongoDB indexes, "after" adds indexes on `messages(chatId, seen)`, `messages(chatId, createdAt)` and `chats(users)`.

| Scenario | Req/s before → after | p50 ms before → after | p99 ms before → after |
|---|---|---|---|
| `GET /chat/all` (chat list with unseen counts) | 312 → **580** | 152 → **81** | 424 → **126** |
| `GET /message/:chatId` (200-message history) | 79 → **118** | 599 → **407** | 1402 → **745** |
| `POST /message` (write + socket emit) | 567 → 552 | 86 → 88 | 133 → 122 |
| `GET /user/:id` (MongoDB read) | 1797 → 1784 | 26 → 26 | 47 → 49 |
| `GET /me` (JWT verification only) | 3248 → 3174 | 14 → 14 | 24 → 27 |

Socket.IO end-to-end delivery (HTTP send to receiver's `newMessage` event, 50 concurrent sender/receiver pairs, 1,000 messages): **p50 95 ms, p95 125 ms, p99 158 ms**.

The "after" code also includes the Prometheus middleware on every request. The scenarios the indexes do not touch stayed within about 2%, which bounds both the metrics overhead and run-to-run noise. Each number is from a single run; absolute values depend on the runner.

```bash
cd backend/bench && npm install
USERS=100 MESSAGES_PER_CHAT=200 node seed.mjs   # then start user + chat services
node http-load.mjs && node socket-latency.mjs
```
