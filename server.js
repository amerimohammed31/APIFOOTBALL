import express from "express";
import fs from "fs";
import mongoose from "mongoose";

const app = express();
const PORT = 3000;

// ملفات البيانات المحلية
const DATA_FILE = "./all_leagues_standings.json";
const MATCH_FILE = "./match-today.json";

// Cache في الذاكرة
let standingsCache = {};
let matchesCache = {};

// MongoDB Models
const { Schema, model } = mongoose;

// كل البيانات ستكون محفوظة كما هي في ملف JSON
const StandingsSchema = new Schema({
  league: String,
  rawData: Object, // تخزين الملف كامل
});
const Standings = model("Standings", StandingsSchema);

const MatchTodaySchema = new Schema({
  rawData: Object, // تخزين الملف كامل
});
const MatchToday = model("MatchToday", MatchTodaySchema);

// MongoDB Connection
const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB connection error:", err.message));

// =======================
// Load البيانات من الملفات
// =======================
function loadFiles() {
  if (fs.existsSync(DATA_FILE)) {
    standingsCache = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    console.log("📊 Standings loaded from file");
  }

  if (fs.existsSync(MATCH_FILE)) {
    matchesCache = JSON.parse(fs.readFileSync(MATCH_FILE, "utf-8"));
    console.log("⚽ Match-Today loaded from file");
  }
}

// =======================
// إرسال البيانات كاملة إلى MongoDB
// =======================
async function sendFilesToMongo() {
  try {
    if (Object.keys(standingsCache).length > 0 && mongoose.connection.readyState === 1) {
      await Standings.deleteMany({});
      const insertData = Object.keys(standingsCache).map(league => ({
        league,
        rawData: standingsCache[league],
      }));
      await Standings.insertMany(insertData);
      console.log("📊 Standings imported to MongoDB (full JSON)");
    }

    if (Object.keys(matchesCache).length > 0 && mongoose.connection.readyState === 1) {
      await MatchToday.deleteMany({});
      await MatchToday.create({ rawData: matchesCache });
      console.log("⚽ Match-Today imported to MongoDB (full JSON)");
    }
  } catch (err) {
    console.error("❌ Failed to send files to MongoDB:", err.message);
  }
}

// =======================
// Routes
// =======================
app.get("/standings", (req, res) => res.json(standingsCache));
app.get("/match-today", (req, res) => res.json(matchesCache));

// =======================
// Start Server
// =======================
loadFiles();

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📌 Endpoints:");
  console.log("   → /standings");
  console.log("   → /match-today");

  // بعد تحميل الملفات، رفعها كما هي إلى MongoDB
  await sendFilesToMongo();
});
