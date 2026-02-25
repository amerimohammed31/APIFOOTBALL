import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= الإعدادات المحسّنة فقط (نفس البيانات القديمة) =================
const CONFIG = {
  OUTPUT_FILE: path.join(__dirname, "./besoccer-complete-data.json"),
  URL: "https://www.besoccer.com/",
  TIMEOUT: 15000,
  CONCURRENT_LIMIT: 3, // تحسين: 3 مباريات في نفس الوقت
  DELAY_BETWEEN_REQUESTS: 1000, // تحسين: تقليل التأخير
  MAX_RETRIES: 3,
  USER_AGENTS: [ // تحسين: تبديل وكيل المستخدم
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
  ]
};

console.log("🚀 بدء تشغيل سكريبت BeSoccer (نسخة محسّنة مع الحفاظ على البيانات)...");
console.log(`📁 ملف الإخراج: ${CONFIG.OUTPUT_FILE}`);

// ================= فئة للتعامل مع الأخطاء (مع تحسين) =================
class ErrorHandler {
  static async retry(fn, retries = CONFIG.MAX_RETRIES, delay = 2000) {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err) {
        console.log(`   ⚠️ محاولة ${i + 1}/${retries} فشلت: ${err.message}`);
        if (i === retries - 1) throw err;
        
        // تحسين: زيادة التأخير مع كل محاولة فاشلة
        const backoffDelay = delay * Math.pow(2, i);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
    }
  }
}

// ================= عميل HTTP محسّن مع تبديل وكيل المستخدم =================
class HttpClient {
  constructor() {
    this.axiosInstance = axios.create({
      timeout: CONFIG.TIMEOUT,
      httpsAgent: new https.Agent({ keepAlive: true }),
      maxRedirects: 5
    });

    this.axiosInstance.interceptors.request.use(config => {
      config.headers = this.getHeaders();
      return config;
    });
  }

  getHeaders() {
    const userAgent = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
    
    return {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    };
  }

  async get(url) {
    try {
      const response = await this.axiosInstance.get(url);
      return response.data;
    } catch (err) {
      throw err;
    }
  }
}

const httpClient = new HttpClient();

// ================= دالة لتنظيف الرابط =================
function cleanUrl(url) {
  if (!url) return null;
  url = url.replace(/https?:\/\//g, '');
  url = url.replace(/www\./g, '');
  return `https://www.${url}`;
}

// ================= استخراج بيانات المباراة من الصفحة الرئيسية (نفس الكود القديم) =================
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
    details: {
      fromPreview: null,
      fromEvents: null
    }
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
    console.error(`   ⚠️ خطأ في استخراج بيانات المباراة الأساسية: ${err.message}`);
  }

  return matchData;
}

// ================= استخراج بيانات البطولة (نفس الكود القديم) =================
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
    console.error(`   ⚠️ خطأ في استخراج بيانات البطولة: ${err.message}`);
  }

  return competition;
}

// ================= استخراج تفاصيل المباراة (نفس الكود القديم كاملاً) =================
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
      offensive: { local: [], visitor: [] },
      featured: { local: [], visitor: [] },
      h2h: { matches: [], wins: { local: 0, draws: 0, visitor: 0 } },
      knockout: { firstLeg: null, secondLeg: null, global: null },
      squadValue: null,
      matchStats: null
    },
    injuries: { local: [], visitor: [] },
    goalsProgression: { local: [], visitor: [] },
    radar: { local: { values: [], color: null }, visitor: { values: [], color: null } },
    events: { goals: [], cards: [], substitutions: [], occasions: [], var: [] }
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

    // النتيجة الإجمالية
    const globalMatch = $('.global-match').first().text().trim();
    if (globalMatch) details.globalScore = globalMatch;

    // معلومات المباراة (الملعب، الحكم)
    const matchInfoPanel = $('.match-information');
    
    const stadiumLink = matchInfoPanel.find('a[href*="stadium"]');
    if (stadiumLink.length) {
      details.matchInfo.stadium.name = stadiumLink.text().trim();
      
      const stadiumPopup = $('#stadium');
      if (stadiumPopup.length) {
        details.matchInfo.stadium.image = stadiumPopup.find('img').attr('src') || null;
        details.matchInfo.stadium.address = stadiumPopup.find('.address').text().trim() || null;
        
        stadiumPopup.find('.table-row').each((_, row) => {
          const $row = $(row);
          const label = $row.find('div:first').text().trim();
          const value = $row.find('div:last').text().trim();
          if (label.includes('construction')) details.matchInfo.stadium.year = value;
          else if (label.includes('Capacity')) details.matchInfo.stadium.capacity = value;
          else if (label.includes('Size')) details.matchInfo.stadium.size = value;
        });
      }
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

    // ========== بيانات صفحة المعاينة /preview ==========
    
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
      
      const squadValue = $tab.find('.row.ta-c .col-2');
      if (squadValue.length >= 2) {
        details.stats.squadValue = {
          local: $(squadValue[0]).text().trim(),
          visitor: $(squadValue[1]).text().trim()
        };
      }
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
      
      $tab.find('table tbody tr').each((_, row) => {
        const $row = $(row);
        const label = $row.find('.text-label').text().trim();
        const leftValue = $row.find('.td-num.left .color-grey').first().text().trim();
        const leftRecord = $row.find('.td-num.left .record').text().trim();
        const rightValue = $row.find('.td-num.right').first().text().trim();
        const rightRecord = $row.find('.td-num.right .record').text().trim();
        
        if (label) {
          if (!details.stats.recentForm.streaks[context]) {
            details.stats.recentForm.streaks[context] = [];
          }
          details.stats.recentForm.streaks[context].push({
            label,
            local: { value: leftValue, record: leftRecord },
            visitor: { value: rightValue, record: rightRecord }
          });
        }
      });
    });

    // مرحلة خروج المغلوب
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
          url: link ? (link.startsWith('http') ? link : `https://www.besoccer.com${link}`) : null
        });
      });
      
      if (matches.length >= 2) {
        details.stats.knockout.firstLeg = matches[0];
        details.stats.knockout.secondLeg = matches[1];
      }
      
      const globalEl = knockoutPanel.find('.ta-c .result').last();
      if (globalEl.length) details.stats.knockout.global = globalEl.text().trim();
    }

    // المواجهات المباشرة
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
        
        details.stats.h2h.matches.push({
          localImage: localImg,
          visitorImage: visitorImg,
          localResult: localResult?.includes('win') ? 'win' : localResult?.includes('draw') ? 'draw' : 'lose',
          visitorResult: visitorResult?.includes('win') ? 'win' : visitorResult?.includes('draw') ? 'draw' : 'lose',
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

    // الإصابات والغيابات
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
          details.injuries[team].push({
            name,
            injury,
            chance,
            image: img,
            url: link ? (link.startsWith('http') ? link : `https://www.besoccer.com${link}`) : null
          });
        }
      });
    });

    // تقدم الأهداف
    $('.goals-progression .row.align-center').each((index, row) => {
      const $row = $(row);
      const isLocal = index === 0;
      const team = isLocal ? 'local' : 'visitor';
      
      $row.find('.bar').each((_, barEl) => {
        const $bar = $(barEl);
        const width = $bar.css('width');
        const number = $bar.find('.num').text().trim();
        const color = $bar.attr('class')?.split(' ').find(c => ['pink', 'orange', 'yellow', 'green', 'blue', 'purple'].includes(c));
        
        if (number) {
          details.goalsProgression[team].push({
            interval: color,
            count: number,
            percentage: width
          });
        }
      });
    });

    // المساهمة الهجومية
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
            if (!details.stats.offensive[team]) details.stats.offensive[team] = [];
            details.stats.offensive[team].push({
              context,
              name,
              image: img,
              url: link ? (link.startsWith('http') ? link : `https://www.besoccer.com${link}`) : null,
              assists: parseInt(assists) || 0,
              goals: parseInt(goals) || 0
            });
          }
        });
      });
    });

    // اللاعبين المميزين
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
            if (!details.stats.featured[team]) details.stats.featured[team] = [];
            details.stats.featured[team].push({
              context,
              category,
              name,
              value,
              image: img,
              url: link ? (link.startsWith('http') ? link : `https://www.besoccer.com${link}`) : null
            });
          }
        });
      });
    });

    // رادار النقاط
    const radarData = $('#radarChart').find('script').last().html();
    if (radarData) {
      const localMatch = radarData.match(/values: \[([^\]]+)\]/g);
      if (localMatch && localMatch.length >= 2) {
        details.radar.local.values = localMatch[0].match(/\d+/g)?.map(Number) || [];
        details.radar.visitor.values = localMatch[1].match(/\d+/g)?.map(Number) || [];
      }
      
      const colors = radarData.match(/#[0-9a-f]{6}/g);
      if (colors && colors.length >= 2) {
        details.radar.local.color = colors[0];
        details.radar.visitor.color = colors[1];
      }
    }

    // ========== بيانات صفحة الأحداث /events ==========
    
    // إحصائيات المباراة من صفحة الأحداث
    const matchStatsPanel = $('.panel.detail-match-stats.general-stats[data-cy="stats"]');
    if (matchStatsPanel.length) {
      details.stats.matchStats = {};
      
      matchStatsPanel.find('table tbody tr').each((_, row) => {
        const $row = $(row);
        const title = $row.find('.title b').text().trim();
        
        if (title) {
          details.stats.matchStats[title] = [];
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
              details.stats.matchStats.possession = {
                local: leftPercent,
                visitor: rightPercent
              };
            }
            
            if (label.includes('Total shots')) {
              details.stats.matchStats.shots = {
                local: leftValue,
                visitor: rightValue
              };
            }
            
            details.stats.matchStats[label] = {
              local: { value: leftValue, highlight: leftMark },
              visitor: { value: rightValue, highlight: rightMark }
            };
          }
        }
      });
    }

    // استخراج أحداث المباراة
    const eventsPanel = $('.match-events');
    if (eventsPanel.length) {
      
      // استخراج الأهداف
      eventsPanel.find('#events-goals .table-body .table-played-match').each((_, eventEl) => {
        const $event = $(eventEl);
        const minute = $event.find('.min').text().trim();
        const score = $event.find('.mini-result').text().trim();
        const localPlayer = $event.find('.col-side.left .name').first().text().trim();
        const visitorPlayer = $event.find('.col-side.right .name').first().text().trim();
        
        if (localPlayer || visitorPlayer) {
          details.events.goals.push({
            minute,
            score,
            localPlayer,
            visitorPlayer,
            type: $event.find('.event-wrapper img').first().attr('alt')
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
        const reason = $event.find('.color-grey2').text().trim();
        
        if (localPlayer || visitorPlayer) {
          details.events.cards.push({
            minute,
            cardType,
            reason,
            localPlayer,
            visitorPlayer
          });
        }
      });
      
      // استخراج التغييرات
      eventsPanel.find('#events-changes .table-body .table-played-match').each((_, eventEl) => {
        const $event = $(eventEl);
        const minute = $event.find('.min').text().trim();
        const localOut = $event.find('.col-side.left .name').first().text().trim();
        const localIn = $event.find('.col-side.left .color-grey2').first().text().trim();
        const visitorOut = $event.find('.col-side.right .name').first().text().trim();
        const visitorIn = $event.find('.col-side.right .color-grey2').first().text().trim();
        
        if (localOut || visitorOut) {
          details.events.substitutions.push({
            minute,
            local: localOut ? { out: localOut, in: localIn } : null,
            visitor: visitorOut ? { out: visitorOut, in: visitorIn } : null
          });
        }
      });
      
      // استخراج الفرص
      eventsPanel.find('#events-occasions .table-body .table-played-match').each((_, eventEl) => {
        const $event = $(eventEl);
        const minute = $event.find('.min').text().trim();
        const localPlayer = $event.find('.col-side.left .name').first().text().trim();
        const visitorPlayer = $event.find('.col-side.right .name').first().text().trim();
        
        if (localPlayer || visitorPlayer) {
          details.events.occasions.push({
            minute,
            localPlayer,
            visitorPlayer,
            type: $event.find('.event-wrapper img').first().attr('alt')
          });
        }
      });
      
      // استخراج VAR
      eventsPanel.find('#events-var .table-body .table-played-match').each((_, eventEl) => {
        const $event = $(eventEl);
        const minute = $event.find('.min').text().trim();
        const localPlayer = $event.find('.col-side.left .name').first().text().trim();
        const visitorPlayer = $event.find('.col-side.right .name').first().text().trim();
        
        if (localPlayer || visitorPlayer) {
          details.events.var.push({
            minute,
            localPlayer,
            visitorPlayer,
            decision: $event.find('.color-grey2').text().trim()
          });
        }
      });
    }

  } catch (err) {
    console.error(`   ⚠️ خطأ في استخراج التفاصيل: ${err.message}`);
  }

  return details;
}

// ================= جلب تفاصيل مباراة واحدة (محسّن للسرعة) =================
async function fetchMatchDetails(matchUrl, matchId, matchName) {
  if (matchUrl.includes('https://www.besoccer.comhttps://')) {
    matchUrl = matchUrl.replace('https://www.besoccer.comhttps://', 'https://www.besoccer.com/');
  }
  
  let baseUrl = matchUrl.replace(/\/preview$|\/events$/, '').replace(/\/$/, '');
  const previewUrl = `${baseUrl}/preview`;
  const eventsUrl = `${baseUrl}/events`;
  
  console.log(`   📥 جلب تفاصيل ${matchName}...`);
  
  const result = {
    fromPreview: null,
    fromEvents: null
  };
  
  // تحسين: جلب الرابطين بشكل متوازي
  const limit = pLimit(2);
  const promises = [
    limit(async () => {
      try {
        await ErrorHandler.retry(async () => {
          const response = await httpClient.get(previewUrl);
          const $ = cheerio.load(response);
          result.fromPreview = extractMatchDetailsFromUrl($, previewUrl);
          console.log(`      ✅ تم جلب /preview`);
        });
      } catch (err) {
        console.log(`      ⚠️ فشل /preview: ${err.message}`);
      }
    }),
    limit(async () => {
      try {
        await ErrorHandler.retry(async () => {
          const response = await httpClient.get(eventsUrl);
          const $ = cheerio.load(response);
          result.fromEvents = extractMatchDetailsFromUrl($, eventsUrl);
          console.log(`      ✅ تم جلب /events`);
        });
      } catch (err) {
        console.log(`      ⚠️ فشل /events: ${err.message}`);
      }
    })
  ];
  
  await Promise.all(promises);
  
  console.log(`   ✅ اكتمل جلب ${matchName}`);
  return result;
}

// ================= استخراج جميع المباريات من الصفحة الرئيسية =================
function extractAllBasicMatches(html) {
  console.log("🔍 تحليل الصفحة الرئيسية...");
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
        if (result.statistics.byStatus.hasOwnProperty(match.status)) {
          result.statistics.byStatus[match.status]++;
        } else {
          result.statistics.byStatus.other++;
        }
      });

      if (competition.country) {
        result.statistics.byCountry[competition.country] = 
          (result.statistics.byCountry[competition.country] || 0) + competition.matches.length;
      }
    }
  });

  result.metadata.totalCompetitions = result.competitions.length;

  console.log(`✅ تم استخراج: ${result.metadata.totalCompetitions} بطولة, ${result.metadata.totalMatches} مباراة`);
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
  
  console.log(`🧹 بعد إزالة المكرر: ${basicData.metadata.totalMatches} مباراة فريدة`);
  return basicData;
}

// ================= جلب تفاصيل جميع المباريات بشكل متوازي =================
async function fetchAllMatchesDetails(basicData) {
  console.log("\n📥 بدء جلب تفاصيل المباريات بشكل متوازي...");
  
  const allMatches = [];
  const seenUrls = new Set();
  
  basicData.competitions.forEach(comp => {
    comp.matches.forEach(match => {
      if (match.url && !seenUrls.has(match.url)) {
        seenUrls.add(match.url);
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
  
  console.log(`📊 جلب تفاصيل ${allMatches.length} مباراة (${CONFIG.CONCURRENT_LIMIT} مباراة في وقت واحد)`);
  
  const results = { successful: 0, failed: 0 };
  const limit = pLimit(CONFIG.CONCURRENT_LIMIT);
  
  const promises = allMatches.map((match, index) => 
    limit(async () => {
      console.log(`\n🔄 [${index + 1}/${allMatches.length}] ${match.name}`);
      
      try {
        const details = await fetchMatchDetails(match.url, match.id, match.name);
        
        if (details.fromPreview || details.fromEvents) {
          match.basic.details = details;
          results.successful++;
        } else {
          results.failed++;
        }
      } catch (err) {
        console.log(`   ❌ فشل: ${err.message}`);
        results.failed++;
      }
    })
  );
  
  await Promise.all(promises);
  return results;
}

// ================= الدالة الرئيسية =================
async function main() {
  console.log("=".repeat(70));
  console.log("🏆 BeSoccer - نسخة محسّنة (نفس البيانات + سرعة أعلى)");
  console.log("=".repeat(70));
  
  const startTime = Date.now();
  
  try {
    console.log("🌐 جلب الصفحة الرئيسية...");
    const mainHtml = await httpClient.get(CONFIG.URL);
    
    const basicData = extractAllBasicMatches(mainHtml);
    const cleanedData = removeDuplicateMatches(basicData);
    const detailsResults = await fetchAllMatchesDetails(cleanedData);
    
    const finalData = {
      metadata: {
        ...cleanedData.metadata,
        performance: {
          executionTimeMs: Date.now() - startTime,
          concurrentLimit: CONFIG.CONCURRENT_LIMIT,
          executionTimeMinutes: ((Date.now() - startTime) / 1000 / 60).toFixed(2)
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
    
    fs.writeFileSync(CONFIG.OUTPUT_FILE, JSON.stringify(finalData, null, 2), 'utf-8');
    
    const executionTime = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    
    console.log("\n" + "=".repeat(70));
    console.log("📊 التقرير النهائي:");
    console.log("=".repeat(70));
    console.log(`⏱️  وقت التنفيذ: ${executionTime} دقيقة`);
    console.log(`📁 الملف: ${CONFIG.OUTPUT_FILE}`);
    console.log(`✅ نسبة النجاح: ${finalData.metadata.detailsFetched.successRate}%`);
    console.log(`📊 المباريات: ${finalData.metadata.totalMatches} مباراة`);
    
  } catch (err) {
    console.error("\n💥 خطأ غير متوقع:", err);
  }
}

main();