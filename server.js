import express from "express";
import mongoose from "mongoose";
import Match from "./models/Match.js";
import dotenv from "dotenv";
import cron from "node-cron";
import { exec } from "child_process";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGO_URI).then(() =>
  console.log("✅ MongoDB connected")
);

cron.schedule("* * * * *", () => {
  exec("node fetchMatches.js");
});

app.get("/matches", async (req, res) => {
  const data = await Match.find();
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
