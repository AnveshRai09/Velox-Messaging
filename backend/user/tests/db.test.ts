import { describe, expect, it } from "vitest";
import connectDb from "../src/config/db.js";

describe("connectDb", () => {
  it("fails fast when MONGO_URI is missing", async () => {
    const saved = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    await expect(connectDb()).rejects.toThrow(/MONGO_URI is not defined/);
    process.env.MONGO_URI = saved;
  });
});
