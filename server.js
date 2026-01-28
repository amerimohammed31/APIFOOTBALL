import express from "express";
import fs from "fs";
import fetch from "node-fetch";

import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday } from "./fetchMatchToday.js";
import { normalizeLeague } from "./normalizeStandings.js";

const app = express();
const PORT = process.env.PORT || 3000; // Render يعطي PORT ديناميكي

// ===== ملفات البيانات =====
const DATA_FILE = "./all_leagues_standings.json";
const MATCH_FILE = "./match-today.json";

// ===== Cache في الذاكرة =====
let standingsCache = {};
let matchesCache = {};

// ===== دالة رفع الملفات إلى GitHub =====
async function uploadToGithub(localFile, githubFile) {
  try {
    const content = fs.readFileSync(localFile, "utf8");
    const encoded = Buffer.from(content).toString("base64");

    const url = `https://api.github.com/repos/${process.env.GITHUB_USERNAME}/${process.env.GITHUB_REPO}/contents/${githubFile}`;

    // التحقق إذا الملف موجود للحصول على SHA
    let sha = null;
    const check = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      },
    });

    if (check.ok) {
      const json = await check.json();
      sha = json.sha;
    }

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `update ${githubFile}`,
        content: encoded,
        sha,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("❌ GitHub upload failed:", text);
    } else {
      console.log(`☁️ ${githubFile} uploaded to GitHub`);
    }
  } catch (err) {
    console.error("❌ Upload failed:", err.message);
  }
}

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

// ===== دوال fetch منفصلة مع رفع GitHub =====
async function updateMatches() {
  try {
    const todayMatches = await fetchMatchToday();
    fs.writeFileSync(MATCH_FILE, JSON.stringify(todayMatches, null, 2));
    matchesCache = todayMatches;
    console.log("🔄 Match-Today updated");

    // رفع إلى GitHub
    await uploadToGithub(MATCH_FILE, "match-today.json");
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

    // رفع إلى GitHub
    await uploadToGithub(DATA_FILE, "all_leagues_standings.json");
  } catch (err) {
    console.error("❌ Failed to update standings:", err.message);
  }
}

// ===== Load البيانات من الملفات عند البداية =====
loadMatches();
loadStandings();

// ===== Start Server =====
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📌 Endpoints:");
  console.log("   → /standings/:league");
  console.log("   → /match-today");

  // أول جلب
  updateMatches().then(() => console.log("✅ Match-Today initial fetch done"));
  updateStandings().then(() => console.log("✅ Standings initial fetch done"));

  // تحديث دوري تلقائي
  setInterval(updateMatches, 10 * 60 * 1000);    // كل 10 دقائق
  setInterval(updateStandings, 10 * 60 * 1000); // كل 15 دقيقة
});
