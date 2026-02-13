import express from "express";
import fetch from "node-fetch";
import fsSync from "fs";
import fs from "fs/promises";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday } from "./fetchMatchToday.js";
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

// ================== Cache ==================
let standingsCache = {};
let normalizedStandingsCache = {};
let matchesCache = [];
let matchHashCache = new Map(); // لتجنب الكتابة إذا لم تتغير

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

// Debounce للـ WebSocket لتجنب التكرار السريع
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
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Load error:`, err.message);
  }
}

// ================== Update Jobs ==================
let updatingMatches = false;

function hasLiveMatch(data) {
  return data.some((league) =>
    league.matches.some(
      (m) =>
        m.status?.toLowerCase().includes("live") ||
        m.status?.toLowerCase().includes("playing") ||
        m.minute
    )
  );
}

async function updateMatches() {
  if (updatingMatches) return;
  updatingMatches = true;

  try {
    const newData = await fetchMatchToday();
    if (!Array.isArray(newData) || newData.length === 0) {
      console.log(`[${new Date().toISOString()}] 🟡 Match-Today empty or not ready`);
      updatingMatches = false;
      return;
    }

    // ================= دمج ذكي باستخدام Map =================
    const leagueMap = new Map();
    matchesCache.forEach((l) => leagueMap.set(l.leagueName, l));

    for (const newLeague of newData) {
      const existingLeague = leagueMap.get(newLeague.leagueName);
      if (existingLeague) {
        const matchMap = new Map(
          existingLeague.matches.map((m) => [m.liveId || m.matchLink, m])
        );

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

    if (changed) {
      console.log(`[${new Date().toISOString()}] 🔴 Match-Today updated`);
      broadcastDebounced("matches_update", matchesCache);
    } else {
      console.log(`[${new Date().toISOString()}] 🟢 Match-Today no changes`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Match update failed:`, err.message);
  } finally {
    updatingMatches = false;
  }
}

async function updateStandings() {
  try {
    const raw = await fetchAllLeagues();
    const normalized = {};
    for (const league in raw) normalized[league] = normalizeLeague(raw[league]);

    const changed = await writeIfChanged(DATA_FILE, raw, matchHashCache);
    standingsCache = raw;
    normalizedStandingsCache = normalized;

    if (changed) {
      console.log(`[${new Date().toISOString()}] 📊 Standings updated`);
      broadcastDebounced("standings_update", normalizedStandingsCache);
    } else {
      console.log(`[${new Date().toISOString()}] 📊 Standings no changes`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Standings update failed:`, err.message);
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
  });
});

// ================== WebSocket ==================
wss.on("connection", (ws) => {
  console.log(`[${new Date().toISOString()}] 📱 WebSocket client connected`);

  ws.send(
    JSON.stringify({
      type: "init",
      data: { matches: matchesCache, standings: normalizedStandingsCache },
    })
  );

  ws.on("close", () => console.log(`[${new Date().toISOString()}] ❌ WebSocket client disconnected`));
});

// ================== Start ==================
server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  await loadFromDisk();

  // ================== تشغيل أولي متوازي ==================
  await Promise.all([updateMatches(), updateStandings()]);

  // ================== Auto Updates ==================
  // تحديث المباريات: كل دقيقة أثناء LIVE، كل 5 دقائق إذا لا توجد مباريات LIVE
  setInterval(async () => {
    if (hasLiveMatch(matchesCache)) {
      await updateMatches();
    } else {
      setTimeout(updateMatches, 5 * 60 * 1000);
    }
  }, 60 * 1000);

  // تحديث الترتيب كل 10 دقائق
  setInterval(updateStandings, 10 * 60 * 1000);
});
