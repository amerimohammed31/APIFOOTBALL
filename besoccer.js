import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import https from 'https';
import crypto from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= الإعدادات المتقدمة مع مكافحة الحظر =================
const CONFIG = {
  // إعدادات الملفات
  OUTPUT_FILE: path.join(__dirname, "./besoccer-complete-data.json"),
  
  // إعدادات الاتصال
  URL: "https://www.besoccer.com/",
  TIMEOUT: 30000,
  CONCURRENT_LIMIT: 2, // تقليل عدد الطلبات المتوازية
  DELAY_BETWEEN_REQUESTS: 3000, // زيادة التأخير
  MAX_RETRIES: 5,
  
  // إعدادات متقدمة
  CACHE_ENABLED: true,
  CACHE_DURATION: 30 * 60 * 1000,
  
  // مكافحة الحظر
  ANTI_DETECTION: {
    ENABLED: true,
    ROTATE_IPS: false, // فعّل إذا كان لديك Proxy
    RANDOM_DELAY: true,
    MIN_DELAY: 2000,
    MAX_DELAY: 5000,
    USE_BROWSER_HEADERS: true,
    ROTATE_ACCEPT_LANGUAGE: true,
    USE_CHROME_VERSION_ROTATION: true
  },
  
  // قائمة وكلاء المستخدمين المتعددة - محدثة
  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1"
  ],
  
  // قائمة Accept-Languages المتعددة
  ACCEPT_LANGUAGES: [
    'en-US,en;q=0.9,ar;q=0.8',
    'en-GB,en;q=0.9,fr;q=0.8,ar;q=0.7',
    'en;q=0.9,es;q=0.8,ar;q=0.7',
    'fr-FR,fr;q=0.9,en;q=0.8,ar;q=0.7',
    'ar-SA,ar;q=0.9,en;q=0.8,fr;q=0.7'
  ],
  
  // قائمة Accept
  ACCEPT_VARIANTS: [
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  ],
  
  // قائمة Proxies (اختياري - يمكنك إضافة Proxies من Webshare أو غيره)
  PROXY_LIST: [
    // مثال: 'http://user:pass@ip:port',
    // 'socks5://user:pass@ip:port'
  ],
  
  // إعدادات التصفية
  FILTER_OPTIONS: {
    REMOVE_DUPLICATES: true,
    REMOVE_EMPTY_MATCHES: true,
    VALIDATE_URLS: true,
    NORMALIZE_TEAM_NAMES: true
  }
};

console.log("\n" + "=".repeat(80));
console.log("🔥 BeSoccer Complete API - الإصدار الاحترافي v3.0 (Anti-Detection)");
console.log("=".repeat(80));
console.log(`📁 ملف الإخراج: ${CONFIG.OUTPUT_FILE}`);
console.log(`⚡ طلبات متوازية: ${CONFIG.CONCURRENT_LIMIT}`);
console.log(`🛡️  مكافحة الحظر: مفعلة`);
console.log("=".repeat(80) + "\n");

// ================= نظام التسجيل =================
class Logger {
  static log(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${type}] ${message}`);
  }
  
  static error(message, error = null) {
    console.log(`[${new Date().toISOString()}] [ERROR] ${message}`);
    if (error) {
      console.log(`   └─ ${error.message || error}`);
    }
  }
  
  static success(message) {
    this.log(message, 'SUCCESS');
  }
  
  static warning(message) {
    this.log(message, 'WARNING');
  }
  
  static antiDetection(message) {
    this.log(`🛡️ ${message}`, 'ANTI-DETECTION');
  }
}

// ================= نظام التأخير الذكي =================
class SmartDelay {
  static async wait(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
  
  static async randomDelay() {
    if (!CONFIG.ANTI_DETECTION.RANDOM_DELAY) return;
    
    const delay = Math.floor(
      Math.random() * (CONFIG.ANTI_DETECTION.MAX_DELAY - CONFIG.ANTI_DETECTION.MIN_DELAY) + 
      CONFIG.ANTI_DETECTION.MIN_DELAY
    );
    
    Logger.antiDetection(`تأخير عشوائي ${delay}ms`);
    await this.wait(delay);
  }
  
  static async exponentialBackoff(attempt) {
    const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 30000);
    Logger.antiDetection(`إنتظار ${Math.round(delay)}ms قبل إعادة المحاولة ${attempt}`);
    await this.wait(delay);
  }
}

// ================= نظام إعادة المحاولة المتقدم =================
class RetryHandler {
  static async execute(fn, options = {}) {
    const {
      retries = CONFIG.MAX_RETRIES,
      delay = 2000,
      backoff = true,
      onRetry = null,
      isAntiDetection = true
    } = options;
    
    let lastError;
    
    for (let i = 0; i < retries; i++) {
      try {
        if (isAntiDetection && i > 0) {
          await SmartDelay.exponentialBackoff(i);
        }
        return await fn();
      } catch (err) {
        lastError = err;
        
        const currentDelay = backoff ? delay * Math.pow(2, i) : delay;
        
        if (onRetry) onRetry(i + 1, retries, err, currentDelay);
        
        if (i < retries - 1) {
          if (!isAntiDetection) {
            await new Promise(resolve => setTimeout(resolve, currentDelay));
          }
        }
      }
    }
    
    throw lastError;
  }
}

// ================= مدير الـ Proxies =================
class ProxyManager {
  constructor() {
    this.proxies = CONFIG.PROXY_LIST;
    this.currentIndex = 0;
    this.failedProxies = new Map(); // proxy -> failure count
    this.maxFailsPerProxy = 3;
  }
  
  getNextProxy() {
    if (this.proxies.length === 0) return null;
    
    // تجاوز الـ proxies الفاشلة
    let attempts = 0;
    while (attempts < this.proxies.length) {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
      
      const fails = this.failedProxies.get(proxy) || 0;
      if (fails < this.maxFailsPerProxy) {
        return proxy;
      }
      attempts++;
    }
    
    // إذا كل الـ proxies فاشلة، نعيد تعيين الفشل
    this.failedProxies.clear();
    return this.proxies[0];
  }
  
  markProxyFailed(proxy) {
    const fails = (this.failedProxies.get(proxy) || 0) + 1;
    this.failedProxies.set(proxy, fails);
    Logger.antiDetection(`Proxy ${proxy} فشل (${fails}/${this.maxFailsPerProxy})`);
  }
  
  getAgent(proxy) {
    if (!proxy) return null;
    
    try {
      if (proxy.startsWith('socks')) {
        return new SocksProxyAgent(proxy);
      } else {
        return new HttpsProxyAgent(proxy);
      }
    } catch (err) {
      Logger.error('خطأ في إنشاء Proxy Agent', err);
      return null;
    }
  }
}

const proxyManager = new ProxyManager();

// ================= عميل HTTP ذكي مع مكافحة الحظر =================
class SmartHttpClient {
  constructor() {
    this.session = axios.create({
      timeout: CONFIG.TIMEOUT,
      httpsAgent: new https.Agent({ 
        keepAlive: true,
        maxSockets: 10,
        maxFreeSockets: 5,
        keepAliveMsecs: 3000
      }),
      maxRedirects: 5,
      decompress: true,
      validateStatus: function (status) {
        return status >= 200 && status < 300; // فقط النجاح
      }
    });
    
    this.cache = new Map();
    this.requestCount = 0;
    this.lastRequestTime = 0;
    this.minRequestInterval = 1000; // ثانية واحدة بين الطلبات
    
    this.setupInterceptors();
  }
  
  setupInterceptors() {
    this.session.interceptors.request.use(async config => {
      this.requestCount++;
      
      // تأخير بين الطلبات
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.minRequestInterval) {
        await SmartDelay.wait(this.minRequestInterval - timeSinceLastRequest);
      }
      
      config.headers = this.getAdvancedHeaders();
      
      // إضافة Proxy إذا كان متاحاً
      if (CONFIG.ANTI_DETECTION.ROTATE_IPS) {
        const proxy = proxyManager.getNextProxy();
        if (proxy) {
          config.httpsAgent = proxyManager.getAgent(proxy);
          config.proxy = false; // تعطيل proxy الافتراضي
          Logger.antiDetection(`استخدام Proxy: ${proxy.substring(0, 20)}...`);
        }
      }
      
      this.lastRequestTime = Date.now();
      return config;
    });
    
    // معالجة الأخطاء
    this.session.interceptors.response.use(
      response => response,
      async error => {
        if (error.config && CONFIG.ANTI_DETECTION.ROTATE_IPS) {
          const proxy = error.config.httpsAgent?.proxy?.href;
          if (proxy) {
            proxyManager.markProxyFailed(proxy);
          }
        }
        return Promise.reject(error);
      }
    );
  }
  
  getAdvancedHeaders() {
    const userAgent = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
    const acceptLanguage = CONFIG.ACCEPT_LANGUAGES[Math.floor(Math.random() * CONFIG.ACCEPT_LANGUAGES.length)];
    const accept = CONFIG.ACCEPT_VARIANTS[Math.floor(Math.random() * CONFIG.ACCEPT_VARIANTS.length)];
    
    // إنشاء بصمة متصفح عشوائية
    const secChUa = `"Not_A Brand";v="8", "Chromium";v="${Math.floor(Math.random() * 20) + 110}", "Google Chrome";v="${Math.floor(Math.random() * 20) + 110}"`;
    const platform = ['"Windows"', '"macOS"', '"Linux"'][Math.floor(Math.random() * 3)];
    
    const headers = {
      'User-Agent': userAgent,
      'Accept': accept,
      'Accept-Language': acceptLanguage,
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
      'sec-ch-ua': secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': platform,
      'DNT': '1'
    };
    
    // إضافة Headers عشوائية إضافية
    if (Math.random() > 0.5) {
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }
    
    return headers;
  }
  
  async get(url, useCache = CONFIG.CACHE_ENABLED) {
    const cacheKey = crypto.createHash('md5').update(url).digest('hex');
    
    if (useCache && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < CONFIG.CACHE_DURATION) {
        Logger.log(`📦 استخدام الكاش لـ ${url.substring(0, 50)}...`, 'CACHE');
        return cached.data;
      } else {
        this.cache.delete(cacheKey);
      }
    }
    
    try {
      // تأخير عشوائي قبل الطلب
      await SmartDelay.randomDelay();
      
      const response = await RetryHandler.execute(
        async () => {
          try {
            const res = await this.session.get(url, {
              // إضافة Cookies عشوائية أحياناً
              headers: {
                ...this.getAdvancedHeaders(),
                ...(Math.random() > 0.7 ? { 'Cookie': `session_${Math.random()}=${Math.random()}` } : {})
              }
            });
            return res;
          } catch (err) {
            // إذا كان الخطأ 406 أو 429، نستخدم تأخير أطول
            if (err.response?.status === 406 || err.response?.status === 429) {
              Logger.antiDetection(`تم حظر الطلب (${err.response.status})، زيادة التأخير`);
              await SmartDelay.wait(10000);
            }
            throw err;
          }
        },
        {
          retries: CONFIG.MAX_RETRIES,
          delay: 3000,
          onRetry: (attempt, total, error) => {
            Logger.warning(`⚠️ إعادة محاولة ${url.substring(0, 50)}... (${attempt}/${total}) - ${error.message}`);
            
            // تغيير الـ User-Agent في كل محاولة
            if (error.config?.headers) {
              error.config.headers['User-Agent'] = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
            }
          }
        }
      );
      
      if (useCache) {
        this.cache.set(cacheKey, {
          data: response.data,
          timestamp: Date.now()
        });
      }
      
      return response.data;
    } catch (error) {
      Logger.error(`❌ فشل جلب ${url} بعد ${CONFIG.MAX_RETRIES} محاولات`, error);
      throw error;
    }
  }
  
  clearCache() {
    this.cache.clear();
    Logger.log('🧹 تم مسح الكاش', 'CACHE');
  }
  
  getStats() {
    return {
      requestCount: this.requestCount,
      cacheSize: this.cache.size
    };
  }
}

const httpClient = new SmartHttpClient();

// ================= أدوات معالجة البيانات (نفس الكود السابق) =================
class DataProcessor {
  static normalizeUrl(url) {
    if (!url) return null;
    
    url = url.replace(/https?:\/\//g, 'https://');
    url = url.replace(/https:\/\/www\.besoccer\.com\/https:\/\//, 'https://www.besoccer.com/');
    
    if (url.startsWith('//')) {
      url = `https:${url}`;
    } else if (url.startsWith('/')) {
      url = `https://www.besoccer.com${url}`;
    } else if (!url.startsWith('http')) {
      url = `https://www.besoccer.com/${url}`;
    }
    
    return url;
  }
  
  static normalizeTeamName(name) {
    if (!name) return null;
    
    return name
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s\u0600-\u06FF-]/g, '')
      .substring(0, 50);
  }
  
  static parseScore(scoreText) {
    const result = {
      full: null,
      home: null,
      away: null,
      penalties: null,
      isPenalty: false
    };
    
    if (!scoreText) return result;
    
    result.full = scoreText.trim().replace(/\s+/g, ' ');
    
    const mainScoreMatch = result.full.match(/(\d+)\s*-\s*(\d+)/);
    if (mainScoreMatch) {
      result.home = mainScoreMatch[1];
      result.away = mainScoreMatch[2];
    }
    
    const penaltyMatch = result.full.match(/\((\d+)\s*-\s*(\d+)\)/);
    if (penaltyMatch) {
      result.penalties = `${penaltyMatch[1]}-${penaltyMatch[2]}`;
      result.isPenalty = true;
    }
    
    return result;
  }
  
  static parseStatus(statusCode, statusText) {
    const statusMap = {
      '-1': 'scheduled',
      '0': 'live',
      '1': 'finished',
      '2': 'postponed',
      '3': 'cancelled',
      '4': 'finished_after_extra'
    };
    
    return statusMap[statusCode] || 'unknown';
  }
  
  static calculateConfidence(match) {
    let score = 0;
    
    if (match.details?.fromPreview) score += 40;
    if (match.details?.fromEvents) score += 40;
    if (match.score?.full) score += 10;
    if (match.homeTeam?.name && match.awayTeam?.name) score += 10;
    
    return Math.min(score, 100);
  }
}

// ================= مستخرج البيانات الرئيسي (نفس الكود السابق) =================
class MatchDataExtractor {
  constructor($, url) {
    this.$ = $;
    this.url = url;
    this.isPreviewPage = url.includes('/preview');
    this.isEventsPage = url.includes('/events');
  }
  
  extract() {
    return {
      jsonld: this.extractJsonLd(),
      competition: this.extractCompetitionInfo(),
      matchInfo: this.extractMatchInfo(),
      lineups: this.extractLineups(),
      stats: this.extractStats(),
      injuries: this.extractInjuries(),
      goalsProgression: this.extractGoalsProgression(),
      radar: this.extractRadarData(),
      events: this.extractEvents()
    };
  }
  
  extractJsonLd() {
    try {
      const script = this.$('script[type="application/ld+json"]').first();
      return script.length ? JSON.parse(script.html()) : {};
    } catch {
      return {};
    }
  }
  
  extractCompetitionInfo() {
    const $ = this.$;
    const competitionEl = $('.competition a').first();
    
    return {
      name: competitionEl.text().trim() || null,
      round: $('.competition span').text().trim() || null,
      globalScore: $('.global-match').first().text().trim() || null
    };
  }
  
  extractMatchInfo() {
    const $ = this.$;
    const info = {
      stadium: { name: null, image: null, capacity: null, size: null, year: null, address: null },
      referee: null,
      var: null
    };
    
    const matchInfoPanel = $('.match-information');
    if (!matchInfoPanel.length) return info;
    
    const stadiumLink = matchInfoPanel.find('a[href*="stadium"]');
    if (stadiumLink.length) {
      info.stadium.name = stadiumLink.text().trim();
      
      const stadiumPopup = $('#stadium');
      if (stadiumPopup.length) {
        info.stadium.image = stadiumPopup.find('img').attr('src') || null;
        info.stadium.address = stadiumPopup.find('.address').text().trim() || null;
        
        stadiumPopup.find('.table-row').each((_, row) => {
          const $row = $(row);
          const label = $row.find('div:first').text().trim();
          const value = $row.find('div:last').text().trim();
          
          if (label.includes('construction')) info.stadium.year = value;
          else if (label.includes('Capacity')) info.stadium.capacity = value;
          else if (label.includes('Size')) info.stadium.size = value;
        });
      }
    }
    
    matchInfoPanel.find('.table-row-round a').each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      const href = $el.attr('href');
      const url = href ? DataProcessor.normalizeUrl(href) : null;
      
      if ($el.closest('.table-row-round').find('svg use[href*="referee_head"]').length) {
        info.referee = { name: text, url };
      } else if ($el.closest('.table-row-round').find('svg use[href*="referee_var"]').length) {
        info.var = { name: text, url };
      }
    });
    
    return info;
  }
  
  extractLineups() {
    const $ = this.$;
    const lineups = {
      local: { formation: null, players: [], rating: null },
      visitor: { formation: null, players: [], rating: null }
    };
    
    if (!this.isPreviewPage) return lineups;
    
    const lineupPanels = $('.best-eleven .tab-content');
    
    lineupPanels.each((index, panel) => {
      const $panel = $(panel);
      const team = index === 0 ? 'local' : 'visitor';
      
      const tacticEl = $panel.find('.match-tactic').first();
      if (tacticEl.length) lineups[team].formation = tacticEl.text().trim();
      
      const ratingEl = $panel.find('.match-point').first();
      if (ratingEl.length) lineups[team].rating = ratingEl.text().trim();
      
      $panel.find('.lineup li').each((_, playerEl) => {
        const $player = $(playerEl);
        const link = $player.find('a');
        const name = link.find('.name').text().trim();
        const href = link.attr('href');
        const img = link.find('img').attr('src');
        const rating = link.find('.match-point-sm').text().trim();
        const isCaptain = link.find('.leader').length > 0;
        
        if (name) {
          lineups[team].players.push({
            name,
            url: href ? DataProcessor.normalizeUrl(href) : null,
            image: img || null,
            rating: rating || null,
            captain: isCaptain
          });
        }
      });
    });
    
    return lineups;
  }
  
  extractStats() {
    const $ = this.$;
    const stats = {
      general: [],
      recentForm: { local: [], visitor: [], streaks: {} },
      offensive: { local: [], visitor: [] },
      featured: { local: [], visitor: [] },
      h2h: { matches: [], wins: { local: 0, draws: 0, visitor: 0 } },
      knockout: { firstLeg: null, secondLeg: null, global: null },
      squadValue: null,
      matchStats: null
    };
    
    if (!this.isPreviewPage) {
      stats.matchStats = this.extractMatchStats();
      return stats;
    }
    
    $('.general-stats .tab-content').each((_, tab) => {
      const $tab = $(tab);
      const isActive = $tab.hasClass('active');
      
      $tab.find('table tbody tr').each((_, row) => {
        const $row = $(row);
        const label = $row.find('.text-label').text().trim();
        const leftValue = $row.find('.td-num.left span').first().text().trim();
        const rightValue = $row.find('.td-num.right span').first().text().trim();
        const leftMark = $row.find('.td-num.left .mark').length > 0;
        const rightMark = $row.find('.td-num.right .mark').length > 0;
        
        if (label) {
          stats.general.push({
            category: isActive ? 'competition' : 'all',
            label,
            local: { value: leftValue, highlight: leftMark },
            visitor: { value: rightValue, highlight: rightMark }
          });
        }
      });
      
      const squadValue = $tab.find('.row.ta-c .col-2');
      if (squadValue.length >= 2) {
        stats.squadValue = {
          local: $(squadValue[0]).text().trim(),
          visitor: $(squadValue[1]).text().trim()
        };
      }
    });
    
    $('.recent-form .tab-content').each((_, tab) => {
      const $tab = $(tab);
      const isActive = $tab.hasClass('active');
      const context = isActive ? 'competition' : 'all';
      
      $tab.find('.team-coach-stats').each((index, teamEl) => {
        const $team = $(teamEl);
        const isLocal = index === 0;
        
        $team.find('.row.mb5').each((_, matchEl) => {
          const $match = $(matchEl);
          const result = $match.find('.bg-match-res').text().trim();
          const score = $match.find('.marker a').text().trim();
          const link = $match.find('a').attr('href');
          const localImg = $match.find('.team-box:first img').attr('src');
          const visitorImg = $match.find('.team-box:last img').attr('src');
          
          stats.recentForm[isLocal ? 'local' : 'visitor'].push({
            context,
            result,
            score,
            url: link ? DataProcessor.normalizeUrl(link) : null,
            localImage: localImg,
            visitorImage: visitorImg
          });
        });
      });
      
      $tab.find('table tbody tr').each((_, row) => {
        const $row = $(row);
        const label = $row.find('.text-label').text().trim();
        const leftValue = $row.find('.td-num.left .color-grey').first().text().trim();
        const leftRecord = $row.find('.td-num.left .record').text().trim();
        const rightValue = $row.find('.td-num.right').first().text().trim();
        const rightRecord = $row.find('.td-num.right .record').text().trim();
        
        if (label) {
          if (!stats.recentForm.streaks[context]) {
            stats.recentForm.streaks[context] = [];
          }
          stats.recentForm.streaks[context].push({
            label,
            local: { value: leftValue, record: leftRecord },
            visitor: { value: rightValue, record: rightRecord }
          });
        }
      });
    });
    
    const knockoutPanel = $('.knockout-stage');
    if (knockoutPanel.length) {
      const matches = [];
      knockoutPanel.find('.box.row').each((_, matchEl) => {
        const $match = $(matchEl);
        const localImg = $match.find('.team-box:first img').attr('src');
        const visitorImg = $match.find('.team-box:last img').attr('src');
        const score = $match.find('.marker .result').text().trim();
        const date = $match.find('.date').text().trim();
        const link = $match.find('a').attr('href');
        
        matches.push({
          localImage: localImg,
          visitorImage: visitorImg,
          score,
          date,
          url: link ? DataProcessor.normalizeUrl(link) : null
        });
      });
      
      if (matches.length >= 2) {
        stats.knockout.firstLeg = matches[0];
        stats.knockout.secondLeg = matches[1];
      }
      
      const globalEl = knockoutPanel.find('.ta-c .result').last();
      if (globalEl.length) stats.knockout.global = globalEl.text().trim();
    }
    
    const h2hPanel = $('.match-h2h');
    if (h2hPanel.length) {
      h2hPanel.find('.row.align-center.table-row-round').each((_, matchEl) => {
        const $match = $(matchEl);
        const localImg = $match.find('.team-box:first img').attr('src');
        const visitorImg = $match.find('.team-box:last img').attr('src');
        const localResult = $match.find('.team-box:first .bg-match-res').attr('class');
        const visitorResult = $match.find('.team-box:last .bg-match-res').attr('class');
        const score = $match.find('.marker a').text().trim();
        const link = $match.find('a').attr('href');
        
        stats.h2h.matches.push({
          localImage: localImg,
          visitorImage: visitorImg,
          localResult: localResult?.includes('win') ? 'win' : localResult?.includes('draw') ? 'draw' : 'lose',
          visitorResult: visitorResult?.includes('win') ? 'win' : visitorResult?.includes('draw') ? 'draw' : 'lose',
          score,
          url: link ? DataProcessor.normalizeUrl(link) : null
        });
      });
      
      const winStats = h2hPanel.find('.row.jc-sa .box');
      if (winStats.length >= 3) {
        stats.h2h.wins.local = $(winStats[0]).find('.num').text().trim() || '0';
        stats.h2h.wins.draws = $(winStats[1]).find('.num').text().trim() || '0';
        stats.h2h.wins.visitor = $(winStats[2]).find('.num').text().trim() || '0';
      }
    }
    
    $('.offensive-contribution .tab-content').each((_, tab) => {
      const $tab = $(tab);
      const isActive = $tab.hasClass('active');
      const context = isActive ? 'competition' : 'all';
      
      $tab.find('.col-6').each((index, col) => {
        const $col = $(col);
        const team = index === 0 ? 'local' : 'visitor';
        
        $col.find('.item-box').each((_, playerEl) => {
          const $player = $(playerEl);
          const name = $player.find('.mb5').text().trim();
          const img = $player.find('img').attr('src');
          const link = $player.attr('href');
          
          const assistsBar = $player.find('.assist');
          const goalsBar = $player.find('.goal');
          
          const assists = assistsBar.length ? assistsBar.find('.box span').text().trim().replace(/[()]/g, '') : '0';
          const goals = goalsBar.length ? goalsBar.find('.box span').text().trim().replace(/[()]/g, '') : '0';
          
          if (name) {
            if (!stats.offensive[team]) stats.offensive[team] = [];
            stats.offensive[team].push({
              context,
              name,
              image: img,
              url: link ? DataProcessor.normalizeUrl(link) : null,
              assists: parseInt(assists) || 0,
              goals: parseInt(goals) || 0
            });
          }
        });
      });
    });
    
    $('.matches-featured-players .tab-content').each((_, tab) => {
      const $tab = $(tab);
      const isActive = $tab.hasClass('active');
      const context = isActive ? 'competition' : 'all';
      
      $tab.find('.mb15').each((_, categoryEl) => {
        const $category = $(categoryEl);
        const category = $category.find('.title').text().trim();
        
        $category.find('.row .col-6').each((index, playerCol) => {
          const $playerCol = $(playerCol);
          const isLocal = index === 0;
          const value = $playerCol.find('.mark').text().trim();
          const name = $playerCol.find('.item-box div').text().trim();
          const img = $playerCol.find('img').attr('src');
          const link = $playerCol.find('.item-box').attr('href');
          
          if (name && value) {
            const team = isLocal ? 'local' : 'visitor';
            if (!stats.featured[team]) stats.featured[team] = [];
            stats.featured[team].push({
              context,
              category,
              name,
              value,
              image: img,
              url: link ? DataProcessor.normalizeUrl(link) : null
            });
          }
        });
      });
    });
    
    return stats;
  }
  
  extractMatchStats() {
    const $ = this.$;
    const stats = {};
    
    const matchStatsPanel = $('.panel.detail-match-stats.general-stats[data-cy="stats"]');
    if (!matchStatsPanel.length) return null;
    
    matchStatsPanel.find('table tbody tr').each((_, row) => {
      const $row = $(row);
      const title = $row.find('.title b').text().trim();
      
      if (title) {
        stats[title] = [];
      } else {
        const label = $row.find('.color-grey2 p, .text-label').first().text().trim();
        if (label) {
          const leftValue = $row.find('.td-num.left span').first().text().trim();
          const rightValue = $row.find('.td-num.right span').first().text().trim();
          const leftMark = $row.find('.td-num.left .mark').length > 0;
          const rightMark = $row.find('.td-num.right .mark').length > 0;
          
          if (label.includes('Ball possession')) {
            const leftPercent = $row.find('.td-num.left span').last().text().trim();
            const rightPercent = $row.find('.td-num.right span').last().text().trim();
            stats.possession = {
              local: leftPercent,
              visitor: rightPercent
            };
          }
          
          if (label.includes('Total shots')) {
            stats.shots = {
              local: leftValue,
              visitor: rightValue
            };
          }
          
          stats[label] = {
            local: { value: leftValue, highlight: leftMark },
            visitor: { value: rightValue, highlight: rightMark }
          };
        }
      }
    });
    
    return stats;
  }
  
  extractInjuries() {
    const $ = this.$;
    const injuries = { local: [], visitor: [] };
    
    if (!this.isPreviewPage) return injuries;
    
    $('.match-injuries.unavailable .col-6').each((index, col) => {
      const $col = $(col);
      const team = index === 0 ? 'local' : 'visitor';
      
      $col.find('.item-box').each((_, playerEl) => {
        const $player = $(playerEl);
        const name = $player.find('.main-text').text().trim();
        const injury = $player.find('.sub-text2').text().trim();
        const chance = $player.find('.min-box span').text().trim();
        const img = $player.find('img').attr('src');
        const link = $player.attr('href');
        
        if (name) {
          injuries[team].push({
            name,
            injury,
            chance,
            image: img,
            url: link ? DataProcessor.normalizeUrl(link) : null
          });
        }
      });
    });
    
    return injuries;
  }
  
  extractGoalsProgression() {
    const $ = this.$;
    const progression = { local: [], visitor: [] };
    
    if (!this.isPreviewPage) return progression;
    
    $('.goals-progression .row.align-center').each((index, row) => {
      const $row = $(row);
      const team = index === 0 ? 'local' : 'visitor';
      
      $row.find('.bar').each((_, barEl) => {
        const $bar = $(barEl);
        const width = $bar.css('width');
        const number = $bar.find('.num').text().trim();
        const color = $bar.attr('class')?.split(' ').find(c => 
          ['pink', 'orange', 'yellow', 'green', 'blue', 'purple'].includes(c)
        );
        
        if (number) {
          progression[team].push({
            interval: color,
            count: number,
            percentage: width
          });
        }
      });
    });
    
    return progression;
  }
  
  extractRadarData() {
    const $ = this.$;
    const radar = {
      local: { values: [], color: null },
      visitor: { values: [], color: null }
    };
    
    if (!this.isPreviewPage) return radar;
    
    const radarData = $('#radarChart').find('script').last().html();
    if (!radarData) return radar;
    
    const localMatch = radarData.match(/values: \[([^\]]+)\]/g);
    if (localMatch && localMatch.length >= 2) {
      radar.local.values = localMatch[0].match(/\d+/g)?.map(Number) || [];
      radar.visitor.values = localMatch[1].match(/\d+/g)?.map(Number) || [];
    }
    
    const colors = radarData.match(/#[0-9a-f]{6}/g);
    if (colors && colors.length >= 2) {
      radar.local.color = colors[0];
      radar.visitor.color = colors[1];
    }
    
    return radar;
  }
  
  extractEvents() {
    const $ = this.$;
    const events = {
      goals: [],
      cards: [],
      substitutions: [],
      occasions: [],
      var: []
    };
    
    if (!this.isEventsPage) return events;
    
    const eventsPanel = $('.match-events');
    if (!eventsPanel.length) return events;
    
    eventsPanel.find('#events-goals .table-body .table-played-match').each((_, eventEl) => {
      const $event = $(eventEl);
      const minute = $event.find('.min').text().trim();
      const score = $event.find('.mini-result').text().trim();
      const localPlayer = $event.find('.col-side.left .name').first().text().trim();
      const visitorPlayer = $event.find('.col-side.right .name').first().text().trim();
      
      if (localPlayer || visitorPlayer) {
        events.goals.push({
          minute,
          score,
          localPlayer,
          visitorPlayer,
          type: $event.find('.event-wrapper img').first().attr('alt')
        });
      }
    });
    
    eventsPanel.find('#events-cards .table-body .table-played-match').each((_, eventEl) => {
      const $event = $(eventEl);
      const minute = $event.find('.min').text().trim();
      const localPlayer = $event.find('.col-side.left .name').first().text().trim();
      const visitorPlayer = $event.find('.col-side.right .name').first().text().trim();
      const cardType = $event.find('.event-wrapper img').first().attr('alt');
      const reason = $event.find('.color-grey2').text().trim();
      
      if (localPlayer || visitorPlayer) {
        events.cards.push({
          minute,
          cardType,
          reason,
          localPlayer,
          visitorPlayer
        });
      }
    });
    
    eventsPanel.find('#events-changes .table-body .table-played-match').each((_, eventEl) => {
      const $event = $(eventEl);
      const minute = $event.find('.min').text().trim();
      const localOut = $event.find('.col-side.left .name').first().text().trim();
      const localIn = $event.find('.col-side.left .color-grey2').first().text().trim();
      const visitorOut = $event.find('.col-side.right .name').first().text().trim();
      const visitorIn = $event.find('.col-side.right .color-grey2').first().text().trim();
      
      if (localOut || visitorOut) {
        events.substitutions.push({
          minute,
          local: localOut ? { out: localOut, in: localIn } : null,
          visitor: visitorOut ? { out: visitorOut, in: visitorIn } : null
        });
      }
    });
    
    eventsPanel.find('#events-occasions .table-body .table-played-match').each((_, eventEl) => {
      const $event = $(eventEl);
      const minute = $event.find('.min').text().trim();
      const localPlayer = $event.find('.col-side.left .name').first().text().trim();
      const visitorPlayer = $event.find('.col-side.right .name').first().text().trim();
      
      if (localPlayer || visitorPlayer) {
        events.occasions.push({
          minute,
          localPlayer,
          visitorPlayer,
          type: $event.find('.event-wrapper img').first().attr('alt')
        });
      }
    });
    
    eventsPanel.find('#events-var .table-body .table-played-match').each((_, eventEl) => {
      const $event = $(eventEl);
      const minute = $event.find('.min').text().trim();
      const localPlayer = $event.find('.col-side.left .name').first().text().trim();
      const visitorPlayer = $event.find('.col-side.right .name').first().text().trim();
      
      if (localPlayer || visitorPlayer) {
        events.var.push({
          minute,
          localPlayer,
          visitorPlayer,
          decision: $event.find('.color-grey2').text().trim()
        });
      }
    });
    
    return events;
  }
}

// ================= استخراج المباريات الأساسية (نفس الكود) =================
function extractBasicMatches($, panelEl) {
  const $panel = $(panelEl);
  const matches = [];
  
  $panel.find('.match-link').each((_, matchEl) => {
    const $match = $(matchEl);
    
    try {
      let matchUrl = $match.attr('href');
      if (matchUrl) matchUrl = DataProcessor.normalizeUrl(matchUrl);
      
      const startTime = $match.attr('starttime') || null;
      const statusCode = $match.attr('data-status') || null;
      const statusText = $match.find('.dates .tag-nobg b').text().trim() || null;
      
      const isLive = statusCode === '0' && statusText && statusText.includes("'");
      
      const teamInfos = $match.find('.team-info');
      let homeTeam = { name: null, logo: null, score: null, winner: false };
      let awayTeam = { name: null, logo: null, score: null, winner: false };
      
      if (teamInfos.length >= 2) {
        const $home = $(teamInfos[0]);
        const $away = $(teamInfos[1]);
        
        homeTeam.name = DataProcessor.normalizeTeamName($home.find('.team-name').text().trim());
        homeTeam.winner = $home.hasClass('winner');
        const homeImg = $home.find('img.team-shield');
        homeTeam.logo = homeImg.attr('src') || homeImg.attr('data-src') || null;
        
        awayTeam.name = DataProcessor.normalizeTeamName($away.find('.team-name').text().trim());
        awayTeam.winner = $away.hasClass('winner');
        const awayImg = $away.find('img.team-shield');
        awayTeam.logo = awayImg.attr('src') || awayImg.attr('data-src') || null;
      }
      
      const marker = $match.find('.marker');
      let score = { full: null, home: null, away: null, penalties: null };
      let time = null;
      
      if (marker.length) {
        const scoreSpan = marker.find('span').first();
        if (scoreSpan.length && scoreSpan.text().trim()) {
          score = DataProcessor.parseScore(scoreSpan.text().trim());
          homeTeam.score = score.home;
          awayTeam.score = score.away;
        } else {
          time = marker.find('.match_hour.time, .time').text().trim();
        }
      }
      
      const match = {
        id: $match.attr('id') || `match-${Date.now()}-${Math.random()}`,
        url: matchUrl,
        matchId: $match.attr('id')?.replace('match-', '') || null,
        
        homeTeam,
        awayTeam,
        
        score,
        time: time || (startTime ? startTime.split('T')[1]?.substring(0, 5) : null),
        date: startTime ? startTime.split('T')[0] : null,
        startTime,
        
        status: DataProcessor.parseStatus(statusCode, statusText),
        isLive,
        statusCode,
        statusText,
        
        isVmore: $match.hasClass('vmore-hide'),
        
        details: {
          fromPreview: null,
          fromEvents: null
        },
        
        confidence: 0,
        lastUpdated: new Date().toISOString()
      };
      
      matches.push(match);
      
    } catch (err) {
      Logger.warning(`خطأ في استخراج مباراة: ${err.message}`);
    }
  });
  
  return matches;
}

// ================= استخراج بيانات البطولة (نفس الكود) =================
function extractCompetition($, panelEl) {
  const $panel = $(panelEl);
  
  let competitionUrl = $panel.find('.panel-head a').first().attr('href');
  if (competitionUrl) competitionUrl = DataProcessor.normalizeUrl(competitionUrl);
  
  const competition = {
    name: $panel.find('.panel-title span.va-m').first().text().trim() || 'بطولة',
    logo: $panel.find('.panel-title img.comp-img').attr('src') || null,
    url: competitionUrl,
    country: null,
    matches: [],
    visibleMatches: 0,
    hiddenMatches: 0,
    hasViewMore: $panel.find('.view_more_btn, .vmore-initial').length > 0
  };
  
  if (competition.logo) {
    const countryMatch = competition.logo.match(/flags\/st3\/small\/([a-z]{2})\.png/);
    if (countryMatch) competition.country = countryMatch[1];
  }
  
  const matches = extractBasicMatches($, panelEl);
  
  matches.forEach(match => {
    competition.matches.push(match);
    if (match.isVmore) competition.hiddenMatches++;
    else competition.visibleMatches++;
  });
  
  return competition;
}

// ================= جلب تفاصيل مباراة كاملة (معدل مع مكافحة الحظر) =================
async function fetchMatchDetails(match) {
  if (!match.url) return match;
  
  let baseUrl = match.url.replace(/\/preview$|\/events$/, '').replace(/\/$/, '');
  const previewUrl = `${baseUrl}/preview`;
  const eventsUrl = `${baseUrl}/events`;
  
  Logger.log(`📥 جلب تفاصيل: ${match.homeTeam.name || '?'} vs ${match.awayTeam.name || '?'}`);
  
  try {
    const limit = pLimit(1); // تقليل التوازي إلى 1 لمزيد من الأمان
    const promises = [];
    
    promises.push(limit(async () => {
      try {
        // تأخير عشوائي قبل كل طلب
        await SmartDelay.randomDelay();
        const html = await httpClient.get(previewUrl);
        const $ = cheerio.load(html);
        const extractor = new MatchDataExtractor($, previewUrl);
        match.details.fromPreview = extractor.extract();
        Logger.log(`   ✅ /preview`);
      } catch (err) {
        Logger.warning(`   ⚠️ فشل /preview: ${err.message}`);
      }
    }));
    
    promises.push(limit(async () => {
      try {
        // تأخير عشوائي قبل كل طلب
        await SmartDelay.randomDelay();
        const html = await httpClient.get(eventsUrl);
        const $ = cheerio.load(html);
        const extractor = new MatchDataExtractor($, eventsUrl);
        match.details.fromEvents = extractor.extract();
        Logger.log(`   ✅ /events`);
      } catch (err) {
        Logger.warning(`   ⚠️ فشل /events: ${err.message}`);
      }
    }));
    
    await Promise.all(promises);
    
    match.confidence = DataProcessor.calculateConfidence(match);
    match.lastUpdated = new Date().toISOString();
    
    Logger.success(`   ✅ اكتمل: ${match.confidence}%`);
    
  } catch (err) {
    Logger.error(`   ❌ فشل كامل`, err);
  }
  
  // تأخير أطول بين المباريات
  await SmartDelay.wait(CONFIG.DELAY_BETWEEN_REQUESTS);
  
  return match;
}

// ================= معالجة البيانات النهائية (نفس الكود) =================
function processFinalData(data) {
  Logger.log('🧹 معالجة البيانات النهائية...');
  
  if (CONFIG.FILTER_OPTIONS.REMOVE_DUPLICATES) {
    const seenUrls = new Set();
    
    data.competitions.forEach(comp => {
      comp.matches = comp.matches.filter(match => {
        if (!match.url) return true;
        if (seenUrls.has(match.url)) return false;
        seenUrls.add(match.url);
        return true;
      });
      
      comp.visibleMatches = comp.matches.filter(m => !m.isVmore).length;
      comp.hiddenMatches = comp.matches.filter(m => m.isVmore).length;
    });
    
    data.competitions = data.competitions.filter(comp => comp.matches.length > 0);
  }
  
  if (CONFIG.FILTER_OPTIONS.REMOVE_EMPTY_MATCHES) {
    data.competitions.forEach(comp => {
      comp.matches = comp.matches.filter(match => 
        match.homeTeam.name || match.awayTeam.name
      );
    });
  }
  
  data.metadata.totalMatches = data.competitions.reduce((sum, comp) => sum + comp.matches.length, 0);
  
  data.statistics = {
    byStatus: { scheduled: 0, live: 0, finished: 0, postponed: 0, cancelled: 0, unknown: 0 },
    byCountry: {},
    byConfidence: { high: 0, medium: 0, low: 0 }
  };
  
  data.competitions.forEach(comp => {
    comp.matches.forEach(match => {
      if (data.statistics.byStatus.hasOwnProperty(match.status)) {
        data.statistics.byStatus[match.status]++;
      } else {
        data.statistics.byStatus.unknown++;
      }
      
      if (comp.country) {
        data.statistics.byCountry[comp.country] = 
          (data.statistics.byCountry[comp.country] || 0) + 1;
      }
      
      if (match.confidence >= 80) data.statistics.byConfidence.high++;
      else if (match.confidence >= 50) data.statistics.byConfidence.medium++;
      else data.statistics.byConfidence.low++;
    });
  });
  
  return data;
}

// ================= الدالة الرئيسية (معدلة) =================
async function main() {
  const startTime = Date.now();
  
  try {
    Logger.log('🌐 جلب الصفحة الرئيسية...');
    
    // محاولة جلب الصفحة الرئيسية مع تأخير أولي
    await SmartDelay.wait(5000); // انتظار 5 ثواني قبل البدء
    
    const mainHtml = await httpClient.get(CONFIG.URL);
    
    Logger.log('🔍 تحليل الصفحة...');
    const $ = cheerio.load(mainHtml);
    
    const competitions = [];
    
    $('#tableMatches .panel').each((_, panelEl) => {
      const competition = extractCompetition($, panelEl);
      if (competition.matches.length > 0) {
        competitions.push(competition);
      }
    });
    
    const basicData = {
      metadata: {
        timestamp: new Date().toISOString(),
        url: CONFIG.URL,
        totalCompetitions: competitions.length,
        totalMatches: competitions.reduce((sum, comp) => sum + comp.matches.length, 0),
        visibleMatches: competitions.reduce((sum, comp) => sum + comp.visibleMatches, 0),
        hiddenMatches: competitions.reduce((sum, comp) => sum + comp.hiddenMatches, 0)
      },
      competitions
    };
    
    Logger.success(`✅ تم استخراج: ${basicData.metadata.totalCompetitions} بطولة, ${basicData.metadata.totalMatches} مباراة`);
    
    const allMatches = [];
    basicData.competitions.forEach(comp => {
      comp.matches.forEach(match => {
        allMatches.push({
          ...match,
          competitionName: comp.name
        });
      });
    });
    
    Logger.log(`\n📊 بدء جلب تفاصيل ${allMatches.length} مباراة...`);
    
    const limit = pLimit(CONFIG.CONCURRENT_LIMIT);
    const promises = allMatches.map((match, index) => 
      limit(async () => {
        Logger.log(`\n🔄 [${index + 1}/${allMatches.length}] ${match.homeTeam.name || '?'} vs ${match.awayTeam.name || '?'}`);
        const updatedMatch = await fetchMatchDetails(match);
        
        basicData.competitions.forEach(comp => {
          const matchIndex = comp.matches.findIndex(m => m.id === updatedMatch.id);
          if (matchIndex !== -1) {
            comp.matches[matchIndex] = updatedMatch;
          }
        });
      })
    );
    
    await Promise.all(promises);
    
    const finalData = processFinalData(basicData);
    
    finalData.metadata.performance = {
      executionTimeMs: Date.now() - startTime,
      concurrentLimit: CONFIG.CONCURRENT_LIMIT,
      executionTimeMinutes: ((Date.now() - startTime) / 1000 / 60).toFixed(2),
      totalRequests: httpClient.getStats().requestCount,
      cacheHits: httpClient.getStats().cacheSize
    };
    
    const matchesWithDetails = finalData.competitions.reduce((sum, comp) => 
      sum + comp.matches.filter(m => m.details?.fromPreview || m.details?.fromEvents).length, 0
    );
    
    finalData.metadata.detailsFetched = {
      total: finalData.metadata.totalMatches,
      successful: matchesWithDetails,
      failed: finalData.metadata.totalMatches - matchesWithDetails,
      successRate: ((matchesWithDetails / finalData.metadata.totalMatches) * 100).toFixed(1)
    };
    
    fs.writeFileSync(CONFIG.OUTPUT_FILE, JSON.stringify(finalData, null, 2), 'utf-8');
    
    console.log("\n" + "=".repeat(80));
    console.log("📊 التقرير النهائي:");
    console.log("=".repeat(80));
    console.log(`⏱️  وقت التنفيذ: ${finalData.metadata.performance.executionTimeMinutes} دقيقة`);
    console.log(`📁 الملف: ${CONFIG.OUTPUT_FILE}`);
    console.log(`🌐 عدد الطلبات: ${finalData.metadata.performance.totalRequests}`);
    console.log(`📦 حجم الكاش: ${finalData.metadata.performance.cacheHits}`);
    console.log(`\n📈 إحصائيات المباريات:`);
    console.log(`   └─ المجموع: ${finalData.metadata.totalMatches}`);
    console.log(`   └─ مباشرة: ${finalData.statistics.byStatus.live}`);
    console.log(`   └─ منتهية: ${finalData.statistics.byStatus.finished}`);
    console.log(`   └─ مجدولة: ${finalData.statistics.byStatus.scheduled}`);
    console.log(`\n📊 جودة البيانات:`);
    console.log(`   └─ عالية (≥80%): ${finalData.statistics.byConfidence.high}`);
    console.log(`   └─ متوسطة (≥50%): ${finalData.statistics.byConfidence.medium}`);
    console.log(`   └─ منخفضة (<50%): ${finalData.statistics.byConfidence.low}`);
    console.log("=".repeat(80) + "\n");
    
  } catch (err) {
    Logger.error('💥 خطأ غير متوقع', err);
    
    // محاولة حفظ أي بيانات جزئية
    try {
      const partialData = {
        error: err.message,
        timestamp: new Date().toISOString(),
        partial: true
      };
      fs.writeFileSync(CONFIG.OUTPUT_FILE.replace('.json', '-error.json'), JSON.stringify(partialData, null, 2));
      Logger.log('💾 تم حفظ تقرير الخطأ');
    } catch (e) {
      // تجاهل
    }
    
    process.exit(1);
  }
}

// تشغيل السكريبت مع تأخير أولي
setTimeout(() => {
  main();
}, 3000);

process.on('SIGINT', () => {
  Logger.warning('\n⚠️ تم إيقاف السكريبت بواسطة المستخدم');
  process.exit(0);
});