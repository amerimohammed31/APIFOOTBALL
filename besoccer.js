import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= الإعدادات المحسنة =================
const CONFIG = {
  OUTPUT_FILE: path.join(__dirname, "./besoccer-complete-data.json"),
  URL: "https://www.besoccer.com/",
  TIMEOUT: 15000,
  CONCURRENT_LIMIT: 2, // تقليل لتجنب الضغط على الموقع
  DELAY_BETWEEN_REQUESTS: 1000,
  MAX_RETRIES: 2,
  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
  ]
};

console.log("🚀 بدء تشغيل سكريبت BeSoccer - النسخة الكاملة");

// التأكد من صلاحية الكتابة
try {
  fs.accessSync(__dirname, fs.constants.W_OK);
  console.log(`✅ صلاحية الكتابة: متاحة في ${__dirname}`);
} catch (err) {
  console.error(`❌ لا يمكن الكتابة في: ${__dirname}`);
  process.exit(1);
}

// ================= فئة للتعامل مع الأخطاء =================
class ErrorHandler {
  static async retry(fn, retries = CONFIG.MAX_RETRIES, delay = 1000) {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err) {
        console.log(`   ⚠️ محاولة ${i + 1}/${retries} فشلت: ${err.message.substring(0, 50)}`);
        if (i === retries - 1) throw err;
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
      }
    }
  }
}

// ================= عميل HTTP محسن =================
class HttpClient {
  constructor() {
    this.axiosInstance = axios.create({
      timeout: CONFIG.TIMEOUT,
      httpsAgent: new https.Agent({ 
        keepAlive: true, 
        maxSockets: 5,
        keepAliveMsecs: 1000
      }),
      maxRedirects: 5,
      decompress: true
    });
  }

  getHeaders() {
    return {
      'User-Agent': CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none'
    };
  }

  async get(url) {
    try {
      const response = await this.axiosInstance.get(url, { 
        headers: this.getHeaders(),
        validateStatus: status => status < 500
      });
      return response.data;
    } catch (err) {
      throw err;
    }
  }
}

const httpClient = new HttpClient();

// ================= دالة تنظيف الرابط =================
function cleanUrl(url) {
  if (!url) return null;
  url = url.replace(/https?:\/\//g, '');
  url = url.replace(/www\./g, '');
  return `https://www.${url}`;
}

// ================= استخراج بيانات المباراة الأساسية =================
function extractBasicMatchData($, matchEl) {
  const $match = $(matchEl);
  let matchUrl = $match.attr('href');
  if (matchUrl) {
    if (!matchUrl.startsWith('http')) {
      matchUrl = `https://www.besoccer.com${matchUrl}`;
    }
  }

  const matchData = {
    id: $match.attr('id') || null,
    url: matchUrl || null,
    matchId: $match.attr('id')?.replace('match-', '') || $match.attr('data-match-id') || null,
    homeTeam: { name: null, logo: null, score: null, winner: false },
    awayTeam: { name: null, logo: null, score: null, winner: false },
    score: { full: null, home: null, away: null, penalties: null },
    time: null,
    date: null,
    startTime: $match.attr('starttime') || null,
    status: 'scheduled',
    isLive: $match.hasClass('live') || $match.attr('data-live') === '1',
    statusCode: $match.attr('data-status') || null,
    statusText: null,
    isVmore: $match.hasClass('vmore-hide'),
    lastUpdate: new Date().toISOString()
  };

  try {
    if (matchData.startTime) {
      matchData.date = matchData.startTime.split('T')[0];
      matchData.time = matchData.startTime.split('T')[1]?.substring(0, 5);
    }

    if (matchData.statusCode === '1' || matchData.statusCode === '4') matchData.status = 'finished';
    else if (matchData.statusCode === '2') matchData.status = 'postponed';

    const teamInfos = $match.find('.team-info');
    if (teamInfos.length >= 2) {
      const $home = $(teamInfos[0]);
      const $away = $(teamInfos[1]);

      matchData.homeTeam.name = $home.find('.team-name').text().trim() || null;
      matchData.homeTeam.winner = $home.hasClass('winner');
      const homeImg = $home.find('img.team-shield');
      matchData.homeTeam.logo = homeImg.attr('src') || homeImg.attr('data-src') || null;

      matchData.awayTeam.name = $away.find('.team-name').text().trim() || null;
      matchData.awayTeam.winner = $away.hasClass('winner');
      const awayImg = $away.find('img.team-shield');
      matchData.awayTeam.logo = awayImg.attr('src') || awayImg.attr('data-src') || null;
    }

    const marker = $match.find('.marker');
    if (marker.length) {
      const scoreSpan = marker.find('span').first();
      if (scoreSpan.length && scoreSpan.text().trim()) {
        matchData.score.full = scoreSpan.text().trim().replace(/\s+/g, ' ');
        const numbers = matchData.score.full.match(/\d+/g);
        if (numbers?.length >= 2) {
          matchData.score.home = numbers[0];
          matchData.score.away = numbers[1];
          matchData.homeTeam.score = numbers[0];
          matchData.awayTeam.score = numbers[1];
        }
        const penaltiesMatch = matchData.score.full.match(/\((\d+)\s*-\s*(\d+)\)/);
        if (penaltiesMatch) matchData.score.penalties = penaltiesMatch[0];
      } else {
        matchData.time = marker.find('.match_hour.time, .time').text().trim() || matchData.time;
      }
    }

    const datesDiv = $match.find('.dates');
    if (datesDiv.length) {
      const statusSpan = datesDiv.find('.tag-nobg');
      if (statusSpan.length) {
        matchData.statusText = statusSpan.find('b').text().trim() || null;
      }
    }

  } catch (err) {
    // تجاهل الأخطاء في الاستخراج
  }

  return matchData;
}

// ================= استخراج بيانات البطولة =================
function extractBasicCompetitionData($, panelEl) {
  const $panel = $(panelEl);
  let competitionUrl = $panel.find('.panel-head a').first().attr('href');
  if (competitionUrl && !competitionUrl.startsWith('http')) {
    competitionUrl = `https://www.besoccer.com${competitionUrl}`;
  }

  const competition = {
    name: $panel.find('.panel-title span.va-m').first().text().trim() || 'بطولة',
    logo: $panel.find('.panel-title img.comp-img').attr('src') || null,
    url: competitionUrl || null,
    country: null,
    matches: [],
    visibleMatches: 0,
    hiddenMatches: 0,
    hasViewMore: $panel.find('.view_more_btn, .vmore-initial').length > 0
  };

  try {
    if (competition.logo) {
      const countryMatch = competition.logo.match(/flags\/st3\/small\/([a-z]{2})\.png/);
      if (countryMatch) competition.country = countryMatch[1];
    }

    $panel.find('.match-link').each((_, matchEl) => {
      const matchData = extractBasicMatchData($, matchEl);
      if (matchData.homeTeam.name || matchData.awayTeam.name) {
        competition.matches.push(matchData);
        if (matchData.isVmore) competition.hiddenMatches++;
        else competition.visibleMatches++;
      }
    });

  } catch (err) {
    // تجاهل الأخطاء
  }

  return competition;
}

// ================= استخراج تفاصيل المباراة من الرابط =================
function extractMatchDetailsFromUrl($, url) {
  const details = {
    jsonld: {},
    competition: null,
    round: null,
    globalScore: null,
    matchInfo: {
      stadium: { name: null, image: null, capacity: null, size: null, year: null, address: null },
      referee: null,
      var: null
    },
    lineups: {
      local: { formation: null, players: [], rating: null },
      visitor: { formation: null, players: [], rating: null }
    },
    stats: {
      general: [],
      recentForm: { local: [], visitor: [], streaks: {} },
      h2h: { matches: [], wins: { local: 0, draws: 0, visitor: 0 } }
    },
    injuries: { local: [], visitor: [] },
    events: { goals: [], cards: [], substitutions: [], occasions: [], var: [] },
    liveData: {
      currentMinute: null,
      score: { home: null, away: null }
    }
  };

  try {
    // JSON-LD
    const jsonldScript = $('script[type="application/ld+json"]').first();
    if (jsonldScript.length) {
      try { details.jsonld = JSON.parse(jsonldScript.html()); } catch (e) {}
    }

    // معلومات البطولة
    const competitionEl = $('.competition a').first();
    if (competitionEl.length) {
      details.competition = competitionEl.text().trim();
      details.round = $('.competition span').text().trim() || null;
    }

    // استخراج النتيجة الحالية والدقيقة
    const scoreEl = $('.match-score .actual-score').first();
    if (scoreEl.length) {
      const scoreText = scoreEl.text().trim();
      const numbers = scoreText.match(/\d+/g);
      if (numbers && numbers.length >= 2) {
        details.liveData.score.home = numbers[0];
        details.liveData.score.away = numbers[1];
      }
    }

    const minuteEl = $('.match-minute .minute').first();
    if (minuteEl.length) {
      details.liveData.currentMinute = minuteEl.text().trim();
    }

    // معلومات المباراة (الملعب، الحكم)
    const matchInfoPanel = $('.match-information');
    
    const stadiumLink = matchInfoPanel.find('a[href*="stadium"]');
    if (stadiumLink.length) {
      details.matchInfo.stadium.name = stadiumLink.text().trim();
    }
    
    matchInfoPanel.find('.table-row-round a').each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      const href = $el.attr('href');
      const refereeUrl = href ? (href.startsWith('http') ? href : `https://www.besoccer.com${href}`) : null;
      
      if ($el.closest('.table-row-round').find('svg use[href*="referee_head"]').length) {
        details.matchInfo.referee = { name: text, url: refereeUrl };
      } else if ($el.closest('.table-row-round').find('svg use[href*="referee_var"]').length) {
        details.matchInfo.var = { name: text, url: refereeUrl };
      }
    });

    // التشكيلة
    const lineupPanels = $('.best-eleven .tab-content');
    if (lineupPanels.length > 0) {
      lineupPanels.each((index, panel) => {
        const $panel = $(panel);
        const isLocal = $panel.hasClass('active') || index === 0;
        const team = isLocal ? 'local' : 'visitor';
        
        const tacticEl = $panel.find('.match-tactic').first();
        if (tacticEl.length) details.lineups[team].formation = tacticEl.text().trim();
        
        const ratingEl = $panel.find('.match-point').first();
        if (ratingEl.length) details.lineups[team].rating = ratingEl.text().trim();
        
        $panel.find('.lineup li').each((_, playerEl) => {
          const $player = $(playerEl);
          const link = $player.find('a');
          const name = link.find('.name').text().trim();
          const href = link.attr('href');
          const img = link.find('img').attr('src');
          const rating = link.find('.match-point-sm').text().trim();
          const isCaptain = link.find('.leader').length > 0;
          
          if (name) {
            details.lineups[team].players.push({
              name,
              url: href ? (href.startsWith('http') ? href : `https://www.besoccer.com${href}`) : null,
              image: img || null,
              rating: rating || null,
              captain: isCaptain
            });
          }
        });
      });
    }

    // إحصائيات عامة
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
          details.stats.general.push({
            category: isActive ? 'competition' : 'all',
            label,
            local: { value: leftValue, highlight: leftMark },
            visitor: { value: rightValue, highlight: rightMark }
          });
        }
      });
    });

    // آخر المباريات
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
          
          details.stats.recentForm[isLocal ? 'local' : 'visitor'].push({
            context,
            result,
            score,
            url: link ? (link.startsWith('http') ? link : `https://www.besoccer.com${link}`) : null,
            localImage: localImg,
            visitorImage: visitorImg
          });
        });
      });
    });

    // المواجهات المباشرة
    const h2hPanel = $('.match-h2h');
    if (h2hPanel.length) {
      h2hPanel.find('.row.align-center.table-row-round').each((_, matchEl) => {
        const $match = $(matchEl);
        const localImg = $match.find('.team-box:first img').attr('src');
        const visitorImg = $match.find('.team-box:last img').attr('src');
        const score = $match.find('.marker a').text().trim();
        const link = $match.find('a').attr('href');
        
        details.stats.h2h.matches.push({
          localImage: localImg,
          visitorImage: visitorImg,
          score,
          url: link ? (link.startsWith('http') ? link : `https://www.besoccer.com${link}`) : null
        });
      });
      
      const winStats = h2hPanel.find('.row.jc-sa .box');
      if (winStats.length >= 3) {
        details.stats.h2h.wins.local = $(winStats[0]).find('.num').text().trim() || '0';
        details.stats.h2h.wins.draws = $(winStats[1]).find('.num').text().trim() || '0';
        details.stats.h2h.wins.visitor = $(winStats[2]).find('.num').text().trim() || '0';
      }
    }

    // استخراج أحداث المباراة من صفحة /events
    if (url.includes('/events')) {
      const eventsPanel = $('.match-events');
      if (eventsPanel.length) {
        // استخراج الأهداف
        eventsPanel.find('#events-goals .table-body .table-played-match').each((_, eventEl) => {
          const $event = $(eventEl);
          const minute = $event.find('.min').text().trim();
          const localPlayer = $event.find('.col-side.left .name').first().text().trim();
          const visitorPlayer = $event.find('.col-side.right .name').first().text().trim();
          
          if (localPlayer || visitorPlayer) {
            details.events.goals.push({
              minute,
              localPlayer,
              visitorPlayer
            });
          }
        });
        
        // استخراج البطاقات
        eventsPanel.find('#events-cards .table-body .table-played-match').each((_, eventEl) => {
          const $event = $(eventEl);
          const minute = $event.find('.min').text().trim();
          const localPlayer = $event.find('.col-side.left .name').first().text().trim();
          const visitorPlayer = $event.find('.col-side.right .name').first().text().trim();
          const cardType = $event.find('.event-wrapper img').first().attr('alt');
          
          if (localPlayer || visitorPlayer) {
            details.events.cards.push({
              minute,
              cardType,
              localPlayer,
              visitorPlayer
            });
          }
        });
      }
    }

  } catch (err) {
    // تجاهل الأخطاء في الاستخراج
  }

  return details;
}

// ================= جلب تفاصيل مباراة واحدة =================
async function fetchMatchDetails(matchUrl, matchId, matchName) {
  if (!matchUrl) return { fromPreview: null, fromEvents: null };
  
  if (matchUrl.includes('https://www.besoccer.comhttps://')) {
    matchUrl = matchUrl.replace('https://www.besoccer.comhttps://', 'https://www.besoccer.com/');
  }
  
  let baseUrl = matchUrl.replace(/\/preview$|\/events$/, '').replace(/\/$/, '');
  const previewUrl = `${baseUrl}/preview`;
  const eventsUrl = `${baseUrl}/events`;
  
  const result = {
    fromPreview: null,
    fromEvents: null
  };
  
  try {
    // جلب صفحة /preview
    try {
      const previewHtml = await ErrorHandler.retry(async () => {
        return await httpClient.get(previewUrl);
      });
      const $preview = cheerio.load(previewHtml);
      result.fromPreview = extractMatchDetailsFromUrl($preview, previewUrl);
    } catch (err) {
      // تجاهل فشل /preview
    }
    
    // جلب صفحة /events
    try {
      const eventsHtml = await ErrorHandler.retry(async () => {
        return await httpClient.get(eventsUrl);
      });
      const $events = cheerio.load(eventsHtml);
      result.fromEvents = extractMatchDetailsFromUrl($events, eventsUrl);
    } catch (err) {
      // تجاهل فشل /events
    }
    
  } catch (err) {
    // تجاهل الأخطاء العامة
  }
  
  return result;
}

// ================= استخراج جميع المباريات من الصفحة الرئيسية =================
function extractAllBasicMatches(html) {
  const $ = cheerio.load(html);

  const result = {
    metadata: {
      timestamp: new Date().toISOString(),
      url: CONFIG.URL,
      totalCompetitions: 0,
      totalMatches: 0,
      visibleMatches: 0,
      hiddenMatches: 0
    },
    competitions: [],
    statistics: {
      byStatus: { scheduled: 0, live: 0, finished: 0, postponed: 0, other: 0 },
      byCountry: {}
    }
  };

  $('#tableMatches .panel').each((_, panelEl) => {
    const competition = extractBasicCompetitionData($, panelEl);
    if (competition.matches.length > 0) {
      result.competitions.push(competition);
      result.metadata.totalMatches += competition.matches.length;
      result.metadata.visibleMatches += competition.visibleMatches;
      result.metadata.hiddenMatches += competition.hiddenMatches;

      competition.matches.forEach(match => {
        if (match.isLive) result.statistics.byStatus.live++;
        else if (match.status === 'finished') result.statistics.byStatus.finished++;
        else if (match.status === 'scheduled') result.statistics.byStatus.scheduled++;
        else if (match.status === 'postponed') result.statistics.byStatus.postponed++;
        else result.statistics.byStatus.other++;
      });

      if (competition.country) {
        result.statistics.byCountry[competition.country] = 
          (result.statistics.byCountry[competition.country] || 0) + competition.matches.length;
      }
    }
  });

  result.metadata.totalCompetitions = result.competitions.length;
  return result;
}

// ================= إزالة المباريات المكررة =================
function removeDuplicateMatches(basicData) {
  const seenUrls = new Set();
  
  basicData.competitions.forEach(comp => {
    comp.matches = comp.matches.filter(match => {
      if (!match.url) return true;
      if (seenUrls.has(match.url)) {
        return false;
      }
      seenUrls.add(match.url);
      return true;
    });
    
    comp.visibleMatches = comp.matches.filter(m => !m.isVmore).length;
    comp.hiddenMatches = comp.matches.filter(m => m.isVmore).length;
  });
  
  basicData.competitions = basicData.competitions.filter(comp => comp.matches.length > 0);
  basicData.metadata.totalMatches = basicData.competitions.reduce((sum, comp) => sum + comp.matches.length, 0);
  
  return basicData;
}

// ================= جلب تفاصيل جميع المباريات =================
async function fetchAllMatchesDetails(basicData) {
  console.log("\n📥 جلب تفاصيل جميع المباريات (قد يستغرق وقتاً)...");
  
  const allMatches = [];
  basicData.competitions.forEach(comp => {
    comp.matches.forEach(match => {
      if (match.url) {
        allMatches.push({
          id: match.matchId || match.id,
          url: match.url,
          name: `${match.homeTeam.name || 'فريق'} vs ${match.awayTeam.name || 'فريق'}`,
          competition: comp.name,
          basic: match
        });
      }
    });
  });
  
  console.log(`📊 جلب تفاصيل ${allMatches.length} مباراة`);
  
  const results = { successful: 0, failed: 0 };
  const limit = pLimit(CONFIG.CONCURRENT_LIMIT);
  
  const promises = allMatches.map((match, index) => 
    limit(async () => {
      try {
        console.log(`   🔄 جلب تفاصيل: ${match.name}`);
        const details = await fetchMatchDetails(match.url, match.id, match.name);
        if (details.fromPreview || details.fromEvents) {
          match.basic.details = details;
          results.successful++;
          console.log(`   ✅ اكتمل: ${match.name}`);
        } else {
          results.failed++;
          console.log(`   ⚠️ فشل: ${match.name}`);
        }
      } catch (err) {
        results.failed++;
        console.log(`   ❌ خطأ: ${match.name} - ${err.message}`);
      }
      
      // تأخير بين الطلبات
      await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_BETWEEN_REQUESTS));
      
      if ((index + 1) % 5 === 0) {
        console.log(`   📊 تقدم: ${index + 1}/${allMatches.length} مباراة (${results.successful} نجاح, ${results.failed} فشل)`);
      }
    })
  );
  
  await Promise.all(promises);
  console.log(`\n📊 النتيجة النهائية: ${results.successful} نجاح, ${results.failed} فشل من أصل ${allMatches.length}`);
  
  return results;
}

// ================= الدالة الرئيسية =================
async function main() {
  const startTime = Date.now();
  const isFirstRun = !fs.existsSync(CONFIG.OUTPUT_FILE);
  
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🏆 BeSoccer - ${isFirstRun ? 'أول تشغيل (جلب كل التفاصيل)' : 'تحديث دوري'} - ${new Date().toLocaleString('ar-EG')}`);
    console.log(`${'='.repeat(60)}`);
    
    // قراءة البيانات القديمة إذا وجدت
    let oldData = null;
    if (!isFirstRun) {
      try {
        const fileContent = await fs.promises.readFile(CONFIG.OUTPUT_FILE, 'utf8');
        oldData = JSON.parse(fileContent);
        console.log(`📂 تم تحميل البيانات السابقة (${oldData.metadata.totalMatches} مباراة)`);
      } catch (e) {
        console.log("⚠️ لا يمكن قراءة الملف السابق - سيتم إنشاء ملف جديد");
      }
    }
    
    // جلب الصفحة الرئيسية
    console.log("🌐 جلب الصفحة الرئيسية...");
    const mainHtml = await ErrorHandler.retry(async () => {
      return await httpClient.get(CONFIG.URL);
    });
    
    // استخراج البيانات الأساسية
    const basicData = extractAllBasicMatches(mainHtml);
    console.log(`📊 تم استخراج ${basicData.metadata.totalMatches} مباراة في ${basicData.metadata.totalCompetitions} بطولة`);
    console.log(`   - مباريات حية: ${basicData.statistics.byStatus.live}`);
    console.log(`   - مباريات منتهية: ${basicData.statistics.byStatus.finished}`);
    console.log(`   - مباريات مجدولة: ${basicData.statistics.byStatus.scheduled}`);
    
    // إزالة المباريات المكررة
    const cleanedData = removeDuplicateMatches(basicData);
    console.log(`🧹 بعد إزالة المكرر: ${cleanedData.metadata.totalMatches} مباراة فريدة`);
    
    let finalData;
    
    if (isFirstRun) {
      // أول تشغيل: جلب كل التفاصيل
      console.log("\n🔄 هذا هو أول تشغيل - سيتم جلب جميع التفاصيل...");
      const detailsResults = await fetchAllMatchesDetails(cleanedData);
      
      finalData = {
        metadata: {
          ...cleanedData.metadata,
          lastFullUpdate: new Date().toISOString(),
          timestamp: new Date().toISOString(),
          performance: {
            executionTimeMs: Date.now() - startTime,
            executionTimeSeconds: ((Date.now() - startTime) / 1000).toFixed(1),
            concurrentLimit: CONFIG.CONCURRENT_LIMIT
          },
          detailsFetched: {
            total: cleanedData.metadata.totalMatches,
            successful: detailsResults.successful,
            failed: detailsResults.failed,
            successRate: ((detailsResults.successful / cleanedData.metadata.totalMatches) * 100).toFixed(1)
          }
        },
        statistics: cleanedData.statistics,
        competitions: cleanedData.competitions
      };
      
      console.log(`\n✅ اكتمل الجلب الأول: ${detailsResults.successful} مباراة ناجحة من أصل ${cleanedData.metadata.totalMatches}`);
      
    } else {
      // تحديث دوري: دمج البيانات القديمة مع الجديدة
      console.log("\n🔄 تحديث دوري - دمج التفاصيل القديمة...");
      
      // دمج البيانات القديمة
      cleanedData.competitions.forEach(newComp => {
        const oldComp = oldData?.competitions?.find(c => c.name === newComp.name);
        if (oldComp) {
          newComp.matches.forEach(newMatch => {
            const oldMatch = oldComp.matches.find(m => m.id === newMatch.id);
            if (oldMatch && oldMatch.details) {
              newMatch.details = oldMatch.details;
            }
          });
        }
      });
      
      // جلب تفاصيل المباريات الحية فقط
      const liveMatches = [];
      cleanedData.competitions.forEach(comp => {
        comp.matches.forEach(match => {
          if (match.isLive || match.status === 'live' || match.statusText?.includes("'")) {
            liveMatches.push(match);
          }
        });
      });
      
      if (liveMatches.length > 0) {
        console.log(`📊 تحديث ${liveMatches.length} مباراة حية...`);
        const limit = pLimit(CONFIG.CONCURRENT_LIMIT);
        
        const livePromises = liveMatches.map(match => 
          limit(async () => {
            try {
              const details = await fetchMatchDetails(match.url, match.matchId, `${match.homeTeam.name} vs ${match.awayTeam.name}`);
              if (details.fromPreview || details.fromEvents) {
                match.details = details;
                match.lastUpdate = new Date().toISOString();
              }
            } catch (err) {
              // تجاهل الأخطاء
            }
            await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_BETWEEN_REQUESTS));
          })
        );
        
        await Promise.all(livePromises);
        console.log(`✅ تم تحديث المباريات الحية`);
      }
      
      finalData = {
        metadata: {
          ...cleanedData.metadata,
          lastFullUpdate: oldData?.metadata?.lastFullUpdate || oldData?.metadata?.timestamp || new Date().toISOString(),
          timestamp: new Date().toISOString(),
          performance: {
            executionTimeMs: Date.now() - startTime,
            executionTimeSeconds: ((Date.now() - startTime) / 1000).toFixed(1),
            concurrentLimit: CONFIG.CONCURRENT_LIMIT
          },
          updatedLiveMatches: liveMatches.length
        },
        statistics: cleanedData.statistics,
        competitions: cleanedData.competitions
      };
    }
    
    // حفظ الملف
    console.log("💾 حفظ الملف...");
    await fs.promises.writeFile(CONFIG.OUTPUT_FILE, JSON.stringify(finalData, null, 2), 'utf-8');
    
    const fileStats = fs.statSync(CONFIG.OUTPUT_FILE);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ تم الحفظ بنجاح!`);
    console.log(`📁 الملف: ${CONFIG.OUTPUT_FILE}`);
    console.log(`📊 الحجم: ${(fileStats.size / 1024).toFixed(2)} KB`);
    console.log(`⏱️  الوقت: ${finalData.metadata.performance.executionTimeSeconds} ثانية`);
    console.log(`📈 المباريات: ${finalData.metadata.totalMatches}`);
    console.log(`   - حية: ${finalData.statistics.byStatus.live}`);
    console.log(`   - مجدولة: ${finalData.statistics.byStatus.scheduled}`);
    console.log(`   - منتهية: ${finalData.statistics.byStatus.finished}`);
    if (finalData.metadata.detailsFetched) {
      console.log(`   - تفاصيل ناجحة: ${finalData.metadata.detailsFetched.successful}`);
      console.log(`   - نسبة النجاح: ${finalData.metadata.detailsFetched.successRate}%`);
    }
    console.log(`${'='.repeat(60)}`);
    
    // للاستخدام مع child_process
    if (process.send) {
      process.send({ type: 'update-complete', data: finalData });
    }
    
    return finalData;
    
  } catch (err) {
    console.error(`\n❌ خطأ فادح: ${err.message}`);
    
    // إذا فشل التحديث ولم يكن أول تشغيل، احتفظ بالبيانات القديمة
    if (!isFirstRun && fs.existsSync(CONFIG.OUTPUT_FILE)) {
      console.log("📂 الاحتفاظ بالبيانات القديمة");
    }
    
    throw err;
  }
}

// تصدير الدالة الرئيسية
export default main;

// تشغيل الدالة الرئيسية إذا تم استدعاؤها مباشرة
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("🚀 تشغيل BeSoccer كسكريبت مستقل...");
  main()
    .then(() => {
      console.log("✅ انتهى بنجاح");
      process.exit(0);
    })
    .catch(err => {
      console.error("❌ فشل:", err.message);
      process.exit(1);
    });
}