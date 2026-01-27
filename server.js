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

// Cache في الذاكرة
let standingsCache = {};
let matchesCache = [];

// MongoDB Models
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

// MongoDB Connection
const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log("✅ MongoDB Connected to LiveScore!"))
  .catch(err => console.error("❌ MongoDB connection error:", err.message));

// =======================
// Routes
// =======================
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

// =======================
// Load البيانات من الملفات
// =======================
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

// =======================
// إرسال الملفات إلى MongoDB
// =======================
async function fillMongoFromFiles() {
  try {
    // ارسال Standings
    if (Object.keys(standingsCache).length > 0 && mongoose.connection.readyState === 1) {
      await Standings.deleteMany({});
      const standingsArray = Object.keys(standingsCache).map(league => ({
        league,
        data: standingsCache[league]
      }));
      await Standings.insertMany(standingsArray);
      console.log("📊 Standings imported to MongoDB from local files");
    }

    // ارسال Matches
    if (matchesCache.length > 0 && mongoose.connection.readyState === 1) {
      await MatchToday.deleteMany({});
      await MatchToday.insertMany(matchesCache.map(match => ({
        date: new Date(match.date),
        homeTeam: match.home,
        awayTeam: match.away,
        score: match.score,
        raw: match
      })));
      console.log("⚽ Match-Today imported to MongoDB from local files");
    }
  } catch (err) {
    console.error("❌ Failed to import data to MongoDB:", err.message);
  }
}

// =======================
// Update Functions
// =======================
async function updateMatches() {
  try {
    const todayMatches = await fetchMatchToday();
    fs.writeFileSync(MATCH_FILE, JSON.stringify(todayMatches, null, 2));
    matchesCache = todayMatches;
    console.log("🔄 Match-Today updated locally");

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
    fs.writeFileSync(DATA_FILE, JSON.stringify(allStandings, null, 2));
    standingsCache = allStandings;
    console.log("🔄 Standings updated locally");

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

// =======================
// Start Server
// =======================
loadMatches();
loadStandings();

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📌 Endpoints:");
  console.log("   → /standings/:league");
  console.log("   → /match-today");

  // بعد التأكد من تحميل كل البيانات من الملفات، أرسلها إلى MongoDB
  await fillMongoFromFiles();

  // تحديث البيانات بشكل دوري
  setInterval(updateMatches, 10 * 60 * 1000);
  setInterval(updateStandings, 15 * 60 * 1000);
});
