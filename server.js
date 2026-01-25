// server.js
import express from "express";
import fs from "fs";
import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday } from "./fetchMatchToday.js";
import { normalizeLeague } from "./normalizeStandings.js";

const app = express();
const PORT = 3000;

// ملفات البيانات
const DATA_FILE = "./all_leagues_full_tables.json"; // استخدم الملف الجديد الذي يحتوي على جميع الجداول
const MATCH_FILE = "./match-today.json";

// ===== Cache في الذاكرة =====
let standingsCache = {};
let matchesCache = {};

// ===== Load البيانات من الملفات =====
function loadStandings() {
  if (!fs.existsSync(DATA_FILE)) return {};
  standingsCache = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  console.log("📊 Standings loaded into cache");
}

function loadMatches() {
  if (!fs.existsSync(MATCH_FILE)) return {};
  matchesCache = JSON.parse(fs.readFileSync(MATCH_FILE, "utf-8"));
  console.log("⚽ Match-Today loaded into cache");
}

// ===== Routes =====

// 1️⃣ تصنيفات الدوريات (كل الجداول مع أسماء المجموعات)
app.get("/standings/:league", (req, res) => {
  const league = req.params.league.toLowerCase();
  const raw = standingsCache[league];

  if (!raw) {
    return res.status(404).json({
      error: "League not found",
      supported: Object.keys(standingsCache),
    });
  }

  // normalizeLeague الآن يدعم كل الجداول داخل "tables" بما فيها المجموعات
  const normalized = normalizeLeague(raw);
  res.json(normalized);
});

// 2️⃣ مباريات اليوم
app.get("/match-today", (req, res) => {
  res.json(matchesCache);
});

// ===== Fetch البيانات عند التشغيل =====
(async () => {
  try {
    console.log("🔄 Fetching all leagues...");
    const allStandings = await fetchAllLeagues();
    fs.writeFileSync(DATA_FILE, JSON.stringify(allStandings, null, 2));
    standingsCache = allStandings;
    console.log("✅ All leagues standings fetched and cached");

    console.log("🔄 Fetching matches today...");
    const todayMatches = await fetchMatchToday();
    fs.writeFileSync(MATCH_FILE, JSON.stringify(todayMatches, null, 2));
    matchesCache = todayMatches;
    console.log("✅ Match-Today fetched and cached");

    loadStandings();
    loadMatches();
  } catch (err) {
    console.error("❌ Failed initial fetch:", err.message);
  }
})();

// ===== تحديث البيانات كل 30 دقيقة =====
setInterval(async () => {
  try {
    console.log("🔄 Updating all leagues standings...");
    const allStandings = await fetchAllLeagues();
    fs.writeFileSync(DATA_FILE, JSON.stringify(allStandings, null, 2));
    standingsCache = allStandings;
    console.log("🔄 Standings updated");

    console.log("🔄 Updating matches today...");
    const todayMatches = await fetchMatchToday();
    fs.writeFileSync(MATCH_FILE, JSON.stringify(todayMatches, null, 2));
    matchesCache = todayMatches;
    console.log("🔄 Match-Today updated");
  } catch (err) {
    console.error("❌ Update failed:", err.message);
  }
}, 30 * 60 * 1000); // كل 30 دقيقة

// ===== Start Server =====
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📌 Endpoints:");
  console.log("   → /standings/:league");
  console.log("   → /match-today");
});
