import { beforeEach, describe, expect, it, vi } from "vitest";

const channel = {
  assertQueue: vi.fn().mockResolvedValue(undefined),
  sendToQueue: vi.fn(),
};
const connect = vi.fn();

vi.mock("amqplib", () => ({ default: { connect } }));

describe("RabbitMQ publisher", () => {
  beforeEach(() => {
    vi.resetModules();
    channel.assertQueue.mockClear();
    channel.sendToQueue.mockClear();
    connect.mockReset();
  });

  it("does nothing (and does not throw) before a channel exists", async () => {
    const { publishToQueue } = await import("../src/config/rabbitmq.js");
    await expect(publishToQueue("send-otp", { to: "a" })).resolves.toBeUndefined();
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it("publishes persistent messages to a durable queue", async () => {
    connect.mockResolvedValue({ createChannel: vi.fn().mockResolvedValue(channel) });
    const { connectRabbitMQ, publishToQueue } = await import("../src/config/rabbitmq.js");
    await connectRabbitMQ();
    await publishToQueue("send-otp", { to: "a@test.com" });

    expect(channel.assertQueue).toHaveBeenCalledWith("send-otp", { durable: true });
    const [queue, payload, options] = channel.sendToQueue.mock.calls[0];
    expect(queue).toBe("send-otp");
    expect(JSON.parse(payload.toString())).toEqual({ to: "a@test.com" });
    expect(options).toEqual({ persistent: true });
  });

  it("survives a failed connection without crashing the service", async () => {
    connect.mockRejectedValue(new Error("ECONNREFUSED"));
    const { connectRabbitMQ } = await import("../src/config/rabbitmq.js");
    await expect(connectRabbitMQ()).resolves.toBeUndefined();
  });
});
