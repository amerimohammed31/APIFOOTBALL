import express from "express";
import fs from "fs";
import mongoose from "mongoose";
import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday } from "./fetchMatchToday.js";
import { normalizeLeague } from "./normalizeStandings.js";

const app = express();
const PORT = 3000;

// ملفات البيانات المحلية
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
const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI, {
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
    const todayMatches = await fetchMatchToday();

    // ===== حفظ محلي كما هو =====
    fs.writeFileSync(MATCH_FILE, JSON.stringify(todayMatches, null, 2));
    matchesCache = todayMatches;
    console.log("🔄 Match-Today updated locally");

    // ===== حفظ نسخة في MongoDB =====
    if (mongoose.connection.readyState === 1) {
      await MatchToday.deleteMany({});
      await MatchToday.insertMany(todayMatches.map(match => ({
        date: new Date(match.date),
        homeTeam: match.home,
        awayTeam: match.away,
        score: match.score,
        raw: match
      })));
      console.log("🔄 Match-Today updated in MongoDB");
    }
  } catch (err) {
    console.error("❌ Failed to update matches:", err.message);
  }
}

async function updateStandings() {
  try {
    const allStandings = await fetchAllLeagues();

    // ===== حفظ محلي كما هو =====
    fs.writeFileSync(DATA_FILE, JSON.stringify(allStandings, null, 2));
    standingsCache = allStandings;
    console.log("🔄 Standings updated locally");

    // ===== حفظ نسخة في MongoDB =====
    if (mongoose.connection.readyState === 1) {
      await Standings.deleteMany({});
      const standingsArray = Object.keys(allStandings).map(league => ({
        league,
        data: allStandings[league]
      }));
      await Standings.insertMany(standingsArray);
      console.log("🔄 Standings updated in MongoDB");
    }
  } catch (err) {
    console.error("❌ Failed to update standings:", err.message);
  }
}

// ===== Load البيانات من الملفات عند البداية =====
loadMatches();
loadStandings();

// ===== Start Server فورًا =====
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📌 Endpoints:");
  console.log("   → /standings/:league");
  console.log("   → /match-today");

  // ===== Fetch البيانات في الخلفية بشكل غير متزامن =====
  updateMatches().then(() => console.log("✅ Match-Today initial fetch done"));
  updateStandings().then(() => console.log("✅ Standings initial fetch done"));

  // ===== تحديث دوري حسب الفترات المحددة =====
  setInterval(updateMatches, 10 * 60 * 1000);   // كل 10 دقائق
  setInterval(updateStandings, 15 * 60 * 1000); // كل 15 دقيقة
});
