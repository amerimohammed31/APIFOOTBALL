import express from "express";
import fsSync from "fs";
import fs from "fs/promises";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday, liveStatsCache } from "./fetchMatchToday.js";
import { normalizeLeague } from "./normalizeStandings.js";

// ================== تصحيح الاستيراد ==================

// ================== IMPORT الملف الجديد ==================
import fetchAllMatchesFull from "./matches-today-full.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ================== HTTP Server ==================
const server = http.createServer(app);

// ================== WebSocket ==================
const wss = new WebSocketServer({ server });

// ================== Files ==================
const DATA_FILE = "./all_leagues_standings.json";
const MATCH_FILE = "./match-today.json";
const MATCH_FULL_FILE = "./matches-today-full.json"; // ملف المباريات الكامل الجديد

// ================== Cache ==================
let standingsCache = {};
let normalizedStandingsCache = {};
let matchesCache = [];
let matchesFullCache = []; // Cache جديد للمباريات الكاملة
let matchHashCache = new Map();

// ================== Helpers ==================
function hashObject(obj) {
  return crypto.createHash("md5").update(JSON.stringify(obj)).digest("hex");
}

async function atomicWrite(filePath, data) {
  const tempFile = filePath + ".tmp";
  await fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tempFile, filePath);
}

async function writeIfChanged(filePath, newData, hashMap = null) {
  const newHash = hashObject(newData);
  if (hashMap && hashMap.get(filePath) === newHash) return false;

  if (fsSync.existsSync(filePath)) {
    const current = await fs.readFile(filePath, "utf8");
    if (current === JSON.stringify(newData, null, 2)) return false;
  }

  await atomicWrite(filePath, newData);
  if (hashMap) hashMap.set(filePath, newHash);
  return true;
}

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

let broadcastTimeout = null;
function broadcastDebounced(type, data, delay = 500) {
  if (broadcastTimeout) clearTimeout(broadcastTimeout);
  broadcastTimeout = setTimeout(() => broadcast(type, data), delay);
}

// ================== Load from disk ==================
async function loadFromDisk() {
  try {
    // تحميل ملف المباريات العادي
    if (fsSync.existsSync(MATCH_FILE)) {
      matchesCache = JSON.parse(await fs.readFile(MATCH_FILE, "utf8"));
      matchesCache.forEach((l) =>
        l.matches.forEach((m) =>
          matchHashCache.set(m.liveId || m.matchLink, hashObject(m))
        )
      );
      console.log("⚽ Match-Today loaded from disk");
    }

    // ================== تحميل ملف المباريات الكامل الجديد ==================
    if (fsSync.existsSync(MATCH_FULL_FILE)) {
      matchesFullCache = JSON.parse(await fs.readFile(MATCH_FULL_FILE, "utf8"));
      console.log(`📊 Matches Full loaded from disk (${matchesFullCache.length} matches)`);
    }

    if (fsSync.existsSync(DATA_FILE)) {
      standingsCache = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
      for (const league in standingsCache) {
        normalizedStandingsCache[league] = normalizeLeague(
          standingsCache[league]
        );
      }
      console.log("📊 Standings loaded from disk");
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Load error:`, err.message);
  }
}

// ================== Update Jobs ==================
let updatingMatches = false;
let updatingMatchesFull = false; // متغير جديد للتحديث الكامل
let updatingLiveScores = false; // متغير للتحديث المباشر

function hasLiveMatch(data) {
  return data.some((league) =>
    league.matches.some((m) => m.status?.toLowerCase() === "live")
  );
}

// ================== Live Update فقط ==================
async function updateLiveMatchesOnly() {
  if (updatingLiveScores) return;
  updatingLiveScores = true;
  
  try {
    const liveLeagues = matchesCache
      .map(l => ({
        ...l,
        matches: l.matches.filter(m => m.isLive)
      }))
      .filter(l => l.matches.length > 0);

    if (liveLeagues.length === 0) return;

    for (const league of liveLeagues) {
      for (const match of league.matches) {
        const newStats = await fetchMatchToday();
        // تحديث stats مباشرة
        match.stats = newStats.find(l => l.leagueName === league.leagueName)
                             ?.matches.find(m => m.liveId === match.liveId)?.stats || {};
        liveStatsCache.set(match.liveId, match.stats);
        matchHashCache.set(match.liveId, hashObject(match));
      }
    }
    broadcastDebounced("matches_update", matchesCache);
  } finally {
    updatingLiveScores = false;
  }
}

// ================== Live Scores Update (من liveScoreFetcher) ==================
async function updateLiveScores() {
  if (updatingLiveScores || !matchesCache || matchesCache.length === 0) return;
  
  updatingLiveScores = true;
  try {
    // التحقق من وجود مباريات حية
    const allMatches = matchesCache.flatMap(l => l.matches);
    const hasLive = hasLiveMatches(allMatches);
    
    if (!hasLive) return;
    
    let hasChanges = false;
    const updatedLeagues = [];
    
    // تحديث كل دوري على حدة
    for (const league of matchesCache) {
      const updatedMatches = await fetchLiveScores(league.matches);
      
      // التحقق من وجود تغييرات
      for (let i = 0; i < updatedMatches.length; i++) {
        const match = updatedMatches[i];
        const key = match.liveId || match.matchLink;
        const oldHash = matchHashCache.get(key);
        const newHash = hashObject(match);
        
        if (oldHash !== newHash) {
          hasChanges = true;
          matchHashCache.set(key, newHash);
        }
      }
      
      updatedLeagues.push({
        ...league,
        matches: updatedMatches
      });
    }
    
    if (hasChanges) {
      matchesCache = updatedLeagues;
      
      // حفظ التغييرات في الملف
      await atomicWrite(MATCH_FILE, matchesCache);
      
      // بث التحديثات
      broadcastDebounced("matches_update", matchesCache);
      
      console.log(`[${new Date().toISOString()}] ⚡ Live scores updated`);
    }
    
    // تنظيف الكاش القديم
    cleanLiveCache();
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Live scores update error:`, error.message);
  } finally {
    updatingLiveScores = false;
  }
}

// ================== Full Match Update (الملف العادي) ==================
async function updateMatches() {
  if (updatingMatches) return;
  updatingMatches = true;
  try {
    const newData = await fetchMatchToday();
    if (!Array.isArray(newData) || newData.length === 0) return;

    // دمج ذكي
    const leagueMap = new Map();
    matchesCache.forEach((l) => leagueMap.set(l.leagueName, l));

    for (const newLeague of newData) {
      const existingLeague = leagueMap.get(newLeague.leagueName);
      if (existingLeague) {
        const matchMap = new Map(existingLeague.matches.map((m) => [m.liveId || m.matchLink, m]));
        for (const newMatch of newLeague.matches) {
          const key = newMatch.liveId || newMatch.matchLink;
          const newHash = hashObject(newMatch);
          if (matchMap.has(key)) {
            if (matchHashCache.get(key) !== newHash) {
              Object.assign(matchMap.get(key), newMatch);
              matchHashCache.set(key, newHash);
            }
          } else {
            existingLeague.matches.push(newMatch);
            matchMap.set(key, newMatch);
            matchHashCache.set(key, newHash);
          }
        }
      } else {
        matchesCache.push(newLeague);
        leagueMap.set(newLeague.leagueName, newLeague);
        newLeague.matches.forEach((m) =>
          matchHashCache.set(m.liveId || m.matchLink, hashObject(m))
        );
      }
    }

    const changed = await writeIfChanged(MATCH_FILE, matchesCache, matchHashCache);
    if (changed) broadcastDebounced("matches_update", matchesCache);
  } finally {
    updatingMatches = false;
  }
}

// ================== FULL MATCHES UPDATE (الملف الكامل الجديد) ==================
async function updateMatchesFull() {
  if (updatingMatchesFull) return;
  updatingMatchesFull = true;
  
  try {
    console.log(`[${new Date().toISOString()}] 🚀 Fetching full matches data...`);
    
    // تشغيل ملف جلب المباريات الكامل
    await fetchAllMatchesFull();
    
    // قراءة الملف المحدث
    if (fsSync.existsSync(MATCH_FULL_FILE)) {
      const newData = JSON.parse(await fs.readFile(MATCH_FULL_FILE, "utf8"));
      
      // التحقق من وجود تغييرات
      const changed = await writeIfChanged(MATCH_FULL_FILE, newData);
      
      if (changed) {
        matchesFullCache = newData;
        console.log(`[${new Date().toISOString()}] ✅ Full matches updated (${matchesFullCache.length} matches)`);
        
        // بث التحديثات عبر WebSocket
        broadcastDebounced("matches_full_update", matchesFullCache);
      }
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Full matches update error:`, error.message);
  } finally {
    updatingMatchesFull = false;
  }
}

// ================== Standings Update ==================
async function updateStandings() {
  try {
    const raw = await fetchAllLeagues();
    const normalized = {};
    for (const league in raw) normalized[league] = normalizeLeague(raw[league]);
    const changed = await writeIfChanged(DATA_FILE, raw, matchHashCache);
    standingsCache = raw;
    normalizedStandingsCache = normalized;
    if (changed) broadcastDebounced("standings_update", normalizedStandingsCache);
  } catch {}
}

// ================== Middleware ==================
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60");
  next();
});

// ================== API ==================
app.get("/api/v1/match-today", (req, res) => {
  if (!matchesCache || matchesCache.length === 0)
    return res.status(503).json({ error: "Matches not ready" });
  res.json(matchesCache);
});

// ================== API جديد للمباريات الكاملة ==================
app.get("/api/v1/matches-full", (req, res) => {
  if (!matchesFullCache || matchesFullCache.length === 0)
    return res.status(503).json({ error: "Full matches not ready" });
  res.json(matchesFullCache);
});

// ================== API لمباراة محددة بالكامل ==================
app.get("/api/v1/match-full/:eid", (req, res) => {
  const eid = req.params.eid;
  if (!matchesFullCache || matchesFullCache.length === 0)
    return res.status(503).json({ error: "Full matches not ready" });
  
  const match = matchesFullCache.find(m => m.Eid == eid);
  if (!match)
    return res.status(404).json({ error: "Match not found" });
  
  res.json(match);
});

// ================== API للنتائج المباشرة ==================
app.get("/api/v1/live-scores", (req, res) => {
  if (!matchesCache || matchesCache.length === 0) {
    return res.status(503).json({ error: "Matches not ready" });
  }
  
  // فلترة المباريات الحية فقط
  const liveMatches = matchesCache
    .map(league => ({
      ...league,
      matches: league.matches.filter(m => 
        m.isLive === true || m.status?.toLowerCase() === 'live'
      )
    }))
    .filter(league => league.matches.length > 0);
  
  res.json(liveMatches);
});

app.get("/api/v1/standings/:league", (req, res) => {
  const league = req.params.league.toLowerCase();
  if (!normalizedStandingsCache[league])
    return res.status(404).json({
      error: "League not found",
      supportedLeagues: Object.keys(normalizedStandingsCache),
    });
  res.json(normalizedStandingsCache[league]);
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    wsClients: wss.clients.size,
    matchesFullCount: matchesFullCache.length,
  });
});

// ================== WebSocket ==================
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ 
    type: "init", 
    data: { 
      matches: matchesCache, 
      standings: normalizedStandingsCache,
      matchesFull: matchesFullCache // إضافة المباريات الكاملة للتهيئة
    } 
  }));
});

// ================== Start ==================
server.listen(PORT, async () => {
  await loadFromDisk();
  
  // تشغيل جميع التحديثات الأولية
  await Promise.all([
    updateMatches(), 
    updateStandings(),
    updateMatchesFull() // تشغيل التحديث الكامل لأول مرة
  ]);
  
  // ================== إعداد المؤقتات ==================
  
  // تحديث المباريات العادي كل 5 دقائق
  setInterval(updateMatches, 5 * 60 * 1000);
  
  // ================== تحديث المباريات الكامل كل 5 دقائق ==================
  setInterval(updateMatchesFull, 5 * 60 * 1000);
  
  // تحديث الترتيبات كل 10 دقائق
  setInterval(updateStandings, 10 * 60 * 1000);
  
  // تحديث المباريات الحية كل 60 ثانية (باستخدام liveScoreFetcher)
  setInterval(updateLiveScores, 60 * 1000);
  
  // تحديث المباريات الحية القديم كل دقيقة (اختياري - يمكن إزالته)
  // setInterval(updateLiveMatchesOnly, 60 * 1000);
  
  console.log(`[${new Date().toISOString()}] 🚀 Server started on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] ⚽ Regular matches update every 5 minutes`);
  console.log(`[${new Date().toISOString()}] 📊 Full matches update every 5 minutes`);
  console.log(`[${new Date().toISOString()}] 🏆 Standings update every 10 minutes`);
  console.log(`[${new Date().toISOString()}] 🔴 Live scores update every 30 seconds`);
});