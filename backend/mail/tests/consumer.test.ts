import { beforeEach, describe, expect, it, vi } from "vitest";

const { channel, connect } = vi.hoisted(() => ({
  channel: {
    assertQueue: vi.fn(),
    consume: vi.fn(),
    ack: vi.fn(),
  },
  connect: vi.fn(),
}));
vi.mock("amqplib", () => ({ default: { connect } }));

import { handleOtpMessage, startSendOtpConsumer, QUEUE_NAME } from "../src/consumer.js";
import { register } from "../src/metrics.js";

const msgFor = (payload: object) => ({ content: Buffer.from(JSON.stringify(payload)) }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  register.resetMetrics();
});

describe("handleOtpMessage", () => {
  it("emails the OTP and acks the message", async () => {
    const transporter = { sendMail: vi.fn().mockResolvedValue({}) } as any;
    const msg = msgFor({ to: "a@test.com", subject: "Your otp code", body: "Your OTP is 123456" });
    await handleOtpMessage(channel as any, msg, transporter);
    expect(transporter.sendMail).toHaveBeenCalledWith({
      from: "Chat app",
      to: "a@test.com",
      subject: "Your otp code",
      text: "Your OTP is 123456",
    });
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(await register.getSingleMetricAsString("otp_emails_total")).toMatch(/outcome="sent"[^\n]* 1/);
  });

  it("does not ack when sending fails, so the message is not lost", async () => {
    const transporter = { sendMail: vi.fn().mockRejectedValue(new Error("SMTP down")) } as any;
    await handleOtpMessage(channel as any, msgFor({ to: "a@test.com" }), transporter);
    expect(channel.ack).not.toHaveBeenCalled();
    expect(await register.getSingleMetricAsString("otp_emails_total")).toMatch(/outcome="failed"[^\n]* 1/);
  });

  it("does not ack a malformed message", async () => {
    const transporter = { sendMail: vi.fn() } as any;
    await handleOtpMessage(channel as any, { content: Buffer.from("not json") } as any, transporter);
    expect(transporter.sendMail).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it("ignores a null message (consumer cancelled)", async () => {
    await expect(handleOtpMessage(channel as any, null)).resolves.toBeUndefined();
  });
});

describe("startSendOtpConsumer", () => {
  it("consumes from a durable send-otp queue", async () => {
    connect.mockResolvedValue({ createChannel: vi.fn().mockResolvedValue(channel) });
    await startSendOtpConsumer();
    expect(channel.assertQueue).toHaveBeenCalledWith(QUEUE_NAME, { durable: true });
    expect(channel.consume).toHaveBeenCalledWith(QUEUE_NAME, expect.any(Function));
  });

  it("logs instead of crashing when RabbitMQ is unreachable", async () => {
    connect.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(startSendOtpConsumer()).resolves.toBeUndefined();
  });
});
