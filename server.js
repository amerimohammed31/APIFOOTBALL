import 'dotenv/config';
import express from "express";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== الملفات المحلية =====
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const STANDINGS_FILE = path.join(DATA_DIR, "standings.json");
const MATCHTODAY_FILE = path.join(DATA_DIR, "match-today.json");

// ===== Cache في الذاكرة =====
let standingsCache = {};
let matchesCache = {};

// ===== MongoDB Models =====
const StandingsSchema = new mongoose.Schema({
  league: String,
  tables: Array
}, { timestamps: true });

const MatchTodaySchema = new mongoose.Schema({
  matches: Array
}, { timestamps: true });

const Standings = mongoose.model("standings", StandingsSchema);
const MatchToday = mongoose.model("matchtodays", MatchTodaySchema);

// ===== اتصال MongoDB =====
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB connection error:", err.message));

// ===== Helpers لحفظ البيانات =====
const saveToFile = (filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

const saveStandingsMongo = async (league, tables) => {
  if (mongoose.connection.readyState !== 1) return;
  await Standings.updateOne({ league }, { league, tables }, { upsert: true });
};

const saveMatchTodayMongo = async (matches) => {
  if (mongoose.connection.readyState !== 1) return;
  await MatchToday.deleteMany();
  await MatchToday.create({ matches });
};

// ===== Load البيانات من الملفات =====
if (fs.existsSync(STANDINGS_FILE)) {
  standingsCache = JSON.parse(fs.readFileSync(STANDINGS_FILE, "utf-8"));
  console.log("📊 Standings loaded from file");
}

if (fs.existsSync(MATCHTODAY_FILE)) {
  matchesCache = JSON.parse(fs.readFileSync(MATCHTODAY_FILE, "utf-8"));
  console.log("⚽ Match-Today loaded from file");
}

// ===== Routes =====
app.get("/standings/:league", (req, res) => {
  const league = req.params.league.toLowerCase();
  const tables = standingsCache[league] || [];
  res.json(tables);
});

app.get("/match-today", (req, res) => {
  res.json(matchesCache || []);
});

// ===== Functions لتحديث MongoDB =====
const updateStandings = async () => {
  try {
    if (!fs.existsSync(STANDINGS_FILE)) return;
    const localData = JSON.parse(fs.readFileSync(STANDINGS_FILE, "utf-8"));
    standingsCache = localData;

    const arrayData = Object.keys(localData).map(league => ({
      league,
      tables: localData[league]
    }));

    await Standings.deleteMany();
    await Standings.insertMany(arrayData);

    console.log("🔄 Standings updated in MongoDB");
  } catch (err) {
    console.error("❌ Failed to update standings:", err.message);
  }
};

const updateMatches = async () => {
  try {
    if (!fs.existsSync(MATCHTODAY_FILE)) return;
    const localData = JSON.parse(fs.readFileSync(MATCHTODAY_FILE, "utf-8"));
    matchesCache = localData;

    await MatchToday.deleteMany();
    await MatchToday.create({ matches: localData });

    console.log("🔄 Match-Today updated in MongoDB");
  } catch (err) {
    console.error("❌ Failed to update matches:", err.message);
  }
};

// ===== Start Server =====
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📌 Endpoints:");
  console.log("   → /standings/:league");
  console.log("   → /match-today");

  // تحديث MongoDB عند البداية
  await updateMatches();
  await updateStandings();

  console.log("🎉 Initial sync done");
});
