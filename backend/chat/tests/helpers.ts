import express from "express";
import http from "http";
import { AddressInfo } from "net";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

export const tokenFor = (id: string, name = `user-${id.slice(-4)}`) =>
  jwt.sign({ user: { _id: id, name, email: `${id}@test.com` } }, "test-jwt-secret");

export const newId = () => new mongoose.Types.ObjectId().toString();

// A stand-in for the user service that the chat service calls over HTTP.
export const startUserServiceStub = async () => {
  const state = { fail: false };
  const stub = express();
  stub.get("/api/v1/user/:id", (req, res) => {
    if (state.fail) {
      res.status(500).json({ message: "user service down" });
      return;
    }
    res.json({ _id: req.params.id, name: `name-${req.params.id.slice(-4)}` });
  });
  const server = http.createServer(stub);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  process.env.USER_SERVICE = `http://127.0.0.1:${port}`;
  return { state, close: () => new Promise((r) => server.close(r)) };
};
