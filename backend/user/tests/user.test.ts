import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";

vi.mock("../src/config/rabbitmq.js", () => ({
  connectRabbitMQ: vi.fn(),
  publishToQueue: vi.fn().mockResolvedValue(undefined),
}));

import app from "../src/app.js";
import { publishToQueue } from "../src/config/rabbitmq.js";
import { redisClient } from "../src/config/redis.js";
import { User } from "../src/model/User.js";
import { generateToken } from "../src/config/generateToken.js";
import {
  connectTestServices,
  disconnectTestServices,
  resetTestServices,
} from "./helpers.js";

const publishMock = vi.mocked(publishToQueue);

const loginAndGetOtp = async (email: string) => {
  await request(app).post("/api/v1/login").send({ email }).expect(200);
  return (await redisClient.get(`otp:${email}`)) as string;
};

const signUpUser = async (email: string) => {
  const otp = await loginAndGetOtp(email);
  const res = await request(app)
    .post("/api/v1/verify")
    .send({ email, otp })
    .expect(200);
  return res.body as { token: string; user: { _id: string; name: string } };
};

beforeAll(connectTestServices);
afterAll(disconnectTestServices);
beforeEach(async () => {
  await resetTestServices();
  publishMock.mockClear();
});

describe("GET /health", () => {
  it("reports the service as up", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("POST /api/v1/login", () => {
  it("rejects a request without an email", async () => {
    const res = await request(app).post("/api/v1/login").send({}).expect(400);
    expect(res.body.message).toMatch(/email is required/i);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("stores a 6-digit OTP in Redis with a 5-minute TTL", async () => {
    const otp = await loginAndGetOtp("a@test.com");
    expect(otp).toMatch(/^\d{6}$/);
    const ttl = await redisClient.ttl("otp:a@test.com");
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it("publishes the OTP email to the send-otp queue", async () => {
    const otp = await loginAndGetOtp("b@test.com");
    expect(publishMock).toHaveBeenCalledTimes(1);
    const [queue, message] = publishMock.mock.calls[0];
    expect(queue).toBe("send-otp");
    expect(message).toMatchObject({ to: "b@test.com" });
    expect(message.body).toContain(otp);
  });

  it("rate-limits a second request within 1 minute", async () => {
    await request(app).post("/api/v1/login").send({ email: "c@test.com" }).expect(200);
    const res = await request(app)
      .post("/api/v1/login")
      .send({ email: "c@test.com" })
      .expect(429);
    expect(res.body.message).toMatch(/too may requests/i);
    expect(publishMock).toHaveBeenCalledTimes(1);
    const ttl = await redisClient.ttl("otp:ratelimit:c@test.com");
    expect(ttl).toBeGreaterThan(50);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("rate-limits per email, not globally", async () => {
    await request(app).post("/api/v1/login").send({ email: "d@test.com" }).expect(200);
    await request(app).post("/api/v1/login").send({ email: "e@test.com" }).expect(200);
  });

  it("returns 500 with the error message if Redis fails", async () => {
    const spy = vi.spyOn(redisClient, "get").mockRejectedValueOnce(new Error("redis down"));
    const res = await request(app).post("/api/v1/login").send({ email: "f@test.com" }).expect(500);
    expect(res.body.message).toBe("redis down");
    spy.mockRestore();
  });
});

describe("POST /api/v1/verify", () => {
  it("requires both email and OTP", async () => {
    await request(app).post("/api/v1/verify").send({ email: "a@test.com" }).expect(400);
    await request(app).post("/api/v1/verify").send({ otp: "123456" }).expect(400);
  });

  it("rejects a wrong OTP", async () => {
    await loginAndGetOtp("a@test.com");
    const res = await request(app)
      .post("/api/v1/verify")
      .send({ email: "a@test.com", otp: "000000-wrong" })
      .expect(400);
    expect(res.body.message).toMatch(/invalid or expired/i);
  });

  it("rejects an OTP that was never issued", async () => {
    await request(app)
      .post("/api/v1/verify")
      .send({ email: "nobody@test.com", otp: "123456" })
      .expect(400);
  });

  it("creates the user on first verification and returns a JWT", async () => {
    const { token, user } = await signUpUser("newuser@test.com");
    expect(user.name).toBe("newuser@");
    expect(await User.countDocuments()).toBe(1);
    const decoded = jwt.verify(token, "test-jwt-secret") as jwt.JwtPayload;
    expect(decoded.user.email).toBe("newuser@test.com");
  });

  it("issues tokens that expire after 15 days", async () => {
    const { token } = await signUpUser("exp@test.com");
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(15 * 24 * 60 * 60);
  });

  it("deletes the OTP after use so it cannot be replayed", async () => {
    const otp = await loginAndGetOtp("replay@test.com");
    await request(app).post("/api/v1/verify").send({ email: "replay@test.com", otp }).expect(200);
    await request(app).post("/api/v1/verify").send({ email: "replay@test.com", otp }).expect(400);
  });

  it("logs an existing user in without creating a duplicate", async () => {
    const first = await signUpUser("again@test.com");
    await redisClient.del("otp:ratelimit:again@test.com");
    const second = await signUpUser("again@test.com");
    expect(second.user._id).toBe(first.user._id);
    expect(await User.countDocuments()).toBe(1);
  });
});

describe("JWT auth middleware", () => {
  it("rejects requests with no Authorization header", async () => {
    const res = await request(app).get("/api/v1/me").expect(401);
    expect(res.body.message).toMatch(/no auth header/i);
  });

  it("rejects a header without the Bearer prefix", async () => {
    await request(app).get("/api/v1/me").set("Authorization", "Token abc").expect(401);
  });

  it("rejects a token signed with a different secret", async () => {
    const forged = jwt.sign({ user: { _id: "x" } }, "attacker-secret");
    const res = await request(app)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${forged}`)
      .expect(401);
    expect(res.body.message).toMatch(/jwt error/i);
  });

  it("rejects an expired token", async () => {
    const expired = jwt.sign({ user: { _id: "x" } }, "test-jwt-secret", { expiresIn: -10 });
    await request(app).get("/api/v1/me").set("Authorization", `Bearer ${expired}`).expect(401);
  });

  it("rejects a valid token that carries no user", async () => {
    const empty = jwt.sign({ foo: "bar" }, "test-jwt-secret");
    const res = await request(app)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${empty}`)
      .expect(401);
    expect(res.body.message).toMatch(/invalid token/i);
  });

  it("returns the profile for a valid token", async () => {
    const { token } = await signUpUser("me@test.com");
    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body.email).toBe("me@test.com");
  });
});

describe("user endpoints", () => {
  it("lists all users for an authenticated caller", async () => {
    const { token } = await signUpUser("one@test.com");
    await User.create({ name: "two", email: "two@test.com" });
    const res = await request(app).get("/api/v1/user/all").set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body).toHaveLength(2);
  });

  it("does not list users without a token", async () => {
    await request(app).get("/api/v1/user/all").expect(401);
  });

  it("fetches a single user by id (used by the chat service)", async () => {
    const created = await User.create({ name: "bob", email: "bob@test.com" });
    const res = await request(app).get(`/api/v1/user/${created._id}`).expect(200);
    expect(res.body.name).toBe("bob");
  });

  it("updates the name and returns a refreshed token", async () => {
    const { token } = await signUpUser("rename@test.com");
    const res = await request(app)
      .post("/api/v1/update/user")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Anvesh" })
      .expect(200);
    expect(res.body.user.name).toBe("Anvesh");
    const decoded = jwt.verify(res.body.token, "test-jwt-secret") as jwt.JwtPayload;
    expect(decoded.user.name).toBe("Anvesh");
  });

  it("returns 404 when updating a user that no longer exists", async () => {
    const ghost = generateToken({ _id: "64b000000000000000000000", name: "ghost" });
    await request(app)
      .post("/api/v1/update/user")
      .set("Authorization", `Bearer ${ghost}`)
      .send({ name: "x" })
      .expect(404);
  });
});

describe("GET /metrics", () => {
  it("exposes request counts by route and OTP outcomes", async () => {
    await request(app).post("/api/v1/login").send({ email: "m@test.com" });
    await request(app).post("/api/v1/login").send({ email: "m@test.com" });
    const res = await request(app).get("/metrics").expect(200);
    expect(res.text).toContain("http_request_duration_seconds_bucket");
    expect(res.text).toMatch(/http_requests_total\{[^}]*route="\/api\/v1\/login"[^}]*status="429"/);
    expect(res.text).toMatch(/otp_requests_total\{[^}]*outcome="sent"/);
    expect(res.text).toMatch(/otp_requests_total\{[^}]*outcome="rate_limited"/);
  });
});
