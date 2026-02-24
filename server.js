import express from "express";
import fsSync from "fs";
import fs from "fs/promises";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from 'url';

// ================== تصحيح المسارات ==================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================== استيراد الملفات ==================
import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday, liveStatsCache } from "./fetchMatchToday.js";
import { normalizeLeague } from "./normalizeStandings.js";
import fetchAllMatchesFull from "./matches-today-full.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ================== HTTP Server ==================
const server = http.createServer(app);

// ================== WebSocket ==================
const wss = new WebSocketServer({ server });

// ================== Files ==================
const DATA_FILE = path.join(__dirname, "all_leagues_standings.json");
const MATCH_FILE = path.join(__dirname, "match-today.json");
const MATCH_FULL_FILE = path.join(__dirname, "matches-today-full.json");

// ================== Cache ==================
let standingsCache = {};
let normalizedStandingsCache = {};
let matchesCache = [];
let matchesFullCache = [];
let matchHashCache = new Map();

// ================== متغيرات التحكم بالتحديث ==================
let updatingMatches = false;
let updatingMatchesFull = false;
let updatingLiveScores = false;
let updatingStandings = false;

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

// ================== دالة التحقق من وجود مباريات حية ==================
function hasLiveMatches(matches) {
  if (!matches || !Array.isArray(matches)) return false;
  
  return matches.some(match => {
    const status = match.status?.toLowerCase() || match.Eps?.toLowerCase();
    return status && 
           !['ft', 'finished', 'postp.', 'canc.', 'ns', 'not started'].includes(status) &&
           !status.includes('ft') &&
           !status.includes('finished');
  });
}

// ================== دالة جلب النتائج المباشرة (مؤقتة) ==================
async function fetchLiveScores(matches) {
  // هذه دالة مؤقتة - يجب استبدالها بالدالة الحقيقية من fetchMatchToday
  return matches;
}

// ================== Load from disk ==================
async function loadFromDisk() {
  try {
    // تحميل ملف المباريات العادي
    if (fsSync.existsSync(MATCH_FILE)) {
      matchesCache = JSON.parse(await fs.readFile(MATCH_FILE, "utf8"));
      matchesCache.forEach((l) =>
        l.matches?.forEach((m) => {
          if (m?.liveId || m?.matchLink) {
            matchHashCache.set(m.liveId || m.matchLink, hashObject(m));
          }
        })
      );
      console.log("⚽ Match-Today loaded from disk");
    }

    // تحميل ملف المباريات الكامل
    if (fsSync.existsSync(MATCH_FULL_FILE)) {
      matchesFullCache = JSON.parse(await fs.readFile(MATCH_FULL_FILE, "utf8"));
      console.log(`📊 Matches Full loaded from disk (${matchesFullCache.length} matches)`);
    }

    // تحميل الترتيبات
    if (fsSync.existsSync(DATA_FILE)) {
      standingsCache = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
      for (const league in standingsCache) {
        if (standingsCache[league]) {
          normalizedStandingsCache[league] = normalizeLeague(standingsCache[league]);
        }
      }
      console.log("📊 Standings loaded from disk");
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Load error:`, err.message);
  }
}

// ================== Live Scores Update ==================
async function updateLiveScores() {
  if (updatingLiveScores || !matchesCache || matchesCache.length === 0) return;
  
  updatingLiveScores = true;
  try {
    // جمع كل المباريات
    const allMatches = matchesCache.flatMap(l => l.matches || []);
    
    // التحقق من وجود مباريات حية باستخدام الدالة الجديدة
    const hasLive = hasLiveMatches(allMatches);
    
    if (!hasLive) {
      updatingLiveScores = false;
      return;
    }
    
    let hasChanges = false;
    const updatedLeagues = [];
    
    // تحديث كل دوري على حدة
    for (const league of matchesCache) {
      const updatedMatches = await fetchLiveScores(league.matches || []);
      
      // التحقق من وجود تغييرات
      for (let i = 0; i < updatedMatches.length; i++) {
        const match = updatedMatches[i];
        if (!match) continue;
        
        const key = match.liveId || match.matchLink || match.Eid;
        if (!key) continue;
        
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
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Live scores update error:`, error.message);
  } finally {
    updatingLiveScores = false;
  }
}

// ================== Regular Match Update ==================
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
        const matchMap = new Map(
          (existingLeague.matches || []).map((m) => [m.liveId || m.matchLink || m.Eid, m])
        );
        for (const newMatch of newLeague.matches || []) {
          const key = newMatch.liveId || newMatch.matchLink || newMatch.Eid;
          if (!key) continue;
          
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
        (newLeague.matches || []).forEach((m) => {
          const key = m.liveId || m.matchLink || m.Eid;
          if (key) matchHashCache.set(key, hashObject(m));
        });
      }
    }

    const changed = await writeIfChanged(MATCH_FILE, matchesCache, matchHashCache);
    if (changed) {
      broadcastDebounced("matches_update", matchesCache);
      console.log(`[${new Date().toISOString()}] ✅ Regular matches updated`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Regular matches update error:`, error.message);
  } finally {
    updatingMatches = false;
  }
}

// ================== Full Matches Update ==================
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
  if (updatingStandings) return;
  updatingStandings = true;
  
  try {
    const raw = await fetchAllLeagues();
    if (!raw) return;
    
    const normalized = {};
    for (const league in raw) {
      if (raw[league]) {
        normalized[league] = normalizeLeague(raw[league]);
      }
    }
    
    const changed = await writeIfChanged(DATA_FILE, raw, matchHashCache);
    standingsCache = raw;
    normalizedStandingsCache = normalized;
    
    if (changed) {
      broadcastDebounced("standings_update", normalizedStandingsCache);
      console.log(`[${new Date().toISOString()}] ✅ Standings updated`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Standings update error:`, error.message);
  } finally {
    updatingStandings = false;
  }
}

// ================== Middleware ==================
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60");
  next();
});

// ================== API Routes ==================
app.get("/api/v1/match-today", (req, res) => {
  if (!matchesCache || matchesCache.length === 0)
    return res.status(503).json({ error: "Matches not ready" });
  res.json(matchesCache);
});

app.get("/api/v1/matches-full", (req, res) => {
  if (!matchesFullCache || matchesFullCache.length === 0)
    return res.status(503).json({ error: "Full matches not ready" });
  res.json(matchesFullCache);
});

app.get("/api/v1/match-full/:eid", (req, res) => {
  const eid = req.params.eid;
  if (!matchesFullCache || matchesFullCache.length === 0)
    return res.status(503).json({ error: "Full matches not ready" });
  
  const match = matchesFullCache.find(m => m.Eid == eid);
  if (!match)
    return res.status(404).json({ error: "Match not found" });
  
  res.json(match);
});

app.get("/api/v1/live-scores", (req, res) => {
  if (!matchesCache || matchesCache.length === 0) {
    return res.status(503).json({ error: "Matches not ready" });
  }
  
  // فلترة المباريات الحية فقط
  const liveMatches = matchesCache
    .map(league => ({
      ...league,
      matches: (league.matches || []).filter(m => {
        const status = m.status?.toLowerCase() || m.Eps?.toLowerCase();
        return status && 
               !['ft', 'finished', 'postp.', 'canc.', 'ns', 'not started'].includes(status) &&
               !status.includes('ft');
      })
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
    matchesCount: matchesCache.length,
    matchesFullCount: matchesFullCache.length,
    standingsCount: Object.keys(standingsCache).length
  });
});

// ================== WebSocket ==================
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ 
    type: "init", 
    data: { 
      matches: matchesCache, 
      standings: normalizedStandingsCache,
      matchesFull: matchesFullCache
    } 
  }));
});

// ================== Start Server ==================
server.listen(PORT, async () => {
  await loadFromDisk();
  
  // تشغيل جميع التحديثات الأولية
  await Promise.allSettled([
    updateMatches(), 
    updateStandings(),
    updateMatchesFull()
  ]);
  
  // ================== إعداد المؤقتات ==================
  
  // تحديث المباريات العادي كل 5 دقائق
  setInterval(updateMatches, 5 * 60 * 1000);
  
  // تحديث المباريات الكامل كل 5 دقائق
  setInterval(updateMatchesFull, 5 * 60 * 1000);
  
  // تحديث الترتيبات كل 10 دقائق
  setInterval(updateStandings, 10 * 60 * 1000);
  
  // تحديث النتائج المباشرة كل 30 ثانية
  setInterval(updateLiveScores, 30 * 1000);
  
  console.log(`[${new Date().toISOString()}] 🚀 Server started on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] ⚽ Regular matches update every 5 minutes`);
  console.log(`[${new Date().toISOString()}] 📊 Full matches update every 5 minutes`);
  console.log(`[${new Date().toISOString()}] 🏆 Standings update every 10 minutes`);
  console.log(`[${new Date().toISOString()}] 🔴 Live scores update every 30 seconds`);
});

export default app;