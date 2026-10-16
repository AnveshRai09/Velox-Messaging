import dotenv from "dotenv";
import connectDb from "./config/db.js";
import { connectRabbitMQ } from "./config/rabbitmq.js";
import { connectRedis } from "./config/redis.js";
import app from "./app.js";

dotenv.config();

connectDb();

connectRabbitMQ();

connectRedis();

const port = process.env.PORT;

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
