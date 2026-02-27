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
  
  // تهيئة كائن النتائج النهائي
  const fullStats = {
    metadata: {
      liveId,
      extractedAt: new Date().toISOString(),
    },
    headToHead: {},
    recentEncounters: [],
    teamForms: {},
    leagueStats: {},
    goalsByTime: {},
    goalTypes: {},
    formation: {},
    coaches: [],
    substitutes: [],
    injuries: [],
    playersStats: []
  };

  try {
    // ================= تجلب بيانات صفحة الإحصائيات (/stats) =================
    const statsUrl = `https://www.footmercato.net/live/${liveId}/stats`;
    console.log(`📊 Fetching stats from: ${statsUrl}`);
    
    const statsData = await fetchWithRetry(statsUrl);
    const $stats = cheerio.load(statsData);

    // ----- 1. HEAD TO HEAD HISTORY (تاريخ المواجهات) -----
    const headToHead = {
      totalMatches: 0,
      homeWins: 0,
      awayWins: 0,
      draws: 0,
      byCompetition: []
    };

    // استخراج بيانات المسابقات المختلفة
    $stats(".select__item").each((_, item) => {
      const competition = $stats(item).find(".select__itemLabel").text().trim();
      const matchesText = $stats(item).find(".select__itemSubLabel").text().trim();
      const matchesMatch = matchesText.match(/(\d+)/);
      
      headToHead.byCompetition.push({
        competition,
        matchesCount: matchesMatch ? parseInt(matchesMatch[1]) : 0,
        isActive: $stats(item).hasClass("active"),
        value: $stats(item).attr("data-value")
      });
    });

    // استخراج الإحصائيات الإجمالية
    $stats(".matchTeamsHeadToHeadHistory__gaugesHistory").each((_, gauge) => {
      if (!$stats(gauge).hasClass("hidden")) {
        const bars = [];
        $stats(gauge).find(".verticalPercentageBar").each((_, bar) => {
          const percent = $stats(bar).find(".verticalPercentageBar__gaugeOverlay").text().trim().replace('%', '');
          const legend = $stats(bar).find(".verticalPercentageBar__legend").text().trim();
          const countMatch = legend.match(/(\d+)/);
          
          bars.push({
            percent: parseInt(percent) || 0,
            count: countMatch ? parseInt(countMatch[1]) : 0,
            legend
          });
        });
        
        // افتراض أن الترتيب: [homeWins, draws, awayWins]
        if (bars.length >= 3) {
          headToHead.homeWins = bars[0].count;
          headToHead.draws = bars[1].count;
          headToHead.awayWins = bars[2].count;
          headToHead.totalMatches = bars[0].count + bars[1].count + bars[2].count;
        }
      }
    });

    fullStats.headToHead = headToHead;

    // ----- 2. RECENT ENCOUNTERS (آخر المواجهات) -----
    const recentEncounters = [];
    $stats(".blockHorizontal__content--auto .matchSlim").each((_, match) => {
      const homeTeam = $stats(match).find(".matchSlim__team .matchTeam__name").first().text().trim();
      const awayTeam = $stats(match).find(".matchSlim__team .matchTeam__name").last().text().trim();
      const scores = $stats(match).find(".matchSlim__scores").text().trim();
      const scoreMatch = scores.match(/(\d+)\s*-\s*(\d+)/);
      
      recentEncounters.push({
        homeTeam,
        awayTeam,
        homeScore: scoreMatch ? parseInt(scoreMatch[1]) : null,
        awayScore: scoreMatch ? parseInt(scoreMatch[2]) : null,
        status: $stats(match).find(".timeline__value").text().trim(),
        link: $stats(match).find("a").attr("href"),
        isHighlighted: $stats(match).find(".matchSlim__score--highlight").length > 0
      });
    });
    fullStats.recentEncounters = recentEncounters;

    // ----- 3. TEAM FORMS (آخر 5 مباريات) -----
    const teamForms = { home: [], away: [] };
    
    $stats(".matchResultSeries a").each((i, result) => {
      const teamClass = $stats(result).closest(".blockSingle").find(".title__left").text().trim();
      const resultType = $stats(result).hasClass("matchResult--win") ? "win" : 
                        $stats(result).hasClass("matchResult--draw") ? "draw" : "loss";
      const score = $stats(result).find(".matchResult__score").text().trim();
      const logo = $stats(result).find("img").attr("data-src") || "";
      
      const resultObj = { type: resultType, score, logo };
      
      if (teamClass.includes("Sporting")) teamForms.home.push(resultObj);
      else if (teamClass.includes("Estoril")) teamForms.away.push(resultObj);
    });
    fullStats.teamForms = teamForms;

    // ----- 4. LEAGUE STATS (إحصائيات عامة في الدوري) -----
    const leagueStats = [];
    $stats(".blockVertical__contents--wrappingBorder .blockVertical__content").each((_, el) => {
      const title = $stats(el).find(".statInline__title").text().trim();
      const homeValue = $stats(el).find(".statInline__value").first().find(".statInline__valueMain").text().trim();
      const awayValue = $stats(el).find(".statInline__value--right .statInline__valueMain").text().trim();
      
      // استخراج نسب التقدم
      let homeProgress = null, awayProgress = null;
      $stats(el).find(".statInline__progressBarValue").each((i, bar) => {
        const style = $stats(bar).attr('style') || '';
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
    fullStats.leagueStats = leagueStats;

    // ----- 5. GOALS BY TIME SEGMENTS (الأهداف حسب الوقت) -----
    const goalsByTime = { total: [], home: [], away: [] };
    
    ["taball", "tabhome", "tabaway"].forEach(tabId => {
      const tabData = [];
      $stats(`#${tabId} .statsPerSegments__item`).each((_, item) => {
        const segment = $stats(item).find(".statVerticalBarGroup__title").text().trim();
        const homeValue = $stats(item).find(".statVerticalBarGroup__gaugeWrapper--home .statVerticalBarGroup__value").text().trim();
        const awayValue = $stats(item).find(".statVerticalBarGroup__gaugeWrapper--away .statVerticalBarGroup__value").text().trim();
        
        tabData.push({
          segment,
          home: parseInt(homeValue) || 0,
          away: parseInt(awayValue) || 0
        });
      });
      
      if (tabId === 'taball') goalsByTime.total = tabData;
      if (tabId === 'tabhome') goalsByTime.home = tabData;
      if (tabId === 'tabaway') goalsByTime.away = tabData;
    });
    fullStats.goalsByTime = goalsByTime;

    // ----- 6. GOAL TYPES (أنواع الأهداف) -----
    const goalTypes = { home: [], away: [] };
    
    $stats(".goalsStatsByType").each((i, teamBlock) => {
      const teamName = $stats(teamBlock).find(".goalsStatsByType__team span").text().trim();
      const types = [];
      
      $stats(teamBlock).find(".horizontalPercentageBar").each((_, bar) => {
        const legend = $stats(bar).find(".horizontalPercentageBar__legend").text().trim();
        const percent = $stats(bar).find(".horizontalPercentageBar__percent").text().trim().replace('%', '');
        const goals = $stats(bar).find(".horizontalPercentageBar__value").text().trim();
        
        types.push({
          type: legend,
          percent: parseInt(percent) || 0,
          goals: parseInt(goals) || 0
        });
      });
      
      if (i === 0) goalTypes.home = { teamName, types };
      if (i === 1) goalTypes.away = { teamName, types };
    });
    fullStats.goalTypes = goalTypes;

    // ----- 7. PLAYERS STATS (إحصائيات اللاعبين) -----
    const playersStats = [];
    $stats("#statsTable tbody tr").each((_, row) => {
      if ($stats(row).find("td").length > 1) {
        const playerLink = $stats(row).find("a[href*='/joueur/']").first();
        const playerHref = playerLink.attr("href");
        const playerId = playerHref ? playerHref.split('/').pop() : null;
        
        playersStats.push({
          rank: $stats(row).find("td").eq(0).text().trim(),
          rating: $stats(row).find(".rating").first().text().trim(),
          player: {
            name: $stats(row).find(".personCardCell__name").first().text().trim(),
            link: playerHref,
            id: playerId,
            nationality: $stats(row).find(".personCardCell__nationalities img").last().attr('data-src')
          },
          team: $stats(row).find("td").eq(3).text().trim(),
          selection: $stats(row).find("td").eq(4).text().trim(),
          matches: parseInt($stats(row).find("td").eq(5).text().trim()) || 0,
          minutes: parseInt($stats(row).find("td").eq(6).text().trim()) || 0,
          goals: parseInt($stats(row).find("td").eq(7).text().trim()) || 0,
          assists: parseInt($stats(row).find("td").eq(8).text().trim()) || 0,
          substitutionIn: parseInt($stats(row).find("td").eq(9).text().trim()) || 0,
          substitutionOut: parseInt($stats(row).find("td").eq(10).text().trim()) || 0,
          interceptions: parseInt($stats(row).find("td").eq(11).text().trim()) || 0,
          tackles: parseInt($stats(row).find("td").eq(12).text().trim()) || 0
        });
      }
    });
    fullStats.playersStats = playersStats;

    // ================= تجلب بيانات صفحة التشكيلة (/formation) =================
    const formationUrl = `https://www.footmercato.net/live/${liveId}/formation`;
    console.log(`📋 Fetching formation from: ${formationUrl}`);
    
    const formationData = await fetchWithRetry(formationUrl);
    const $formation = cheerio.load(formationData);

    // ----- 8. MATCH FORMATIONS (تشكيلة المباراة) -----
    const formation = {
      home: {
        name: "",
        formation: "",
        players: []
      },
      away: {
        name: "",
        formation: "",
        players: []
      }
    };

    // استخراج اسم الفريق والتشكيلة
    $formation(".title").each((i, title) => {
      const teamName = $formation(title).find(".title__leftLink").text().trim();
      const teamFormation = $formation(title).find(".title__textBig").text().trim();
      
      if (i === 0) {
        formation.home.name = teamName;
        formation.home.formation = teamFormation;
      } else if (i === 1) {
        formation.away.name = teamName;
        formation.away.formation = teamFormation;
      }
    });

    // استخراج اللاعبين الأساسيين
    $formation(".teamFormation__line .matchTeamPlayer").each((_, player) => {
      const playerLink = $formation(player).attr("data-api") || 
                        $formation(player).find("a").attr("href") ||
                        $formation(player).attr("href");
      
      const playerHref = playerLink ? playerLink.match(/matchTeamsPlayersIds%5B0%5D=(\d+)/) : null;
      const playerId = playerHref ? playerHref[1] : null;
      
      const team = $formation(player).closest(".teamFormation").hasClass("teamFormation--reverse") ? "away" : "home";
      
      const playerData = {
        number: $formation(player).find(".matchTeamPlayer__number").text().trim(),
        name: $formation(player).find(".matchTeamPlayer__name").text().trim(),
        rating: $formation(player).find(".rating").text().trim(),
        isCaptain: $formation(player).find(".matchTeamPlayer__indicator--captain").length > 0,
        hasGoal: $formation(player).find(".matchTeamPlayer__indicator--goal").length > 0,
        hasAssist: $formation(player).find(".matchTeamPlayer__indicator--assist").length > 0,
        hasYellowCard: $formation(player).find(".colorYellowCardSvg").length > 0,
        isSubstituted: $formation(player).find(".matchTeamPlayer__indicator--substitution").length > 0,
        playerId: playerId,
        goalsCount: $formation(player).find(".matchTeamPlayer__count").text().trim().replace('X', '') || null,
        minuteSubstituted: $formation(player).find(".matchTeamPlayer__indicator--substitution").length > 0 ? 
                          $formation(player).find(".personCard__extraUp").text().match(/(\d+)/)?.[1] : null
      };
      
      if (team === "home") {
        formation.home.players.push(playerData);
      } else {
        formation.away.players.push(playerData);
      }
    });
    fullStats.formation = formation;

    // ----- 9. COACHES (المدربين) -----
    const coaches = [];
    $formation(".personCardTeamsList__team").each((_, team) => {
      const coachLink = $formation(team).find("a[href*='/entraineur/']");
      if (coachLink.length) {
        coaches.push({
          name: coachLink.find(".personCard__name").text().trim(),
          role: coachLink.find(".personCard__description").text().trim(),
          link: coachLink.attr("href"),
          nationality: coachLink.find(".personCard__extra img").attr("data-src")
        });
      }
    });
    fullStats.coaches = coaches;

    // ----- 10. SUBSTITUTES (البدلاء) -----
    const substitutes = { home: [], away: [] };
    $formation(".personCardTeamsList__teams .personCardTeamsList__team").each((i, team) => {
      const teamType = i === 0 ? "home" : "away";
      
      $formation(team).find(".personCard").each((_, player) => {
        if (!$formation(player).find(".matchTeamPlayer").length) { // تجنب تكرار اللاعبين الأساسيين
          const minuteMatch = $formation(player).find(".personCard__extraUp").text().match(/(\d+)/);
          
          substitutes[teamType].push({
            name: $formation(player).find(".personCard__name").text().trim(),
            position: $formation(player).find(".personCard__description").text().trim(),
            link: $formation(player).attr("href"),
            minuteEntered: minuteMatch ? parseInt(minuteMatch[1]) : null,
            hasGoal: $formation(player).find(".personCard__extraDown svg[viewBox*='goal']").length > 0,
            hasAssist: $formation(player).find(".personCard__extraDown svg[viewBox*='assist']").length > 0
          });
        }
      });
    });
    fullStats.substitutes = substitutes;

    // ----- 11. INJURIES (الإصابات) -----
    const injuries = [];
    $formation(".personCardTeamsList .personCard").each((_, player) => {
      if ($formation(player).find(".personCard__injuryPicto").length) {
        injuries.push({
          name: $formation(player).find(".personCard__name").text().trim(),
          description: $formation(player).find(".personCard__description").text().trim(),
          link: $formation(player).attr("href"),
          injuryType: $formation(player).find(".personCard__injurySeverity").hasClass("personCard__injurySeverity--badly") ? "bad" : "unknown"
        });
      }
    });
    fullStats.injuries = injuries;

    return fullStats;
    
  } catch (err) {
    console.error(`❌ Error fetching stats for liveId ${liveId}: ${err.message}`);
    return {
      ...fullStats,
      error: err.message,
      metadata: {
        ...fullStats.metadata,
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
            formationLink: liveId
              ? `https://www.footmercato.net/live/${liveId}/formation`
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

    // ================= جلب البيانات المتقدمة لكل مباراة =================
    for (const league of leagues) {
      for (const match of league.matches) {
        if (match.isLive || match.status === "scheduled" || match.status === "finished") {
          console.log(`🎯 Fetching comprehensive data for ${match.homeTeam.name} vs ${match.awayTeam.name} (${match.status})`);
          
          // التحقق من وجود البيانات في الكاش أولاً
          if (liveStatsCache.has(match.liveId)) {
            match.stats = liveStatsCache.get(match.liveId);
            console.log(`✅ Using cached data for ${match.liveId}`);
          } else {
            match.stats = await fetchMatchStats(match.liveId);
            liveStatsCache.set(match.liveId, match.stats);
            preloadedStatsSet.add(match.liveId);
          }
        }
      }
    }

    fs.writeFileSync(FILE_PATH, JSON.stringify(leagues, null, 2), "utf8");
    console.log("✅ COMPREHENSIVE DATA SAVED WITH ALL STATS AND FORMATIONS");

    return leagues;
  } catch (err) {
    console.error("❌ Error fetching Match-Today:", err.message);
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchMatchToday();
}