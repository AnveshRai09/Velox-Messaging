import { Request, Response } from "express";
import client from "prom-client";

export const register = new client.Registry();
register.setDefaultLabels({ service: "mail" });
client.collectDefaultMetrics({ register });

export const otpEmailsTotal = new client.Counter({
  name: "otp_emails_total",
  help: "OTP emails processed from the queue, by outcome",
  labelNames: ["outcome"],
  registers: [register],
});

export const metricsHandler = async (_req: Request, res: Response) => {
  res.set("Content-Type", register.contentType);
  res.send(await register.metrics());
};
