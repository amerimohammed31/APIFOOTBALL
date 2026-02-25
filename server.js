import express from "express";
import fsSync from "fs";
import fs from "fs/promises";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import util from 'util';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import responseTime from 'response-time';
import cluster from 'cluster';
import os from 'os';
import winston from 'winston';
import Redis from 'ioredis';

const execPromise = util.promisify(exec);

// ================== تصحيح المسارات ==================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================== استيراد الملفات ==================
import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday, liveStatsCache } from "./fetchMatchToday.js";
import { normalizeLeague } from "./normalizeStandings.js";
import fetchAllMatchesFull from "./matches-today-full.js";

// ================== Cluster Mode ==================
const numCPUs = os.cpus().length;
const isPrimary = cluster.isPrimary;

if (isPrimary && process.env.NODE_ENV === 'production') {
  console.log(`🚀 Primary ${process.pid} is running`);
  
  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  
  cluster.on('exit', (worker) => {
    console.log(`⚠️ Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });
  
} else {
  // Workers run the server
  startServer();
}

function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  // ================== HTTP Server ==================
  const server = http.createServer(app);

  // ================== WebSocket ==================
  const wss = new WebSocketServer({ server });

  // ================== Redis Cache ==================
  let redis = null;
  try {
    redis = new Redis({
      host: 'localhost',
      port: 6379,
      retryStrategy: times => Math.min(times * 50, 2000),
      lazyConnect: true
    });
    
    redis.on('error', (err) => {
      console.log('⚠️ Redis not available:', err.message);
      redis = null;
    });
  } catch (err) {
    console.log('⚠️ Redis disabled:', err.message);
    redis = null;
  }

  // ================== Logger ==================
  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.File({ filename: 'error.log', level: 'error' }),
      new winston.transports.File({ filename: 'combined.log' }),
      new winston.transports.Console({ 
        format: winston.format.simple(),
        silent: process.env.NODE_ENV === 'test'
      })
    ]
  });

  // ================== Files ==================
  const DATA_FILE = path.join(__dirname, "all_leagues_standings.json");
  const MATCH_FILE = path.join(__dirname, "match-today.json");
  const MATCH_FULL_FILE = path.join(__dirname, "matches-today-full.json");
  const BESOCCER_FILE = path.join(__dirname, "besoccer-complete-data.json");

  // ================== Cache ==================
  let standingsCache = null;
  let normalizedStandingsCache = null;
  let matchesCache = null;
  let matchesFullCache = null;
  let besoccerCache = null;
  const matchHashCache = new Map();

  // ================== Stats ==================
  const stats = {
    requests: 0,
    avgResponseTime: 0,
    errors: 0,
    startTime: Date.now()
  };

  // ================== متغيرات التحكم بالتحديث ==================
  let updatingMatches = false;
  let updatingMatchesFull = false;
  let updatingLiveScores = false;
  let updatingStandings = false;
  let updatingBesoccer = false;
  let liveInterval = null;

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

  // ================== Redis Cache Helper ==================
  async function getCachedOrFetch(key, fetchFn, ttl = 300) {
    if (!redis) return await fetchFn();
    
    try {
      const cached = await redis.get(key);
      if (cached) return JSON.parse(cached);
      
      const data = await fetchFn();
      await redis.setex(key, ttl, JSON.stringify(data));
      return data;
    } catch (err) {
      logger.warn(`Redis error for ${key}:`, err.message);
      return await fetchFn();
    }
  }

  // ================== Lazy Loading ==================
  async function getMatchesCache() {
    if (!matchesCache && fsSync.existsSync(MATCH_FILE)) {
      matchesCache = JSON.parse(await fs.readFile(MATCH_FILE, "utf8"));
      matchesCache.forEach((l) =>
        l.matches?.forEach((m) => {
          if (m?.liveId || m?.matchLink) {
            matchHashCache.set(m.liveId || m.matchLink, hashObject(m));
          }
        })
      );
      logger.info("⚽ Match-Today loaded from disk");
    }
    return matchesCache || [];
  }

  async function getMatchesFullCache() {
    if (!matchesFullCache && fsSync.existsSync(MATCH_FULL_FILE)) {
      matchesFullCache = JSON.parse(await fs.readFile(MATCH_FULL_FILE, "utf8"));
      logger.info(`📊 Matches Full loaded from disk (${matchesFullCache.length} matches)`);
    }
    return matchesFullCache || [];
  }

  async function getBesoccerCache() {
    if (!besoccerCache && fsSync.existsSync(BESOCCER_FILE)) {
      besoccerCache = JSON.parse(await fs.readFile(BESOCCER_FILE, "utf8"));
      logger.info(`🏆 BeSoccer data loaded from disk (${besoccerCache?.metadata?.totalMatches || 0} matches)`);
    }
    return besoccerCache;
  }

  async function getStandingsCache() {
    if (!standingsCache && fsSync.existsSync(DATA_FILE)) {
      standingsCache = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
      normalizedStandingsCache = {};
      for (const league in standingsCache) {
        if (standingsCache[league]) {
          normalizedStandingsCache[league] = normalizeLeague(standingsCache[league]);
        }
      }
      logger.info("📊 Standings loaded from disk");
    }
    return { raw: standingsCache || {}, normalized: normalizedStandingsCache || {} };
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

  // ================== تشغيل سكريبت BeSoccer ==================
  async function runBesoccerScript() {
    logger.info("🚀 تشغيل سكريبت BeSoccer...");
    
    const scriptPath = path.join(__dirname, "besoccer.js");
    
    if (!fsSync.existsSync(scriptPath)) {
      throw new Error(`ملف BeSoccer غير موجود: ${scriptPath}`);
    }
    
    try {
      const { stdout, stderr } = await execPromise(`node ${scriptPath}`, {
        cwd: __dirname,
        maxBuffer: 10 * 1024 * 1024
      });
      
      if (stdout) {
        stdout.split('\n').forEach(line => {
          if (line.trim()) logger.info(`[BeSoccer] ${line.trim()}`);
        });
      }
      
      if (stderr) {
        stderr.split('\n').forEach(line => {
          if (line.trim()) logger.error(`[BeSoccer Error] ${line.trim()}`);
        });
      }
      
      if (fsSync.existsSync(BESOCCER_FILE)) {
        const stats = fsSync.statSync(BESOCCER_FILE);
        logger.info(`✅ BeSoccer completed (${(stats.size / 1024).toFixed(2)} KB)`);
      }
      
      return { success: true };
      
    } catch (error) {
      logger.error("❌ BeSoccer failed:", error.message);
      throw error;
    }
  }

  // ================== تحديث بيانات BeSoccer ==================
  async function updateBesoccerData() {
    if (updatingBesoccer) return;
    
    updatingBesoccer = true;
    const startTime = Date.now();
    
    try {
      logger.info("🏆 Starting BeSoccer update...");
      await runBesoccerScript();
      
      if (fsSync.existsSync(BESOCCER_FILE)) {
        const newData = JSON.parse(await fs.readFile(BESOCCER_FILE, "utf8"));
        
        if (redis) {
          await redis.setex('besoccer:all', 300, JSON.stringify(newData));
        }
        
        besoccerCache = newData;
        broadcastToSubscribers('besoccer_update', newData);
        
        logger.info(`✅ BeSoccer updated in ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
      }
      
    } catch (error) {
      logger.error("❌ BeSoccer update error:", error.message);
    } finally {
      updatingBesoccer = false;
    }
  }

  // ================== Live Scores Update (محسّن) ==================
  async function updateLiveScores() {
    if (updatingLiveScores) return;
    
    const matches = await getMatchesCache();
    const allMatches = matches.flatMap(l => l.matches || []);
    const liveMatches = allMatches.filter(m => {
      const status = m.status?.toLowerCase() || m.Eps?.toLowerCase();
      return status && !['ft', 'finished', 'postp.', 'canc.', 'ns'].includes(status);
    });
    
    // إذا ما في مباريات حية، زود الفترة
    if (liveMatches.length === 0) {
      if (liveInterval) {
        clearInterval(liveInterval);
        liveInterval = setInterval(updateLiveScores, 5 * 60 * 1000);
        
        // تحقق كل 30 دقيقة إذا رجعت مباريات حية
        setTimeout(() => {
          clearInterval(liveInterval);
          liveInterval = setInterval(updateLiveScores, 30 * 1000);
        }, 30 * 60 * 1000);
      }
      return;
    }
    
    updatingLiveScores = true;
    try {
      let hasChanges = false;
      const updatedLeagues = [];
      
      for (const league of matches) {
        const updatedMatches = await fetchLiveScores(league.matches || []);
        
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
        
        updatedLeagues.push({ ...league, matches: updatedMatches });
      }
      
      if (hasChanges) {
        matchesCache = updatedLeagues;
        await atomicWrite(MATCH_FILE, matchesCache);
        
        if (redis) {
          await redis.del('matches:today');
        }
        
        broadcastToSubscribers('matches_update', matchesCache);
        logger.info("⚡ Live scores updated");
      }
      
    } catch (error) {
      logger.error("❌ Live scores update error:", error.message);
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

      const currentMatches = await getMatchesCache();
      const leagueMap = new Map();
      currentMatches.forEach((l) => leagueMap.set(l.leagueName, l));

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
          currentMatches.push(newLeague);
          leagueMap.set(newLeague.leagueName, newLeague);
          (newLeague.matches || []).forEach((m) => {
            const key = m.liveId || m.matchLink || m.Eid;
            if (key) matchHashCache.set(key, hashObject(m));
          });
        }
      }

      matchesCache = currentMatches;
      const changed = await writeIfChanged(MATCH_FILE, currentMatches);
      
      if (changed) {
        if (redis) await redis.del('matches:today');
        broadcastToSubscribers('matches_update', currentMatches);
        logger.info("✅ Regular matches updated");
      }
      
    } catch (error) {
      logger.error("❌ Regular matches update error:", error.message);
    } finally {
      updatingMatches = false;
    }
  }

  // ================== Full Matches Update ==================
  async function updateMatchesFull() {
    if (updatingMatchesFull) return;
    updatingMatchesFull = true;
    
    try {
      logger.info("🚀 Fetching full matches data...");
      await fetchAllMatchesFull();
      
      if (fsSync.existsSync(MATCH_FULL_FILE)) {
        const newData = JSON.parse(await fs.readFile(MATCH_FULL_FILE, "utf8"));
        const changed = await writeIfChanged(MATCH_FULL_FILE, newData);
        
        if (changed) {
          matchesFullCache = newData;
          if (redis) await redis.del('matches:full');
          broadcastToSubscribers('matches_full_update', newData);
          logger.info(`✅ Full matches updated (${newData.length} matches)`);
        }
      }
    } catch (error) {
      logger.error("❌ Full matches update error:", error.message);
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
      
      const changed = await writeIfChanged(DATA_FILE, raw);
      
      if (changed) {
        standingsCache = raw;
        normalizedStandingsCache = normalized;
        
        if (redis) {
          await redis.del('standings:all');
          for (const league in normalized) {
            await redis.setex(`standings:${league}`, 600, JSON.stringify(normalized[league]));
          }
        }
        
        broadcastToSubscribers('standings_update', normalized);
        logger.info("✅ Standings updated");
      }
      
    } catch (error) {
      logger.error("❌ Standings update error:", error.message);
    } finally {
      updatingStandings = false;
    }
  }

  // ================== WebSocket مع اشتراكات ==================
  wss.on("connection", (ws) => {
    ws.subscriptions = new Set(['init']); // اشتراك افتراضي في init
    
    ws.send(JSON.stringify({ 
      type: "init", 
      data: { 
        matches: matchesCache || [],
        standings: normalizedStandingsCache || {},
        matchesFull: matchesFullCache || [],
        besoccer: besoccerCache
      } 
    }));
    
    ws.on('message', (message) => {
      try {
        const { type, subscribe, unsubscribe } = JSON.parse(message);
        
        if (subscribe) {
          ws.subscriptions.add(subscribe);
        }
        if (unsubscribe) {
          ws.subscriptions.delete(unsubscribe);
        }
      } catch (err) {
        // تجاهل الأخطاء في parsing
      }
    });
    
    ws.on('close', () => {
      // تنظيف
    });
  });

  function broadcastToSubscribers(type, data) {
    const payload = JSON.stringify({ type, data });
    wss.clients.forEach((client) => {
      if (client.readyState === 1 && client.subscriptions?.has(type)) {
        client.send(payload);
      }
    });
  }

  // ================== Middleware ==================
  app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
      if (req.headers['x-no-compression']) return false;
      return compression.filter(req, res);
    }
  }));

  app.use(responseTime((req, res, time) => {
    stats.avgResponseTime = (stats.avgResponseTime * stats.requests + time) / (stats.requests + 1);
    stats.requests++;
    
    if (time > 1000) {
      logger.warn(`Slow request: ${req.method} ${req.url} (${time.toFixed(2)}ms)`);
    }
  }));

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Too many requests" },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health' || req.path === '/health/detailed'
  });

  app.use('/api/', limiter);
  
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=60");
    next();
  });

  // ================== API Routes (محسّنة مع Redis) ==================
  app.get("/api/v1/match-today", async (req, res) => {
    try {
      const data = await getCachedOrFetch('matches:today', getMatchesCache, 60);
      if (!data || data.length === 0) {
        return res.status(503).json({ error: "Matches not ready" });
      }
      res.json(data);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/matches-full", async (req, res) => {
    try {
      const data = await getCachedOrFetch('matches:full', getMatchesFullCache, 300);
      if (!data || data.length === 0) {
        return res.status(503).json({ error: "Full matches not ready" });
      }
      res.json(data);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/match-full/:eid", async (req, res) => {
    try {
      const eid = req.params.eid;
      const data = await getMatchesFullCache();
      const match = data.find(m => m.Eid == eid);
      
      if (!match) {
        return res.status(404).json({ error: "Match not found" });
      }
      
      res.json(match);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/besoccer", async (req, res) => {
    try {
      const data = await getCachedOrFetch('besoccer:all', getBesoccerCache, 60);
      if (!data) {
        return res.status(503).json({ error: "BeSoccer data not ready" });
      }
      res.json(data);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/besoccer/competitions", async (req, res) => {
    try {
      const data = await getBesoccerCache();
      if (!data) {
        return res.status(503).json({ error: "BeSoccer data not ready" });
      }
      res.json(data.competitions || []);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/besoccer/matches", async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const start = (page - 1) * limit;
      
      const data = await getBesoccerCache();
      if (!data) {
        return res.status(503).json({ error: "BeSoccer data not ready" });
      }
      
      const allMatches = data.competitions?.flatMap(c => c.matches || []) || [];
      const paginated = allMatches.slice(start, start + limit);
      
      res.json({
        page,
        limit,
        total: allMatches.length,
        pages: Math.ceil(allMatches.length / limit),
        data: paginated
      });
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/besoccer/competition/:name", async (req, res) => {
    try {
      const competitionName = req.params.name.toLowerCase();
      const data = await getBesoccerCache();
      
      if (!data) {
        return res.status(503).json({ error: "BeSoccer data not ready" });
      }
      
      const competition = data.competitions?.find(c => 
        c.name.toLowerCase().includes(competitionName)
      );
      
      if (!competition) {
        return res.status(404).json({ error: "Competition not found" });
      }
      
      res.json(competition);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/besoccer/match/:matchId", async (req, res) => {
    try {
      const matchId = req.params.matchId;
      const data = await getBesoccerCache();
      
      if (!data) {
        return res.status(503).json({ error: "BeSoccer data not ready" });
      }
      
      let foundMatch = null;
      for (const comp of data.competitions || []) {
        const match = comp.matches?.find(m => m.id === matchId || m.matchId === matchId);
        if (match) {
          foundMatch = match;
          break;
        }
      }
      
      if (!foundMatch) {
        return res.status(404).json({ error: "Match not found" });
      }
      
      res.json(foundMatch);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/besoccer/live", async (req, res) => {
    try {
      const data = await getBesoccerCache();
      if (!data) {
        return res.status(503).json({ error: "BeSoccer data not ready" });
      }
      
      const liveMatches = data.competitions?.map(comp => ({
        ...comp,
        matches: comp.matches?.filter(m => m.isLive) || []
      })).filter(comp => comp.matches.length > 0) || [];
      
      res.json(liveMatches);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/besoccer/statistics", async (req, res) => {
    try {
      const data = await getBesoccerCache();
      if (!data) {
        return res.status(503).json({ error: "BeSoccer data not ready" });
      }
      
      res.json({
        metadata: data.metadata,
        statistics: data.statistics
      });
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/live-scores", async (req, res) => {
    try {
      const matches = await getMatchesCache();
      if (!matches || matches.length === 0) {
        return res.status(503).json({ error: "Matches not ready" });
      }
      
      const liveMatches = matches
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
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/standings/:league", async (req, res) => {
    try {
      const league = req.params.league.toLowerCase();
      
      // Try Redis first
      if (redis) {
        const cached = await redis.get(`standings:${league}`);
        if (cached) {
          return res.json(JSON.parse(cached));
        }
      }
      
      const { normalized } = await getStandingsCache();
      
      if (!normalized[league]) {
        return res.status(404).json({
          error: "League not found",
          supportedLeagues: Object.keys(normalized),
        });
      }
      
      // Cache in Redis
      if (redis) {
        await redis.setex(`standings:${league}`, 600, JSON.stringify(normalized[league]));
      }
      
      res.json(normalized[league]);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      worker: process.pid,
      uptime: process.uptime(),
      wsClients: wss.clients.size,
      stats: {
        requests: stats.requests,
        avgResponseTime: stats.avgResponseTime.toFixed(2) + 'ms',
        errors: stats.errors,
        uptime: Math.floor((Date.now() - stats.startTime) / 1000) + 's'
      }
    });
  });

  app.get("/health/detailed", async (req, res) => {
    const matches = await getMatchesCache();
    const matchesFull = await getMatchesFullCache();
    const besoccer = await getBesoccerCache();
    const { raw } = await getStandingsCache();
    
    res.json({
      status: "ok",
      worker: process.pid,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cache: {
        matches: matches ? matches.length : 0,
        matchesFull: matchesFull ? matchesFull.length : 0,
        besoccer: besoccer?.metadata?.totalMatches || 0,
        standings: raw ? Object.keys(raw).length : 0
      },
      redis: redis ? 'connected' : 'disabled',
      files: {
        matchFile: fsSync.existsSync(MATCH_FILE) ? fsSync.statSync(MATCH_FILE).size : 0,
        matchFullFile: fsSync.existsSync(MATCH_FULL_FILE) ? fsSync.statSync(MATCH_FULL_FILE).size : 0,
        besoccerFile: fsSync.existsSync(BESOCCER_FILE) ? fsSync.statSync(BESOCCER_FILE).size : 0,
        standingsFile: fsSync.existsSync(DATA_FILE) ? fsSync.statSync(DATA_FILE).size : 0
      },
      wsClients: wss.clients.size,
      updates: {
        liveScores: updatingLiveScores ? 'running' : 'idle',
        matches: updatingMatches ? 'running' : 'idle',
        matchesFull: updatingMatchesFull ? 'running' : 'idle',
        besoccer: updatingBesoccer ? 'running' : 'idle',
        standings: updatingStandings ? 'running' : 'idle'
      }
    });
  });

  // ================== Start Server ==================
  async function initializeServer() {
    // Load initial data
    await Promise.allSettled([
      getMatchesCache(),
      getMatchesFullCache(),
      getBesoccerCache(),
      getStandingsCache()
    ]);
    
    // Schedule updates with staggered timing
    const schedule = [
      { fn: updateLiveScores, interval: 30 * 1000, delay: 0 },
      { fn: updateMatches, interval: 5 * 60 * 1000, delay: 5 * 1000 },
      { fn: updateMatchesFull, interval: 5 * 60 * 1000, delay: 10 * 1000 },
      { fn: updateBesoccerData, interval: 5 * 60 * 1000, delay: 15 * 1000 },
      { fn: updateStandings, interval: 10 * 60 * 1000, delay: 20 * 1000 }
    ];
    
    schedule.forEach(({ fn, interval, delay }) => {
      setTimeout(() => {
        fn();
        if (fn === updateLiveScores) {
          liveInterval = setInterval(fn, interval);
        } else {
          setInterval(fn, interval);
        }
      }, delay);
    });
    
    logger.info(`🚀 Worker ${process.pid} started on port ${PORT}`);
  }

  server.listen(PORT, initializeServer);
}