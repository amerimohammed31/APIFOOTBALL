require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cron = require("node-cron");
const fetchMatches = require("./fetchMatches");

const app = express();
const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

const Match = require("./models/Match");

app.get("/matches", async (req, res) => {
  const matches = await Match.find({});
  res.json(matches);
});

// تحديث تلقائي كل دقيقة
cron.schedule("* * * * *", async () => {
  console.log("🔄 Fetching latest matches...");
  try {
    await fetchMatches();
  } catch (err) {
    console.error("❌ Error updating matches:", err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});