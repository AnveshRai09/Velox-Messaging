import express from "express";
import cors from "cors";
import userRoutes from "./routes/user.js";
import { metricsHandler, metricsMiddleware } from "./config/metrics.js";

const app = express();

app.use(metricsMiddleware);
app.use(express.json());
app.use(cors());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.get("/metrics", metricsHandler);

app.use("/api/v1", userRoutes);

export default app;
