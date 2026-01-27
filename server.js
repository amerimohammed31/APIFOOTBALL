import express from "express";
import fs from "fs";
import mongoose from "mongoose";
import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday } from "./fetchMatchToday.js";
import { normalizeLeague } from "./normalizeStandings.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ملفات البيانات المحلية =====
const DATA_FILE = "./all_leagues_standings.json";
const MATCH_FILE = "./match-today.json";

// ===== Cache في الذاكرة =====
let standingsCache = {};
let matchesCache = {};

// ===== MongoDB Models =====
const { Schema, model } = mongoose;

const standingsSchema = new Schema({
  league: String,
  data: Object,
});
const Standings = model("Standings", standingsSchema);

const matchSchema = new Schema({
  date: Date,
  homeTeam: String,
  awayTeam: String,
  score: String,
  raw: Object,
});
const MatchToday = model("MatchToday", matchSchema);

// ===== MongoDB Connection =====
if (!process.env.MONGO_URI) {
  console.error("❌ Please define MONGO_URI in .env");
  process.exit(1);
}

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log("✅ MongoDB Connected to LiveScore!"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// ===== Routes =====
app.get("/standings/:league", (req, res) => {
  const league = req.params.league.toLowerCase();
  const raw = standingsCache[league];

  if (!raw) {
    return res.status(404).json({
      error: "League not found",
      supported: Object.keys(standingsCache),
    });
  }

  res.json(normalizeLeague(raw));
});

app.get("/match-today", (req, res) => {
  res.json(matchesCache);
});

// ===== Load البيانات من الملفات عند البداية =====
function loadMatches() {
  if (fs.existsSync(MATCH_FILE)) {
    matchesCache = JSON.parse(fs.readFileSync(MATCH_FILE, "utf-8"));
    console.log("⚽ Match-Today loaded from file");
  }
}

function loadStandings() {
  if (fs.existsSync(DATA_FILE)) {
    standingsCache = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    console.log("📊 Standings loaded from file");
  }
}

// ===== Update Functions =====
async function updateMatches() {
  try {
    // قراءة البيانات من الملف المحلي بدل API خارجي
    let todayMatches = matchesCache;
    if (fs.existsSync(MATCH_FILE)) {
      todayMatches = JSON.parse(fs.readFileSync(MATCH_FILE, "utf-8"));
    }

    // ===== حفظ محلي =====
    fs.writeFileSync(MATCH_FILE, JSON.stringify(todayMatches, null, 2));
    matchesCache = todayMatches;
    console.log("🔄 Match-Today updated locally");

    // ===== حفظ في MongoDB =====
    await MatchToday.deleteMany({});
    await MatchToday.insertMany(todayMatches.map(match => ({
      date: new Date(match.date),
      homeTeam: match.home,
      awayTeam: match.away,
      score: match.score,
      raw: match
    })));
    console.log("🔄 Match-Today updated in MongoDB");
  } catch (err) {
    console.error("❌ Failed to update matches:", err.message);
  }
}

async function updateStandings() {
  try {
    // قراءة البيانات من الملف المحلي بدل API خارجي
    let allStandings = standingsCache;
    if (fs.existsSync(DATA_FILE)) {
      allStandings = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    }

    // ===== حفظ محلي =====
    fs.writeFileSync(DATA_FILE, JSON.stringify(allStandings, null, 2));
    standingsCache = allStandings;
    console.log("🔄 Standings updated locally");

    // ===== حفظ في MongoDB =====
    await Standings.deleteMany({});
    const standingsArray = Object.keys(allStandings).map(league => ({
      league,
      data: allStandings[league]
    }));
    await Standings.insertMany(standingsArray);
    console.log("🔄 Standings updated in MongoDB");
  } catch (err) {
    console.error("❌ Failed to update standings:", err.message);
  }
}

// ===== Load البيانات عند البداية =====
loadMatches();
loadStandings();

// ===== Start Server =====
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📌 Endpoints:");
  console.log("   → /standings/:league");
  console.log("   → /match-today");

  // تحديث MongoDB عند البداية
  updateMatches().then(() => console.log("✅ Match-Today initial sync done"));
  updateStandings().then(() => console.log("✅ Standings initial sync done"));

  // تحديث دوري حسب الفترات المحددة
  setInterval(updateMatches, 10 * 60 * 1000);   // كل 10 دقائق
  setInterval(updateStandings, 15 * 60 * 1000); // كل 15 دقيقة
});
