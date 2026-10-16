import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import multer from "multer";
import chatRoutes from "./routes/chat.js";
import { app, server, io } from "./config/socket.js";
import { metricsHandler, metricsMiddleware } from "./config/metrics.js";

app.use(metricsMiddleware);
app.use(express.json());
app.use(cors());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.get("/metrics", metricsHandler);

app.use("/api/v1", chatRoutes);

// Upload errors (file too large, non-image file) are client errors, not 500s.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ message: err.message });
    return;
  }
  if (err.message === "only image allowed") {
    res.status(400).json({ message: err.message });
    return;
  }
  res.status(500).json({ message: err.message });
});

export { app, server, io };
