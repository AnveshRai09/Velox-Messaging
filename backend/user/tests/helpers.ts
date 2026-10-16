import mongoose from "mongoose";
import { redisClient } from "../src/config/redis.js";

export const connectTestServices = async () => {
  await mongoose.connect(process.env.MONGO_TEST_URI as string, {
    dbName: "velox_user_test",
  });
  if (!redisClient.isOpen) await redisClient.connect();
};

export const resetTestServices = async () => {
  await mongoose.connection.db?.dropDatabase();
  await redisClient.flushDb();
};

export const disconnectTestServices = async () => {
  await mongoose.connection.db?.dropDatabase();
  await mongoose.disconnect();
  if (redisClient.isOpen) await redisClient.quit();
};
