import amqp from "amqplib";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { otpEmailsTotal } from "./metrics.js";
dotenv.config();

export const QUEUE_NAME = "send-otp";

export const createTransporter = () =>
  nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true, //for aws
    auth: {
      user: process.env.USER,
      pass: process.env.PASSWORD,
    },
  });

// Sends one OTP email; the message is acked only after the mail is accepted,
// so a failed send is not lost.
export const handleOtpMessage = async (
  channel: amqp.Channel,
  msg: amqp.ConsumeMessage | null,
  transporter = createTransporter()
) => {
  if (!msg) return;
  try {
    const { to, subject, body } = JSON.parse(msg.content.toString());

    await transporter.sendMail({
      from: "Chat app",
      to,
      subject,
      text: body,
    });

    console.log(`OTP mail sent to ${to}`);
    otpEmailsTotal.inc({ outcome: "sent" });
    channel.ack(msg);
  } catch (error) {
    otpEmailsTotal.inc({ outcome: "failed" });
    console.log("Failed to send otp", error);
  }
};

export const startSendOtpConsumer = async () => {
  try {
    const connection = await amqp.connect({
      protocol: "amqp",
      hostname: process.env.Rabbitmq_Host,
      port: 5672,
      username: process.env.Rabbitmq_Username,
      password: process.env.Rabbitmq_Password,
    });

    const channel = await connection.createChannel();

    await channel.assertQueue(QUEUE_NAME, { durable: true });

    console.log("✅ Mail Service consumer started, listening for otp emails");

    channel.consume(QUEUE_NAME, (msg) => handleOtpMessage(channel, msg));
  } catch (error) {
    console.log("Failed to start rabbitmq consumer", error);
  }
};
