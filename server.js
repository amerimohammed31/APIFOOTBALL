import express from "express";
import fs from "fs";
import mongoose from "mongoose";
import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday } from "./fetchMatchToday.js";

const app = express();
const PORT = 3000;

// ملفات البيانات المحلية
const DATA_FILE = "./all_leagues_standings.json";
const MATCH_FILE = "./match-today.json";

// Cache في الذاكرة
let standingsCache = {};
let matchesCache = [];

// =======================
// MongoDB Model لتخزين الملفات كما هي
// =======================
const { Schema, model } = mongoose;

const fileSchema = new Schema({
  filename: String,  // اسم الملف
  content: Object,   // محتوى الملف كامل
});

const FileData = model("FileData", fileSchema);

// =======================
// MongoDB Connection
// =======================
const mongoURI = process.env.MONGO_URI;

mongoose.connect(mongoURI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log("✅ MongoDB Connected!"))
  .catch(err => console.error("❌ MongoDB connection error:", err.message));

// =======================
// Load البيانات من الملفات محلياً
// =======================
function loadMatches() {
  if (fs.existsSync(MATCH_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(MATCH_FILE, "utf-8"));
      matchesCache = Array.isArray(data) ? data : [];
      console.log("⚽ Match-Today loaded from file");
    } catch (err) {
      console.error("❌ Failed to parse Match-Today file:", err.message);
    }
  }
}

function loadStandings() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      standingsCache = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      console.log("📊 Standings loaded from file");
    } catch (err) {
      console.error("❌ Failed to parse Standings file:", err.message);
    }
  }
}

// =======================
// إرسال الملفات كما هي إلى MongoDB
// =======================
async function storeFilesToMongo() {
  try {
    if (fs.existsSync(DATA_FILE) && mongoose.connection.readyState === 1) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      await FileData.deleteOne({ filename: "all_leagues_standings" });
      await FileData.create({
        filename: "all_leagues_standings",
        content: data
      });
      console.log("📊 Standings JSON stored 100% in MongoDB");
    }

    if (fs.existsSync(MATCH_FILE) && mongoose.connection.readyState === 1) {
      const data = JSON.parse(fs.readFileSync(MATCH_FILE, "utf-8"));
      await FileData.deleteOne({ filename: "match-today" });
      await FileData.create({
        filename: "match-today",
        content: data
      });
      console.log("⚽ Match-Today JSON stored 100% in MongoDB");
    }
  } catch (err) {
    console.error("❌ Failed to store JSON files in MongoDB:", err.message);
  }
}

// =======================
// تحديث البيانات تلقائياً
// =======================
async function updateMatches() {
  try {
    const todayMatches = await fetchMatchToday();
    if (!Array.isArray(todayMatches)) return;

    fs.writeFileSync(MATCH_FILE, JSON.stringify(todayMatches, null, 2));
    matchesCache = todayMatches;
    console.log("🔄 Match-Today updated locally");

    await storeFilesToMongo(); // تحديث MongoDB
  } catch (err) {
    console.error("❌ Failed to update matches:", err.message);
  }
}

async function updateStandings() {
  try {
    const allStandings = await fetchAllLeagues();
    fs.writeFileSync(DATA_FILE, JSON.stringify(allStandings, null, 2));
    standingsCache = allStandings;
    console.log("🔄 Standings updated locally");

    await storeFilesToMongo(); // تحديث MongoDB
  } catch (err) {
    console.error("❌ Failed to update standings:", err.message);
  }
}

// =======================
// Routes
// =======================
app.get("/standings/:league", (req, res) => {
  const league = req.params.league.toLowerCase();
  const raw = standingsCache[league];

  if (!raw) return res.status(404).json({ error: "League not found" });

  res.json(raw); // مباشرة بدون تعديل
});

app.get("/match-today", (req, res) => {
  res.json(matchesCache); // مباشرة بدون تعديل
});

// =======================
// Start Server
// =======================
loadMatches();
loadStandings();

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // إرسال الملفات كاملة إلى MongoDB عند التشغيل
  await storeFilesToMongo();

  // تحديث البيانات بشكل دوري
  setInterval(updateMatches, 10 * 60 * 1000);
  setInterval(updateStandings, 15 * 60 * 1000);
});
