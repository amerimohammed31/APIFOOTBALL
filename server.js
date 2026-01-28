import express from "express";
import fs from "fs";
import fetch from "node-fetch";

import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday } from "./fetchMatchToday.js";
import { normalizeLeague } from "./normalizeStandings.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ملفات البيانات =====
const DATA_FILE = "./all_leagues_standings.json";
const MATCH_FILE = "./match-today.json";

// ===== Cache في الذاكرة =====
let standingsCache = {};
let matchesCache = {};

// ===== دوال لمقارنة البيانات قبل الكتابة =====
function writeIfChanged(filePath, newData) {
  const jsonData = JSON.stringify(newData, null, 2);
  if (fs.existsSync(filePath)) {
    const currentData = fs.readFileSync(filePath, "utf8");
    if (currentData === jsonData) return false; // لا حاجة للكتابة
  }
  fs.writeFileSync(filePath, jsonData);
  return true;
}

// ===== Load البيانات عند البداية =====
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

// ===== تحديث البيانات =====
async function updateMatches() {
  try {
    const todayMatches = await fetchMatchToday();
    const changed = writeIfChanged(MATCH_FILE, todayMatches);
    matchesCache = todayMatches;
    if (changed) console.log("🔄 Match-Today updated (new changes)");
    else console.log("🔄 Match-Today fetched (no changes)");
  } catch (err) {
    console.error("❌ Failed to update matches:", err.message);
  }
}

async function updateStandings() {
  try {
    const allStandings = await fetchAllLeagues();
    const changed = writeIfChanged(DATA_FILE, allStandings);
    standingsCache = allStandings;
    if (changed) console.log("🔄 Standings updated (new changes)");
    else console.log("🔄 Standings fetched (no changes)");
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

  // أول جلب عند تشغيل السيرفر
  updateMatches().then(() => console.log("✅ Match-Today initial fetch done"));
  updateStandings().then(() => console.log("✅ Standings initial fetch done"));

  // تحديث دوري تلقائي كل فترة (طالما السيرفر نشط)
  setInterval(updateMatches, 10 * 60 * 1000);   // كل 10 دقائق
  setInterval(updateStandings, 11 * 60 * 1000); // كل 15 دقيقة

  // ===== Self-ping للحفاظ على السيرفر نشط =====
  setInterval(() => {
    fetch(`http://localhost:${PORT}/standings/ping`)
      .then(() => console.log("💤 Self-ping sent to keep server awake"))
      .catch(() => {});
  }, 5 * 60 * 1000); // كل 5 دقائق
});

// ===== Endpoint مخصص للـ Self-ping =====
app.get("/standings/ping", (req, res) => {
  res.send("pong");
});
