import { NextFunction, Request, Response } from "express";
import client from "prom-client";

export const register = new client.Registry();
register.setDefaultLabels({ service: "user" });
client.collectDefaultMetrics({ register });

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export const otpRequestsTotal = new client.Counter({
  name: "otp_requests_total",
  help: "OTP login requests by outcome",
  labelNames: ["outcome"],
  registers: [register],
});

// Records count and latency for every request, labelled by the matched route
// pattern (e.g. /api/v1/user/:id) so label cardinality stays bounded.
export const metricsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path
      ? `${req.baseUrl}${req.route.path}`
      : "unmatched";
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
};

export const metricsHandler = async (_req: Request, res: Response) => {
  res.set("Content-Type", register.contentType);
  res.send(await register.metrics());
};
