import express from "express";
import fs from "fs";
import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday } from "./fetchMatchToday.js";
import { normalizeLeague } from "./normalizeStandings.js";

const app = express();
const PORT = 3000;

// ملفات البيانات
const DATA_FILE = "./all_leagues_standings.json";
const MATCH_FILE = "./match-today.json";

// ===== Cache في الذاكرة =====
let standingsCache = {};
let matchesCache = {};

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

// ===== دوال fetch منفصلة =====
async function updateMatches() {
  try {
    const todayMatches = await fetchMatchToday();
    fs.writeFileSync(MATCH_FILE, JSON.stringify(todayMatches, null, 2));
    matchesCache = todayMatches;
    console.log("🔄 Match-Today updated");
  } catch (err) {
    console.error("❌ Failed to update matches:", err.message);
  }
}

async function updateStandings() {
  try {
    const allStandings = await fetchAllLeagues();
    fs.writeFileSync(DATA_FILE, JSON.stringify(allStandings, null, 2));
    standingsCache = allStandings;
    console.log("🔄 Standings updated");
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
  // مباريات اليوم أولًا
  updateMatches().then(() => {
    console.log("✅ Match-Today initial fetch done");
  });

  // تصنيفات الدوريات بشكل مستقل
  updateStandings().then(() => {
    console.log("✅ Standings initial fetch done");
  });

  // ===== تحديث دوري حسب الفترات المحددة =====
  setInterval(updateMatches, 10 * 60 * 1000);   // كل 15 دقيقة
  setInterval(updateStandings, 15 * 60 * 1000);  // كل 5 دقائق
});
