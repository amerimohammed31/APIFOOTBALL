import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const FILE_PATH = path.resolve("./match-today.json");
const URL = "https://www.footmercato.net/live/";
const RETRY_COUNT = 3;
const TIMEOUT = 20000;

// ================= RETRY =================
async function fetchWithRetry(url, retries = RETRY_COUNT) {
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await axios.get(url, {
        timeout: TIMEOUT,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html",
        },
      });
      return data;
    } catch (err) {
      console.warn(`⚠️ Attempt ${i + 1} failed for ${url}: ${err.message}`);
      if (i === retries) throw err;
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
}

// ================= ADVANCED STATS EXTRACTION (بدون أي تغيير) =================
export const liveStatsCache = new Map();
export const preloadedStatsSet = new Set();

export async function fetchMatchStats(liveId) {
  if (!liveId) return {};
  const statsUrl = `https://www.footmercato.net/live/${liveId}/stats`;

  try {
    const data = await fetchWithRetry(statsUrl);
    const $ = cheerio.load(data);

    // ===== 1. HEAD TO HEAD HISTORY =====
    const headToHead = {
      totalMatches: 0,
      homeWins: 0,
      awayWins: 0,
      draws: 0,
      homeGoals: 0,
      awayGoals: 0,
      byCompetition: []
    };

    $(".matchTeamsHeadToHeadHistory .select__item").each((_, item) => {
      const competition = $(item).find(".select__itemLabel").text().trim();
      const matchesCount = $(item).find(".select__itemSubLabel").text().trim();
      
      const matches = matchesCount.match(/(\d+)/);
      
      headToHead.byCompetition.push({
        competition,
        matchesCount: matches ? parseInt(matches[1]) : 0,
        isActive: $(item).find(".select__itemButton").hasClass("active"),
        value: $(item).attr("data-value")
      });
    });

    $(".matchTeamsHeadToHeadHistory__gaugesHistory").each((_, gaugeContainer) => {
      const isVisible = !$(gaugeContainer).hasClass("hidden");
      const competitionData = [];
      
      $(gaugeContainer).find(".verticalPercentageBar").each((_, bar) => {
        const percent = $(bar).find(".verticalPercentageBar__gaugeOverlay").text().trim().replace('%', '');
        const legend = $(bar).find(".verticalPercentageBar__legend").text().trim();
        
        const winsMatch = legend.match(/(\d+)/);
        
        competitionData.push({
          percent: parseInt(percent) || 0,
          count: winsMatch ? parseInt(winsMatch[1]) : 0,
          type: legend.includes('Victoires') ? 'wins' : 'draws',
          team: legend.includes('9 Victoires') ? 'home' : (legend.includes('10 Victoires') ? 'away' : 'draw')
        });
      });
      
      if (isVisible) {
        headToHead.homeWins = competitionData.find(d => d.team === 'home')?.count || 0;
        headToHead.awayWins = competitionData.find(d => d.team === 'away')?.count || 0;
        headToHead.draws = competitionData.find(d => d.type === 'draws')?.count || 0;
        headToHead.totalMatches = headToHead.homeWins + headToHead.awayWins + headToHead.draws;
      }
    });

    // ===== 2. RECENT ENCOUNTERS =====
    const recentEncounters = [];
    
    $(".blockHorizontal__content--auto .matchSlim").each((_, match) => {
      const homeTeam = $(match).find(".matchSlim__team .matchTeam__name").first().text().trim();
      const awayTeam = $(match).find(".matchSlim__team .matchTeam__name").last().text().trim();
      const scoreText = $(match).find(".matchSlim__scores").text().trim();
      
      const scores = scoreText.match(/(\d+)\s*-\s*(\d+)/);
      
      recentEncounters.push({
        homeTeam,
        awayTeam,
        homeScore: scores ? parseInt(scores[1]) : null,
        awayScore: scores ? parseInt(scores[2]) : null,
        status: $(match).find(".timeline__value").text().trim(),
        link: $(match).find("a").attr("href"),
        highlighted: $(match).find(".matchSlim__score--highlight").length > 0
      });
    });

    // ===== 3. GOAL STATS =====
    const goalStats = {
      totalGoals: 68,
      distribution: [],
      matchAverages: [],
      scoringFrequency: [],
      goalsPerMatchThresholds: []
    };

    $(".blockVertical__contents .blockVertical__content").each((_, el) => {
      const title = $(el).find(".statInline__title").text().trim();
      
      const homeMain = $(el).find(".statInline__value").first().find(".statInline__valueMain").text().trim();
      const homeAdd = $(el).find(".statInline__value").first().find(".statInline__valueAdditional").text().trim();
      
      const awayMain = $(el).find(".statInline__value--right .statInline__valueMain").text().trim();
      const awayAdd = $(el).find(".statInline__value--right .statInline__valueAdditional").text().trim();
      
      goalStats.distribution.push({
        title,
        home: {
          main: homeMain,
          additional: homeAdd.replace(/[()]/g, '')
        },
        away: {
          main: awayMain,
          additional: awayAdd.replace(/[()]/g, '')
        }
      });
    });

    // ===== 4. TEAM FORMS =====
    const teamForms = {
      home: [],
      away: []
    };

    $(".teamsForm__team--home .gameResultStatus").each((_, result) => {
      teamForms.home.push($(result).text().trim());
    });

    $(".teamsForm__team--away .gameResultStatus").each((_, result) => {
      teamForms.away.push($(result).text().trim());
    });

    // ===== 5. LEAGUE STATS =====
    const leagueStats = [];
    
    $(".blockVertical__contents--wrappingBorder .blockVertical__content").each((_, el) => {
      const title = $(el).find(".statInline__title").text().trim();
      
      const homeValue = $(el).find(".statInline__value").first().find(".statInline__valueMain").text().trim();
      const awayValue = $(el).find(".statInline__value--right .statInline__valueMain").text().trim();
      
      let homeProgress = null;
      let awayProgress = null;
      
      $(el).find(".statInline__progressBarValue").each((i, bar) => {
        const style = $(bar).attr('style') || '';
        const widthMatch = style.match(/width:(\d+)%/);
        if (i === 0) homeProgress = widthMatch ? parseInt(widthMatch[1]) : null;
        if (i === 1) awayProgress = widthMatch ? parseInt(widthMatch[1]) : null;
      });
      
      leagueStats.push({
        title,
        home: homeValue,
        away: awayValue,
        homeProgress,
        awayProgress
      });
    });

    // ===== 6. GOALS BY TIME SEGMENTS =====
    const goalsByTime = {
      total: [],
      home: [],
      away: []
    };

    const tabs = ['taball', 'tabhome', 'tabaway'];
    
    tabs.forEach(tabId => {
      const tabData = [];
      $(`#${tabId} .statsPerSegments__item`).each((_, item) => {
        const title = $(item).find(".statVerticalBarGroup__title").text().trim();
        
        const homeValue = $(item).find(".statVerticalBarGroup__gaugeWrapper--home .statVerticalBarGroup__value").text().trim();
        const awayValue = $(item).find(".statVerticalBarGroup__gaugeWrapper--away .statVerticalBarGroup__value").text().trim();
        
        const homeHeight = $(item).find(".statVerticalBarGroup__gaugeWrapper--home .statVerticalBarGroup__gauge").attr('style') || '';
        const awayHeight = $(item).find(".statVerticalBarGroup__gaugeWrapper--away .statVerticalBarGroup__gauge").attr('style') || '';
        
        const homePercent = homeHeight.match(/height:(\d+)%/) ? parseInt(homeHeight.match(/height:(\d+)%/)[1]) : 0;
        const awayPercent = awayHeight.match(/height:(\d+)%/) ? parseInt(awayHeight.match(/height:(\d+)%/)[1]) : 0;
        
        tabData.push({
          segment: title,
          home: parseInt(homeValue) || 0,
          away: parseInt(awayValue) || 0,
          homePercent,
          awayPercent
        });
      });
      
      if (tabId === 'taball') goalsByTime.total = tabData;
      if (tabId === 'tabhome') goalsByTime.home = tabData;
      if (tabId === 'tabaway') goalsByTime.away = tabData;
    });

    // ===== 7. GOAL DISTRIBUTION STATS =====
    const goalDistribution = [];
    
    $(".blockVertical__contents--wrappingBorder").last().find(".blockVertical__content").each((_, el) => {
      const title = $(el).find(".statInline__title").text().trim();
      const homeMain = $(el).find(".statInline__value").first().find(".statInline__valueMain").text().trim();
      const awayMain = $(el).find(".statInline__value--right .statInline__valueMain").text().trim();
      
      goalDistribution.push({
        title,
        home: homeMain,
        away: awayMain
      });
    });

    // ===== 8. GOAL TYPES =====
    const goalTypes = {
      home: [],
      away: []
    };

    $(".goalsStatsByType").each((i, teamBlock) => {
      const teamName = $(teamBlock).find(".goalsStatsByType__team span").text().trim();
      const teamLogo = $(teamBlock).find(".goalsStatsByType__team img").attr('data-src') || '';
      
      const types = [];
      $(teamBlock).find(".horizontalPercentageBar").each((_, bar) => {
        const legend = $(bar).find(".horizontalPercentageBar__legend").text().trim();
        const percent = $(bar).find(".horizontalPercentageBar__percent").text().trim().replace('%', '');
        const value = $(bar).find(".horizontalPercentageBar__value").text().trim();
        const barWidth = $(bar).find(".horizontalPercentageBar__bar").attr('style') || '';
        const widthPercent = barWidth.match(/width:(\d+(?:\.\d+)?)%/) ? parseFloat(barWidth.match(/width:(\d+(?:\.\d+)?)%/)[1]) : 0;
        
        types.push({
          type: legend,
          percent: parseInt(percent) || 0,
          goals: parseInt(value) || 0,
          barWidth: widthPercent
        });
      });
      
      if (i === 0) goalTypes.home = { teamName, teamLogo, types };
      if (i === 1) goalTypes.away = { teamName, teamLogo, types };
    });

    // ===== 9. MATCH STATUS =====
    const matchStatus = {
      hasStarted: false,
      message: $(".message__title").text().trim() || "En attente des statistiques",
      description: $(".message__text").text().trim() || "Les statistiques sont communiquées après le début du match."
    };

    // ===== 10. RAW DATA ATTRIBUTES =====
    const rawDataAttributes = [];
    $("[data-live-id], [data-team], [data-type], [data-filter], [data-value]").each((_, el) => {
      const attribs = el.attribs || {};
      Object.keys(attribs).forEach((k) => {
        if (k.startsWith("data-")) {
          rawDataAttributes.push({ 
            element: el.name || 'unknown',
            key: k, 
            value: attribs[k] 
          });
        }
      });
    });

    // ===== 11. ACTIVE TABS =====
    const activeTabs = [];
    $(".filtersTabs__link.active").each((_, tab) => {
      activeTabs.push({
        name: $(tab).text().trim(),
        href: $(tab).attr('href') || ''
      });
    });

    const fullStats = {
      metadata: {
        url: statsUrl,
        liveId,
        extractedAt: new Date().toISOString(),
        hasMatchStarted: matchStatus.hasStarted,
        activeTabs
      },
      headToHead,
      recentEncounters,
      goalStats,
      teamForms,
      leagueStats,
      goalsByTime,
      goalDistribution,
      goalTypes,
      matchStatus,
      rawDataAttributes: rawDataAttributes.slice(0, 50),
      allDataExtracted: true
    };

    return fullStats;
    
  } catch (err) {
    console.error(`❌ Error fetching stats for liveId ${liveId}: ${err.message}`);
    return {
      error: err.message,
      metadata: {
        url: statsUrl,
        liveId,
        extractedAt: new Date().toISOString(),
        hasError: true
      }
    };
  }
}

// ================= MAIN FETCH (محدث لاستخراج كل البيانات من الصفحة الرئيسية) =================
export async function fetchMatchToday() {
  try {
    const data = await fetchWithRetry(URL);
    const $ = cheerio.load(data);
    const leagues = [];

    // استخراج معلومات الفلاتر من أعلى الصفحة
    const filters = [];
    $(".matchesFilters__itemList .matchesFilters__competition, .matchesFilters__area, .matchesFilters__channel").each((_, filterEl) => {
      const text = $(filterEl).attr("data-text") || "";
      const count = $(filterEl).find(".count").last().text().trim();
      const api = $(filterEl).find(".listItem__container").attr("data-api") || "";
      
      filters.push({
        name: text,
        matchesCount: count ? parseInt(count) : 0,
        apiUrl: api,
        type: $(filterEl).hasClass("matchesFilters__competition") ? "competition" : 
              $(filterEl).hasClass("matchesFilters__area") ? "area" : "channel"
      });
    });

    $(".matchesGroup").each((_, leagueEl) => {
      const leagueName = $(leagueEl).find(".title__leftLink").text().trim();
      const leagueLogo = $(leagueEl).find(".title__leftLink img").attr("data-src") || "";
      const leagueUrl = $(leagueEl).find(".title__leftLink").attr("href") || "";
      
      // استخراج رابط جدول الترتيب إذا وجد
      const rankingUrl = $(leagueEl).find(".matchesGroup__navigation a[href*='classement']").attr("href") || "";

      const matches = [];

      $(leagueEl)
        .find(".matchesGroup__match")
        .each((_, matchEl) => {
          const matchFull = $(matchEl).find(".matchFull");
          const liveId = matchFull.attr("data-live-id") || null;
          const liveValue = matchFull.attr("data-live-value") || "";
          const isLive = matchFull.attr("data-live") === "1";

          const homeEl = matchFull.find(".matchFull__team").first();
          const awayEl = matchFull.find(".matchFull__team--away");

          const homeScore = homeEl.find(".matchFull__score").text().trim();
          const awayScore = awayEl.find(".matchFull__score").text().trim();
          
          // استخراج حالة المباراة بالتفصيل
          let status = "scheduled";
          let matchMinute = null;
          let hasExtraTime = false;
          let isPenaltyShootout = false;
          
          if (liveValue) {
            if (liveValue.includes('playing')) {
              status = "live";
              const minuteMatch = liveValue.match(/playing\d*(\d+)'?/);
              if (minuteMatch) matchMinute = minuteMatch[1];
              if (liveValue.includes('MT')) matchMinute = "45";
              if (liveValue.includes('HT')) hasExtraTime = true;
              if (liveValue.includes('tab')) isPenaltyShootout = true;
            } else if (liveValue.includes('played')) {
              status = "finished";
            } else if (liveValue.includes('fixture')) {
              status = "scheduled";
            } else if (liveValue.includes('cancelled')) {
              status = "cancelled";
            } else if (liveValue.includes('postponed')) {
              status = "postponed";
            }
          } else {
            const playedText = matchFull.find(".matchFull__infosPlayed").text().toLowerCase();
            if (isLive) status = "live";
            else if (playedText.includes("termin")) status = "finished";
            else if (playedText.includes("report")) status = "postponed";
          }

          // استخراج تاريخ ووقت المباراة
          let matchDate = null;
          let matchTime = null;
          let matchDateTime = null;
          
          const timeElement = matchFull.find(".matchFull__infosDate time");
          if (timeElement.length) {
            const datetime = timeElement.attr("datetime");
            if (datetime) {
              matchDateTime = datetime;
              const dateObj = new Date(datetime);
              matchDate = dateObj.toISOString().split('T')[0];
              matchTime = timeElement.text().trim();
            }
          }

          // استخراج البطاقات
          const cards = { home: [], away: [] };
          
          homeEl.find(".matchTeam__card svg").each((_, card) => {
            const cardType = $(card).hasClass("colorRedCardSvg") ? "red" : "yellow";
            cards.home.push({ type: cardType });
          });
          
          awayEl.find(".matchTeam__card svg").each((_, card) => {
            const cardType = $(card).hasClass("colorRedCardSvg") ? "red" : "yellow";
            cards.away.push({ type: cardType });
          });

          // استخراج مؤشر الفوز
          const homeWinIndicator = homeEl.find(".matchFull__winIndicator").length > 0;
          const awayWinIndicator = awayEl.find(".matchFull__winIndicator").length > 0;

          // استخراج الأهداف مع تفاصيل أكثر
          const goals = { home: [], away: [] };

          matchFull
            .find(".matchFull__strikers--home .matchFull__striker")
            .each((_, g) => {
              const minuteText = $(g).find(".matchFull__strikerTime").text().trim();
              goals.home.push({
                player: $(g).find(".matchFull__strikerName").text().trim(),
                minute: minuteText,
                isOwnGoal: minuteText.includes('csc'),
                isPenalty: minuteText.includes('sp'),
                minuteValue: parseInt(minuteText.match(/\d+/)?.[0]) || null,
                isHighlighted: $(g).hasClass("matchFull__striker--highlight")
              });
            });

          matchFull
            .find(".matchFull__strikers--away .matchFull__striker")
            .each((_, g) => {
              const minuteText = $(g).find(".matchFull__strikerTime").text().trim();
              goals.away.push({
                player: $(g).find(".matchFull__strikerName").text().trim(),
                minute: minuteText,
                isOwnGoal: minuteText.includes('csc'),
                isPenalty: minuteText.includes('sp'),
                minuteValue: parseInt(minuteText.match(/\d+/)?.[0]) || null,
                isHighlighted: $(g).hasClass("matchFull__striker--highlight")
              });
            });

          // استخراج القنوات الناقلة
          const broadcasts = [];
          matchFull.find(".matchFull__broadcastImage").each((_, img) => {
            const src = $(img).attr("data-src") || $(img).attr("src");
            const alt = $(img).attr("alt") || "";
            if (src) broadcasts.push({ 
              logo: src, 
              name: alt,
              width: $(img).attr("width"),
              height: $(img).attr("height")
            });
          });

          // استخراج رابط المباراة
          const matchLink = matchFull.find(".matchFull__link").attr("href") || "";

          // استخراج معلومات إضافية
          const infosChrono = matchFull.find(".matchFull__infosChrono").text().trim();
          const infosPlayed = matchFull.find(".matchFull__infosPlayed").text().trim();
          const infosOther = matchFull.find(".matchFull__infosOther").text().trim();
          const isCancelled = matchFull.find(".matchFull__infosOther--cancelled").length > 0;
          
          // استخراج رابط الصفحة الكاملة للمباراة
          const matchPageUrl = matchFull.find("a").attr("href") || "";

          matches.push({
            // معرفات المباراة
            liveId,
            liveValue,
            matchPageUrl: matchPageUrl ? `https://www.footmercato.net${matchPageUrl}` : null,
            statsLink: liveId ? `https://www.footmercato.net/live/${liveId}/stats` : null,
            
            // معلومات الفريق المضيف
            homeTeam: {
              name: homeEl.find(".matchTeam__name").text().trim(),
              logo: homeEl.find("img").attr("data-src") || homeEl.find("img").attr("src") || "",
              score: homeScore || null,
              winIndicator: homeWinIndicator,
              cards: cards.home,
              hasRedCard: cards.home.some(c => c.type === "red"),
              hasYellowCard: cards.home.some(c => c.type === "yellow"),
            },
            
            // معلومات الفريق الضيف
            awayTeam: {
              name: awayEl.find(".matchTeam__name").text().trim(),
              logo: awayEl.find("img").attr("data-src") || awayEl.find("img").attr("src") || "",
              score: awayScore || null,
              winIndicator: awayWinIndicator,
              cards: cards.away,
              hasRedCard: cards.away.some(c => c.type === "red"),
              hasYellowCard: cards.away.some(c => c.type === "yellow"),
            },
            
            // نتيجة المباراة
            score: homeScore && awayScore ? `${homeScore} - ${awayScore}` : null,
            homeScore: homeScore ? parseInt(homeScore) : null,
            awayScore: awayScore ? parseInt(awayScore) : null,
            
            // حالة المباراة
            status,
            matchMinute,
            hasExtraTime,
            isPenaltyShootout,
            isLive,
            isCancelled,
            
            // تاريخ ووقت المباراة
            matchDate,
            matchTime,
            matchDateTime,
            
            // أهداف المباراة
            goals,
            totalGoals: goals.home.length + goals.away.length,
            
            // القنوات الناقلة
            broadcasts,
            hasBroadcast: broadcasts.length > 0,
            
            // معلومات إضافية
            additionalInfo: {
              chrono: infosChrono,
              played: infosPlayed,
              other: infosOther,
            },
            
            // البيانات الخام
            rawHTML: matchFull.html(),
            attributes: matchFull.get(0)?.attribs || {},
            rawText: matchFull.text().trim(),
          });
        });

      // تصفية البطولات غير المرغوب فيها (نفس الشيء)
      const blockedKeywords = ["amicaux", "friendly", "club friendlies"];
      const normalizedLeagueName = (leagueName || "").toLowerCase();

      if (
        matches.length > 0 &&
        !blockedKeywords.some((keyword) =>
          normalizedLeagueName.includes(keyword)
        )
      ) {
        leagues.push({ 
          leagueName, 
          leagueLogo, 
          leagueUrl: leagueUrl ? `https://www.footmercato.net${leagueUrl}` : null,
          rankingUrl: rankingUrl ? `https://www.footmercato.net${rankingUrl}` : null,
          matchesCount: matches.length,
          matches 
        });
      }
    });

    // إضافة معلومات إضافية عن الصفحة الرئيسية
    const pageInfo = {
      title: $("title").text().trim(),
      totalLeagues: leagues.length,
      totalMatches: leagues.reduce((acc, league) => acc + league.matches.length, 0),
      liveMatches: leagues.reduce((acc, league) => 
        acc + league.matches.filter(m => m.isLive).length, 0),
      scheduledMatches: leagues.reduce((acc, league) => 
        acc + league.matches.filter(m => m.status === "scheduled").length, 0),
      finishedMatches: leagues.reduce((acc, league) => 
        acc + league.matches.filter(m => m.status === "finished").length, 0),
      filters: filters.slice(0, 50), // الحد من الكمية
      extractedAt: new Date().toISOString()
    };

    // ================= Assign stats (نفس الطريقة القديمة) =================
    for (const league of leagues) {
      for (const match of league.matches) {
        if (match.isLive) {
          console.log(`🎯 Fetching LIVE stats for ${match.homeTeam.name} vs ${match.awayTeam.name}`);
          match.stats = await fetchMatchStats(match.liveId);
          liveStatsCache.set(match.liveId, match.stats);
          preloadedStatsSet.add(match.liveId);
        } else if (match.status === "scheduled") {
          if (!preloadedStatsSet.has(match.liveId)) {
            console.log(`📅 Pre-loading stats for scheduled match: ${match.homeTeam.name} vs ${match.awayTeam.name}`);
            match.stats = await fetchMatchStats(match.liveId);
            liveStatsCache.set(match.liveId, match.stats);
            preloadedStatsSet.add(match.liveId);
          } else {
            match.stats = liveStatsCache.get(match.liveId) || null;
          }
        } else if (match.status === "finished") {
          match.stats = liveStatsCache.get(match.liveId) || null;
        }
      }
    }

    // حفظ البيانات مع معلومات الصفحة
    const outputData = {
      pageInfo,
      leagues
    };

    fs.writeFileSync(FILE_PATH, JSON.stringify(outputData, null, 2), "utf8");
    console.log("✅ FULL ULTRA DATA SAVED WITH COMPREHENSIVE STATS");
    console.log(`📊 Summary: ${pageInfo.totalMatches} matches (${pageInfo.liveMatches} live, ${pageInfo.scheduledMatches} scheduled, ${pageInfo.finishedMatches} finished)`);

    return outputData;
  } catch (err) {
    console.error("❌ Error fetching Match-Today:", err.message);
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchMatchToday();
}