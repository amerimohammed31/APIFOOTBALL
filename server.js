import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import fetchMatches from "./fetchMatches.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

mongoose.connect(process.env.MONGO_URI, {
  dbName: process.env.DB_NAME,
})
.then(() => console.log("✅ Connected to MongoDB"))
.catch((err) => console.error("❌ MongoDB connection error:", err));

import Match from "./models/Match.js";

app.get("/matches", async (req, res) => {
  try {
    const matches = await Match.find({});
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// تحديث المباريات تلقائيًا كل دقيقة
setInterval(async () => {
  try {
    console.log("⏱ Fetching matches...");
    await fetchMatches();
  } catch (err) {
    console.error("Error fetching matches:", err);
  }
}, 60000); // 60 ثانية

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
