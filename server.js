import express from "express";
import fetch from "node-fetch";
import fsSync from "fs";
import fs from "fs/promises";
import http from "http";
import { WebSocketServer } from "ws";

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

// ================== Helpers ==================
async function writeIfChanged(filePath, newData) {
  const jsonData = JSON.stringify(newData, null, 2);

  if (fsSync.existsSync(filePath)) {
    const current = await fs.readFile(filePath, "utf8");
    if (current === jsonData) return false;
  }

  await fs.writeFile(filePath, jsonData, "utf8");
  return true;
}

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
}

// ================== Load from disk ==================
async function loadFromDisk() {
  try {
    if (fsSync.existsSync(MATCH_FILE)) {
      matchesCache = JSON.parse(await fs.readFile(MATCH_FILE, "utf8"));
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
    console.error("❌ Load error:", err.message);
  }
}

// ================== Update Jobs ==================
async function updateMatches() {
  try {
    const newData = await fetchMatchToday();

    if (!Array.isArray(newData) || newData.length === 0) {
      console.log("🟡 Match-Today empty or not ready");
      return;
    }

    // ===== Smart merge =====
    if (matchesCache.length > 0) {
      for (const newLeague of newData) {
        const existingLeague = matchesCache.find(
          (l) => l.leagueName === newLeague.leagueName
        );

        if (existingLeague) {
          for (const newMatch of newLeague.matches) {
            const existingMatch = existingLeague.matches.find(
              (m) =>
                (m.liveId && m.liveId === newMatch.liveId) ||
                m.matchLink === newMatch.matchLink
            );

            if (existingMatch) {
              Object.assign(existingMatch, newMatch);
            } else {
              existingLeague.matches.push(newMatch);
            }
          }
        } else {
          matchesCache.push(newLeague);
        }
      }
    } else {
      matchesCache = newData;
    }

    const changed = await writeIfChanged(MATCH_FILE, matchesCache);

    if (changed) {
      console.log("🔴 Match-Today updated");
      broadcast("matches_update", matchesCache);
    } else {
      console.log("🟢 Match-Today no changes");
    }
  } catch (err) {
    console.error("❌ Match update failed:", err.message);
  }
}

async function updateStandings() {
  try {
    const raw = await fetchAllLeagues();
    const normalized = {};

    for (const league in raw) {
      normalized[league] = normalizeLeague(raw[league]);
    }

    const changed = await writeIfChanged(DATA_FILE, raw);

    standingsCache = raw;
    normalizedStandingsCache = normalized;

    if (changed) {
      console.log("📊 Standings updated");
      broadcast("standings_update", normalizedStandingsCache);
    } else {
      console.log("📊 Standings no changes");
    }
  } catch (err) {
    console.error("❌ Standings update failed:", err.message);
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
  if (!matchesCache || matchesCache.length === 0) {
    return res.status(503).json({ error: "Matches not ready" });
  }
  res.json(matchesCache);
});

app.get("/api/v1/standings/:league", (req, res) => {
  const league = req.params.league.toLowerCase();

  if (!normalizedStandingsCache[league]) {
    return res.status(404).json({
      error: "League not found",
      supportedLeagues: Object.keys(normalizedStandingsCache),
    });
  }

  res.json(normalizedStandingsCache[league]);
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    wsClients: wss.clients.size,
  });
});

app.get("/ping", (req, res) => {
  res.send("pong");
});

// ================== WebSocket ==================
wss.on("connection", (ws) => {
  console.log("📱 WebSocket client connected");

  ws.send(
    JSON.stringify({
      type: "init",
      data: {
        matches: matchesCache,
        standings: normalizedStandingsCache,
      },
    })
  );

  ws.on("close", () => {
    console.log("❌ WebSocket client disconnected");
  });
});

// ================== Start ==================
server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  await loadFromDisk();
  await updateMatches();
  await updateStandings();

  setInterval(updateMatches, 5 * 60 * 1000);
  setInterval(updateStandings, 10 * 60 * 1000);

  if (process.env.SELF_URL) {
    setInterval(() => {
      fetch(process.env.SELF_URL).catch(() => {});
    }, 5 * 60 * 1000);
  }
});
