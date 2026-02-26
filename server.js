import express from "express";
import fsSync from "fs";
import fs from "fs/promises";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import { spawn } from "child_process";

import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday, liveStatsCache } from "./fetchMatchToday.js";
import { normalizeLeague } from "./normalizeStandings.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ================== HTTP Server ==================
const server = http.createServer(app);

// ================== WebSocket ==================
const wss = new WebSocketServer({ server });

// ================== Files ==================
const DATA_FILE = "./all_leagues_standings.json";
const MATCH_FILE = "./match-today.json";
const BESOCCER_FILE = "./besoccer-complete-data.json";

// ================== Cache ==================
let standingsCache = {};
let normalizedStandingsCache = {};
let matchesCache = [];
let matchHashCache = new Map();
let besoccerCache = null;

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
    if (fsSync.existsSync(MATCH_FILE)) {
      matchesCache = JSON.parse(await fs.readFile(MATCH_FILE, "utf8"));
      matchesCache.forEach((l) =>
        l.matches.forEach((m) =>
          matchHashCache.set(m.liveId || m.matchLink, hashObject(m))
        )
      );
      console.log("⚽ Match-Today loaded from disk");
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

    if (fsSync.existsSync(BESOCCER_FILE)) {
      besoccerCache = JSON.parse(await fs.readFile(BESOCCER_FILE, "utf8"));
      console.log("⚽ BeSoccer data loaded from disk");
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Load error:`, err.message);
  }
}

// ================== Update Jobs ==================
let updatingMatches = false;
let updatingBesoccer = false;

function hasLiveMatch(data) {
  return data.some((league) =>
    league.matches.some((m) => m.status?.toLowerCase() === "live")
  );
}

// ================== Live Update فقط ==================
async function updateLiveMatchesOnly() {
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
}

// ================== Full Update ==================
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
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Standings update error:`, error.message);
  }
}

// ================== Besoccer Update ==================
async function updateBesoccer() {
  if (updatingBesoccer) return;
  updatingBesoccer = true;
  
  console.log(`[${new Date().toISOString()}] ⚽ بدء تحديث BeSoccer...`);
  
  return new Promise((resolve, reject) => {
    // تشغيل ملف besoccer.js كعملية منفصلة
    const besoccerProcess = spawn("node", ["./besoccer.js"], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let outputData = "";
    let errorData = "";

    // جمع output
    besoccerProcess.stdout.on("data", (data) => {
      const output = data.toString();
      outputData += output;
      console.log(`[BeSoccer] ${output.trim()}`);
    });

    // جمع errors
    besoccerProcess.stderr.on("data", (data) => {
      const error = data.toString();
      errorData += error;
      console.error(`[BeSoccer Error] ${error.trim()}`);
    });

    // عند اكتمال العملية
    besoccerProcess.on("close", async (code) => {
      if (code === 0) {
        try {
          // تحديث الكاش بالبيانات الجديدة
          if (fsSync.existsSync(BESOCCER_FILE)) {
            besoccerCache = JSON.parse(await fs.readFile(BESOCCER_FILE, "utf8"));
          }
          console.log(`[${new Date().toISOString()}] ✅ تحديث BeSoccer اكتمل بنجاح`);
          broadcastDebounced("besoccer_update", { message: "BeSoccer data updated" });
          resolve();
        } catch (err) {
          console.error(`[${new Date().toISOString()}] ❌ خطأ في قراءة ملف BeSoccer:`, err.message);
          reject(err);
        }
      } else {
        console.error(`[${new Date().toISOString()}] ❌ فشل تحديث BeSoccer (code: ${code})`);
        reject(new Error(`BeSoccer process exited with code ${code}`));
      }
      updatingBesoccer = false;
    });

    // timeout للعملية (10 دقائق)
    const timeout = setTimeout(() => {
      besoccerProcess.kill();
      updatingBesoccer = false;
      reject(new Error("BeSoccer update timed out after 10 minutes"));
    }, 10 * 60 * 1000);

    besoccerProcess.on("close", () => clearTimeout(timeout));
  }).catch(err => {
    console.error(`[${new Date().toISOString()}] ❌ خطأ في تحديث BeSoccer:`, err.message);
    updatingBesoccer = false;
  });
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

app.get("/api/v1/standings/:league", (req, res) => {
  const league = req.params.league.toLowerCase();
  if (!normalizedStandingsCache[league])
    return res.status(404).json({
      error: "League not found",
      supportedLeagues: Object.keys(normalizedStandingsCache),
    });
  res.json(normalizedStandingsCache[league]);
});

app.get("/api/v1/besoccer", (req, res) => {
  try {
    if (besoccerCache) {
      res.json(besoccerCache);
    } else if (fsSync.existsSync(BESOCCER_FILE)) {
      const data = JSON.parse(fsSync.readFileSync(BESOCCER_FILE, "utf8"));
      besoccerCache = data;
      res.json(data);
    } else {
      res.status(503).json({ error: "BeSoccer data not ready yet" });
    }
  } catch (err) {
    res.status(500).json({ error: "Error reading BeSoccer data" });
  }
});

app.get("/api/v1/all-standings", (req, res) => {
  if (!normalizedStandingsCache || Object.keys(normalizedStandingsCache).length === 0)
    return res.status(503).json({ error: "Standings not ready" });
  res.json(normalizedStandingsCache);
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    wsClients: wss.clients.size,
    cache: {
      matches: matchesCache?.length || 0,
      standings: Object.keys(normalizedStandingsCache).length,
      besoccer: besoccerCache ? "available" : "not loaded"
    }
  });
});

// ================== WebSocket ==================
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ 
    type: "init", 
    data: { 
      matches: matchesCache, 
      standings: normalizedStandingsCache,
      besoccer: besoccerCache 
    } 
  }));
});

// ================== Start ==================
server.listen(PORT, async () => {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`🚀 Server starting on port ${PORT}`);
  console.log(`${"=".repeat(80)}\n`);
  
  await loadFromDisk();
  
  console.log(`\n${"=".repeat(80)}`);
  console.log("🔄 بدء التحديثات الأولية...");
  console.log(`${"=".repeat(80)}`);
  
  await Promise.allSettled([
    updateMatches(), 
    updateStandings(),
    updateBesoccer()
  ]);
  
  console.log(`\n${"=".repeat(80)}`);
  console.log("✅ التحديثات الأولية اكتملت");
  console.log("⏰ جدولة التحديثات الدورية:");
  console.log("   └─ Live matches: كل 1 دقيقة");
  console.log("   └─ Full matches: كل 5 دقائق");
  console.log("   └─ Standings: كل 10 دقائق");
  console.log("   └─ BeSoccer: كل 5 دقائق");
  console.log(`${"=".repeat(80)}\n`);
  
  setInterval(updateLiveMatchesOnly, 60 * 1000);     // Live كل دقيقة
  setInterval(updateMatches, 5 * 60 * 1000);         // Full Update كل 5 دقائق
  setInterval(updateStandings, 10 * 60 * 1000);      // Standings كل 10 دقائق
  setInterval(updateBesoccer, 5 * 60 * 1000);        // BeSoccer كل 5 دقائق
});

// ================== Graceful Shutdown ==================
process.on('SIGINT', async () => {
  console.log(`\n[${new Date().toISOString()}] 👋 إيقاف السيرفر...`);
  server.close(() => {
    console.log(`[${new Date().toISOString()}] ✅ تم إيقاف السيرفر بنجاح`);
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log(`\n[${new Date().toISOString()}] 👋 إيقاف السيرفر...`);
  server.close(() => {
    console.log(`[${new Date().toISOString()}] ✅ تم إيقاف السيرفر بنجاح`);
    process.exit(0);
  });
});

export default app;