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

// ================= ADVANCED STATS EXTRACTION =================
export const liveStatsCache = new Map();
export const preloadedStatsSet = new Set();

export async function fetchMatchStats(liveId) {
  if (!liveId) return {};
  const statsUrl = `https://www.footmercato.net/live/${liveId}/stats`;

  try {
    const data = await fetchWithRetry(statsUrl);
    const $ = cheerio.load(data);

    // ===== 1. HEAD TO HEAD HISTORY (Historique des confrontations) =====
    const headToHead = {
      totalMatches: 0,
      homeWins: 0,
      awayWins: 0,
      draws: 0,
      homeGoals: 0,
      awayGoals: 0,
      byCompetition: []
    };

    // استخراج الإحصائيات الإجمالية من شريط التحديد (select)
    $(".matchTeamsHeadToHeadHistory .select__item").each((_, item) => {
      const competition = $(item).find(".select__itemLabel").text().trim();
      const matchesCount = $(item).find(".select__itemSubLabel").text().trim();
      
      // البحث عن الرقم بين قوسين مثل "27 matchs"
      const matches = matchesCount.match(/(\d+)/);
      
      headToHead.byCompetition.push({
        competition,
        matchesCount: matches ? parseInt(matches[1]) : 0,
        isActive: $(item).find(".select__itemButton").hasClass("active"),
        value: $(item).attr("data-value")
      });
    });

    // استخراج نسب الفوز من الـ gauges
    $(".matchTeamsHeadToHeadHistory__gaugesHistory").each((_, gaugeContainer) => {
      const isVisible = !$(gaugeContainer).hasClass("hidden");
      const competitionData = [];
      
      $(gaugeContainer).find(".verticalPercentageBar").each((_, bar) => {
        const percent = $(bar).find(".verticalPercentageBar__gaugeOverlay").text().trim().replace('%', '');
        const legend = $(bar).find(".verticalPercentageBar__legend").text().trim();
        
        // استخراج عدد الانتصارات من النص مثل "9 Victoires"
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

    // ===== 2. RECENT ENCOUNTERS (Dernières confrontations) =====
    const recentEncounters = [];
    
    $(".blockHorizontal__content--auto .matchSlim").each((_, match) => {
      const homeTeam = $(match).find(".matchSlim__team .matchTeam__name").first().text().trim();
      const awayTeam = $(match).find(".matchSlim__team .matchTeam__name").last().text().trim();
      const scoreText = $(match).find(".matchSlim__scores").text().trim();
      
      // استخراج النتيجة مثل "1-0" أو "3-1"
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

    // ===== 3. GOAL STATS FROM 68 GOALS (Stats des 68 buts) =====
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

    // ===== 4. TEAM FORMS (Séries en cours) =====
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

    // ===== 5. LEAGUE STATS (Stats globales en championnat) =====
    const leagueStats = [];
    
    $(".blockVertical__contents--wrappingBorder .blockVertical__content").each((_, el) => {
      const title = $(el).find(".statInline__title").text().trim();
      
      const homeValue = $(el).find(".statInline__value").first().find(".statInline__valueMain").text().trim();
      const awayValue = $(el).find(".statInline__value--right .statInline__valueMain").text().trim();
      
      // إضافة قيم الـ progress bars إذا وجدت
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

    // ===== 6. GOALS BY TIME SEGMENTS (Buts/tranches) =====
    const goalsByTime = {
      total: [],
      home: [],
      away: []
    };

    // استخراج بيانات كل تبويب (Total, Domicile, Extérieur)
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

    // ===== 7. GOAL DISTRIBUTION STATS (Répartition des buts) =====
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

    // ===== 8. GOAL TYPES (Types de buts) =====
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

    // ===== 9. MATCH STATUS (Le match - temporairement vide) =====
    const matchStatus = {
      hasStarted: false,
      message: $(".message__title").text().trim() || "En attente des statistiques",
      description: $(".message__text").text().trim() || "Les statistiques sont communiquées après le début du match."
    };

    // ===== 10. RAW DATA ATTRIBUTES (كل السمات data-*) =====
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

    // ===== 11. ACTIVE TABS (التبويبات النشطة) =====
    const activeTabs = [];
    $(".filtersTabs__link.active").each((_, tab) => {
      activeTabs.push({
        name: $(tab).text().trim(),
        href: $(tab).attr('href') || ''
      });
    });

    // بناء الكائن النهائي
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
      rawDataAttributes: rawDataAttributes.slice(0, 50), // تحد من الكمية
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

// ================= MAIN FETCH =================
export async function fetchMatchToday() {
  try {
    const data = await fetchWithRetry(URL);
    const $ = cheerio.load(data);
    const leagues = [];

    $(".matchesGroup").each((_, leagueEl) => {
      const leagueName = $(leagueEl).find(".title__leftLink").text().trim();
      const leagueLogo = $(leagueEl).find(".title__leftLink img").attr("data-src") || "";

      const matches = [];

      $(leagueEl)
        .find(".matchesGroup__match")
        .each((_, matchEl) => {
          const matchFull = $(matchEl).find(".matchFull");
          const liveId = matchFull.attr("data-live-id") || null;

          const homeEl = matchFull.find(".matchFull__team").first();
          const awayEl = matchFull.find(".matchFull__team--away");

          const homeScore = homeEl.find(".matchFull__score").text().trim();
          const awayScore = awayEl.find(".matchFull__score").text().trim();

          const isLive = matchFull.attr("data-live") === "1";
          const playedText = matchFull
            .find(".matchFull__infosPlayed")
            .text()
            .toLowerCase();

          let status = "scheduled";
          if (isLive) status = "live";
          else if (playedText.includes("termin")) status = "finished";

          const goals = { home: [], away: [] };

          matchFull
            .find(".matchFull__strikers--home .matchFull__striker")
            .each((_, g) => {
              goals.home.push({
                player: $(g).find(".matchFull__strikerName").text().trim(),
                minute: $(g).find(".matchFull__strikerTime").text().trim(),
              });
            });

          matchFull
            .find(".matchFull__strikers--away .matchFull__striker")
            .each((_, g) => {
              goals.away.push({
                player: $(g).find(".matchFull__strikerName").text().trim(),
                minute: $(g).find(".matchFull__strikerTime").text().trim(),
              });
            });

          const broadcasts = [];
          matchFull.find(".matchFull__broadcastImage").each((_, img) => {
            const src = $(img).attr("data-src");
            if (src) broadcasts.push(src);
          });

          matches.push({
            liveId,
            statsLink: liveId
              ? `https://www.footmercato.net/live/${liveId}/stats`
              : null,
            homeTeam: {
              name: homeEl.find(".matchTeam__name").text().trim(),
              logo: homeEl.find("img").attr("data-src") || "",
            },
            awayTeam: {
              name: awayEl.find(".matchTeam__name").text().trim(),
              logo: awayEl.find("img").attr("data-src") || "",
            },
            score:
              homeScore && awayScore ? `${homeScore} - ${awayScore}` : null,
            status,
            isLive,
            goals,
            broadcasts,
            rawHTML: matchFull.html(),
            attributes: matchFull.get(0)?.attribs || {},
            rawText: matchFull.text().trim(),
          });
        });

      const blockedKeywords = ["amicaux", "friendly", "club friendlies"];
      const normalizedLeagueName = (leagueName || "").toLowerCase();

      if (
        matches.length > 0 &&
        !blockedKeywords.some((keyword) =>
          normalizedLeagueName.includes(keyword)
        )
      ) {
        leagues.push({ leagueName, leagueLogo, matches });
      }
    });

    // ================= Assign stats =================
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

    fs.writeFileSync(FILE_PATH, JSON.stringify(leagues, null, 2), "utf8");
    console.log("✅ FULL ULTRA DATA SAVED WITH COMPREHENSIVE STATS");

    return leagues;
  } catch (err) {
    console.error("❌ Error fetching Match-Today:", err.message);
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchMatchToday();
}