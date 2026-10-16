import express from "express";
import dotenv from "dotenv";
import { startSendOtpConsumer } from "./consumer.js";
import { metricsHandler } from "./metrics.js";

dotenv.config();

startSendOtpConsumer();

const app = express();

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.get("/metrics", metricsHandler);

app.listen(process.env.PORT, () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});
