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

const execPromise = util.promisify(exec);

// ================== تصحيح المسارات ==================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================== استيراد الملفات ==================
import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday, liveStatsCache } from "./fetchMatchToday.js";
import { normalizeLeague } from "./normalizeStandings.js";

// ================== التحقق من بيئة التشغيل ==================
const isProduction = process.env.NODE_ENV === 'production';
const isRender = process.env.RENDER === 'true';

console.log(`🚀 بيئة التشغيل: ${isProduction ? 'إنتاج' : 'تطوير'} ${isRender ? '(Render)' : ''}`);

function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  // ================== HTTP Server ==================
  const server = http.createServer(app);

  // ================== WebSocket ==================
  const wss = new WebSocketServer({ server });

  // ================== Files ==================
  const DATA_FILE = path.join(__dirname, "all_leagues_standings.json");
  const MATCH_FILE = path.join(__dirname, "match-today.json");
  const BESOCCER_FILE = path.join(__dirname, "besoccer-complete-data.json");

  // ================== Cache ==================
  let standingsCache = null;
  let normalizedStandingsCache = null;
  let matchesCache = null;
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
  let updatingLiveScores = false;
  let updatingStandings = false;
  let updatingBesoccer = false;
  let liveInterval = null;
  let besoccerInterval = null;

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

  // ================== Lazy Loading ==================
  async function getMatchesCache() {
    if (!matchesCache && fsSync.existsSync(MATCH_FILE)) {
      const data = JSON.parse(await fs.readFile(MATCH_FILE, "utf8"));
      matchesCache = data.map(league => ({
        leagueName: league.leagueName,
        leagueId: league.leagueId,
        country: league.country,
        matches: (league.matches || []).map(m => ({
          Eid: m.Eid,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          status: m.status,
          time: m.time,
          score: m.score,
          liveId: m.liveId,
          matchLink: m.matchLink
        }))
      }));
      
      console.log(`⚽ Match-Today loaded (${matchesCache.length} leagues)`);
    }
    return matchesCache || [];
  }

  async function getBesoccerCache() {
    if (!besoccerCache && fsSync.existsSync(BESOCCER_FILE)) {
      try {
        const data = JSON.parse(await fs.readFile(BESOCCER_FILE, "utf8"));
        besoccerCache = data;
        console.log(`🏆 BeSoccer loaded (${data?.metadata?.totalMatches || 0} matches, ${(fsSync.statSync(BESOCCER_FILE).size / 1024).toFixed(2)} KB)`);
      } catch (err) {
        console.error("❌ خطأ في قراءة BeSoccer:", err.message);
        besoccerCache = { competitions: [], metadata: { totalMatches: 0 } };
      }
    }
    return besoccerCache || { competitions: [], metadata: { totalMatches: 0 } };
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
      console.log(`📊 Standings loaded (${Object.keys(standingsCache).length} leagues)`);
    }
    return { raw: standingsCache || {}, normalized: normalizedStandingsCache || {} };
  }

  // ================== تنظيف الذاكرة الدورية ==================
  function cleanupMemory() {
    if (global.gc) {
      global.gc();
      console.log('🧹 Manual garbage collection performed');
    }
  }

  setInterval(cleanupMemory, 60 * 60 * 1000);

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

  // ================== تشغيل سكريبت BeSoccer ==================
  async function runBesoccerScript() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🏃 تشغيل BeSoccer - ${new Date().toLocaleTimeString('ar-EG')}`);
    console.log(`${'='.repeat(50)}`);
    
    const scriptPath = path.join(__dirname, "besoccer.js");
    const outputPath = BESOCCER_FILE;
    
    if (!fsSync.existsSync(scriptPath)) {
      throw new Error(`ملف BeSoccer غير موجود: ${scriptPath}`);
    }
    
    try {
      // محاولة直接用 import
      console.log("📥 محاولة 1: استيراد الوحدة مباشرة...");
      
      // مسح الكاش
      const modulePath = `file://${scriptPath}?update=${Date.now()}`;
      const besoccerModule = await import(modulePath);
      
      if (typeof besoccerModule.default === 'function') {
        console.log("🔄 تشغيل الدالة الرئيسية...");
        const result = await besoccerModule.default();
        
        // انتظار ثانية للتأكد من كتابة الملف
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (fsSync.existsSync(outputPath)) {
          const stats = fsSync.statSync(outputPath);
          if (stats.size > 1024) { // أكثر من 1 كيلوبايت
            console.log(`✅ نجاح! حجم الملف: ${(stats.size / 1024).toFixed(2)} KB`);
            
            // تحديث الكاش
            const fileContent = await fs.readFile(outputPath, "utf8");
            besoccerCache = JSON.parse(fileContent);
            
            return { success: true, method: 'import', size: stats.size };
          }
        }
      }
      
      throw new Error("فشلت المحاولة الأولى");
      
    } catch (importError) {
      console.log(`⚠️ فشلت المحاولة الأولى: ${importError.message}`);
      console.log("🔄 محاولة 2: استخدام child_process...");
      
      try {
        // حذف الملف القديم للتأكد من إنشاء جديد
        if (fsSync.existsSync(outputPath)) {
          await fs.unlink(outputPath);
          console.log("🗑️ تم حذف الملف القديم");
        }
        
        // تشغيل السكريبت
        const { stdout, stderr } = await execPromise(`node "${scriptPath}"`, {
          cwd: __dirname,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 5 * 60 * 1000,
          env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' }
        });
        
        // طباعة المخرجات للتصحيح
        if (stdout) {
          const lines = stdout.split('\n').filter(l => l.trim());
          lines.slice(-5).forEach(line => console.log(`   ${line}`));
        }
        
        // انتظار ثانيتين للتأكد
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (fsSync.existsSync(outputPath)) {
          const stats = fsSync.statSync(outputPath);
          
          if (stats.size > 1024) {
            console.log(`✅ نجاح! حجم الملف: ${(stats.size / 1024).toFixed(2)} KB`);
            
            // تحديث الكاش
            const fileContent = await fs.readFile(outputPath, "utf8");
            besoccerCache = JSON.parse(fileContent);
            
            return { success: true, method: 'child_process', size: stats.size };
          } else {
            throw new Error(`الملف صغير جداً: ${stats.size} بايت`);
          }
        } else {
          throw new Error("لم يتم إنشاء الملف");
        }
        
      } catch (execError) {
        console.error("❌ فشلت المحاولة الثانية:", execError.message);
        
        // محاولة أخيرة: إنشاء ملف تجريبي
        console.log("🔄 محاولة 3: إنشاء ملف تجريبي...");
        
        const dummyData = {
          metadata: {
            timestamp: new Date().toISOString(),
            totalMatches: 0,
            message: "بيانات تجريبية - فشل التحديث الحقيقي"
          },
          competitions: [],
          statistics: {
            byStatus: { scheduled: 0, live: 0, finished: 0, postponed: 0, other: 0 },
            byCountry: {}
          }
        };
        
        await fs.writeFile(outputPath, JSON.stringify(dummyData, null, 2), "utf8");
        besoccerCache = dummyData;
        
        console.log("⚠️ تم إنشاء ملف تجريبي مؤقت");
        return { success: false, method: 'fallback' };
      }
    }
  }

  // ================== تحديث بيانات BeSoccer ==================
  async function updateBesoccerData() {
    if (updatingBesoccer) {
      console.log("⏳ تحديث BeSoccer قيد التشغيل بالفعل...");
      return;
    }
    
    updatingBesoccer = true;
    const startTime = Date.now();
    
    try {
      const memUsage = process.memoryUsage();
      const usedMemMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      
      console.log(`📊 الذاكرة المستخدمة: ${usedMemMB}MB`);
      
      if (isRender && usedMemMB > 400) {
        console.log(`⚠️ ذاكرة عالية (${usedMemMB}MB) - تأجيل تحديث BeSoccer`);
        return;
      }
      
      const result = await runBesoccerScript();
      
      if (result.success) {
        console.log(`✅ BeSoccer تحديث في ${((Date.now() - startTime) / 1000).toFixed(1)} ثانية عبر ${result.method}`);
        
        // إرسال التحديث عبر WebSocket
        if (besoccerCache) {
          broadcastToSubscribers('besoccer_update', besoccerCache);
        }
      } else {
        console.log(`⚠️ BeSoccer تحديث جزئي في ${((Date.now() - startTime) / 1000).toFixed(1)} ثانية`);
      }
      
    } catch (error) {
      console.error("❌ خطأ في تحديث BeSoccer:", error.message);
    } finally {
      updatingBesoccer = false;
    }
  }

  // ================== Live Scores Update ==================
  async function updateLiveScores() {
    if (updatingLiveScores) return;
    
    const matches = await getMatchesCache();
    const allMatches = matches.flatMap(l => l.matches || []);
    const liveMatches = allMatches.filter(m => {
      const status = m.status?.toLowerCase() || m.Eps?.toLowerCase();
      return status && !['ft', 'finished', 'postp.', 'canc.', 'ns'].includes(status);
    });
    
    if (liveMatches.length === 0) {
      if (liveInterval) {
        clearInterval(liveInterval);
        liveInterval = setInterval(updateLiveScores, 5 * 60 * 1000);
        
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
        const updatedMatches = league.matches || [];
        
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
        broadcastToSubscribers('matches_update', matchesCache);
        console.log("⚡ Live scores updated");
      }
      
    } catch (error) {
      console.error("❌ Live scores update error:", error.message);
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

      matchesCache = newData;
      const changed = await writeIfChanged(MATCH_FILE, newData);
      
      if (changed) {
        broadcastToSubscribers('matches_update', newData);
        console.log("✅ Regular matches updated");
      }
      
    } catch (error) {
      console.error("❌ Regular matches update error:", error.message);
    } finally {
      updatingMatches = false;
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
        broadcastToSubscribers('standings_update', normalized);
        console.log("✅ Standings updated");
      }
      
    } catch (error) {
      console.error("❌ Standings update error:", error.message);
    } finally {
      updatingStandings = false;
    }
  }

  // ================== WebSocket مع اشتراكات ==================
  wss.on("connection", async (ws) => {
    ws.subscriptions = new Set(['init']);
    
    ws.send(JSON.stringify({ 
      type: "init", 
      data: { 
        matches: await getMatchesCache(),
        standings: (await getStandingsCache()).normalized,
        besoccer: await getBesoccerCache()
      } 
    }));
    
    ws.on('message', (message) => {
      try {
        const { type, subscribe, unsubscribe } = JSON.parse(message);
        if (subscribe) ws.subscriptions.add(subscribe);
        if (unsubscribe) ws.subscriptions.delete(unsubscribe);
      } catch (err) {}
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
  app.use(compression({ level: 6, threshold: 1024 }));

  app.use(responseTime((req, res, time) => {
    stats.avgResponseTime = (stats.avgResponseTime * stats.requests + time) / (stats.requests + 1);
    stats.requests++;
    
    if (time > 2000) {
      console.warn(`⚠️ Slow request: ${req.method} ${req.url} (${time.toFixed(2)}ms)`);
    }
  }));

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isRender ? 50 : 100,
    message: { error: "Too many requests" },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health' || req.path === '/health/detailed'
  });

  app.use('/api/', limiter);
  
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=30");
    next();
  });

  // ================== API Routes ==================
  app.get("/api/v1/match-today", async (req, res) => {
    try {
      const data = await getMatchesCache();
      if (!data || data.length === 0) {
        return res.status(503).json({ error: "Matches not ready" });
      }
      res.json(data);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/besoccer", async (req, res) => {
    try {
      const data = await getBesoccerCache();
      if (!data || !data.competitions) {
        return res.status(503).json({ error: "BeSoccer data not ready" });
      }
      res.json(data);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/besoccer/match/:matchId", async (req, res) => {
    try {
      const data = await getBesoccerCache();
      if (!data || !data.competitions) {
        return res.status(503).json({ error: "BeSoccer data not ready" });
      }
      
      const matchId = req.params.matchId;
      let foundMatch = null;
      
      for (const comp of data.competitions || []) {
        for (const match of comp.matches || []) {
          if (match.id === matchId || match.matchId === matchId) {
            foundMatch = match;
            break;
          }
        }
        if (foundMatch) break;
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

  app.get("/api/v1/besoccer/competitions", async (req, res) => {
    try {
      const data = await getBesoccerCache();
      if (!data || !data.competitions) return res.status(503).json({ error: "BeSoccer data not ready" });
      res.json(data.competitions || []);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/v1/besoccer/matches", async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 20, 50);
      const start = (page - 1) * limit;
      
      const data = await getBesoccerCache();
      if (!data || !data.competitions) return res.status(503).json({ error: "BeSoccer data not ready" });
      
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

  app.get("/api/v1/besoccer/live", async (req, res) => {
    try {
      const data = await getBesoccerCache();
      if (!data || !data.competitions) return res.status(503).json({ error: "BeSoccer data not ready" });
      
      const liveMatches = [];
      for (const comp of data.competitions || []) {
        const live = comp.matches?.filter(m => m.isLive) || [];
        if (live.length > 0) {
          liveMatches.push({
            competition: comp.name,
            country: comp.country,
            matches: live
          });
        }
      }
      
      res.json(liveMatches);
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
                   !['ft', 'finished', 'postp.', 'canc.', 'ns'].includes(status) &&
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
      const { normalized } = await getStandingsCache();
      
      if (!normalized[league]) {
        return res.status(404).json({
          error: "League not found",
          supportedLeagues: Object.keys(normalized),
        });
      }
      
      res.json(normalized[league]);
    } catch (err) {
      stats.errors++;
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/health", (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
      status: "ok",
      worker: process.pid,
      uptime: process.uptime(),
      wsClients: wss.clients.size,
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB'
      },
      stats: {
        requests: stats.requests,
        avgResponseTime: stats.avgResponseTime.toFixed(2) + 'ms',
        errors: stats.errors
      }
    });
  });

  app.get("/health/detailed", async (req, res) => {
    const memUsage = process.memoryUsage();
    const matches = await getMatchesCache();
    const besoccer = await getBesoccerCache();
    const { raw } = await getStandingsCache();
    
    res.json({
      status: "ok",
      worker: process.pid,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
        external: Math.round(memUsage.external / 1024 / 1024) + 'MB'
      },
      cache: {
        matches: matches ? matches.length : 0,
        besoccer: besoccer?.metadata?.totalMatches || 0,
        standings: raw ? Object.keys(raw).length : 0
      },
      files: {
        matchFile: fsSync.existsSync(MATCH_FILE) ? fsSync.statSync(MATCH_FILE).size : 0,
        besoccerFile: fsSync.existsSync(BESOCCER_FILE) ? fsSync.statSync(BESOCCER_FILE).size : 0,
        standingsFile: fsSync.existsSync(DATA_FILE) ? fsSync.statSync(DATA_FILE).size : 0
      },
      wsClients: wss.clients.size,
      updates: {
        liveScores: updatingLiveScores ? 'running' : 'idle',
        matches: updatingMatches ? 'running' : 'idle',
        besoccer: updatingBesoccer ? 'running' : 'idle',
        standings: updatingStandings ? 'running' : 'idle',
        nextBesoccerUpdate: besoccerInterval ? 
          new Date(Date.now() + (5 * 60 * 1000)).toLocaleTimeString('ar-EG') : 'not scheduled'
      }
    });
  });

  // ================== Start Server ==================
  async function initializeServer() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 بدء تشغيل السيرفر على port ${PORT}`);
    console.log(`📊 حد الذاكرة: ${isRender ? '512MB (Render)' : 'غير محدد'}`);
    console.log(`⏱️  تحديث BeSoccer: كل 5 دقائق بالضبط`);
    console.log(`${'='.repeat(60)}\n`);
    
    // تحميل الكاش أولاً
    await Promise.allSettled([
      getMatchesCache(),
      getStandingsCache(),
      getBesoccerCache()
    ]);
    
    // تشغيل تحديث BeSoccer فوراً
    console.log("🔄 تشغيل أول تحديث لـ BeSoccer...");
    setTimeout(() => updateBesoccerData(), 2000);
    
    // جدولة التحديثات
    const schedule = [
      { fn: updateLiveScores, interval: 30 * 1000, delay: 0 },           // كل 30 ثانية
      { fn: updateMatches, interval: 5 * 60 * 1000, delay: 5 * 1000 },   // كل 5 دقائق
      { fn: updateStandings, interval: 10 * 60 * 1000, delay: 15 * 1000 }, // كل 10 دقائق
      { fn: updateBesoccerData, interval: 5 * 60 * 1000, delay: 10 * 1000 } // كل 5 دقائق
    ];
    
    schedule.forEach(({ fn, interval, delay }) => {
      setTimeout(() => {
        fn();
        if (fn === updateLiveScores) {
          liveInterval = setInterval(fn, interval);
        } else if (fn === updateBesoccerData) {
          besoccerInterval = setInterval(fn, interval);
          console.log(`⏰ تحديث BeSoccer مجدول كل ${interval / 1000 / 60} دقائق`);
        } else {
          setInterval(fn, interval);
        }
      }, delay);
    });
    
    console.log(`✅ السيرفر جاهز على http://localhost:${PORT}`);
    console.log(`📊 الذاكرة المستخدمة: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
    console.log(`📡 WebSocket: متاح للتحديثات المباشرة`);
    console.log(`${'='.repeat(60)}\n`);
  }

  server.listen(PORT, initializeServer);
}

// معالجة الأخطاء غير المتوقعة
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
});

startServer();