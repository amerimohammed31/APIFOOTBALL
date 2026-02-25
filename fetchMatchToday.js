import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const FILE_PATH = path.resolve("./match-today.json");
const URL = "https://www.footmercato.net/live/";
const RETRY_COUNT = 3;
const TIMEOUT = 20000;

// ================= CACHE =================
export const liveStatsCache = new Map();
export const preloadedStatsSet = new Set();

// ================= RETRY =================
async function fetchWithRetry(url, retries = RETRY_COUNT) {
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await axios.get(url, {
        timeout: TIMEOUT,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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

// ================= EXTRACTOR FUNCTIONS =================

function extractMatchInfo($) {
  const info = {};
  
  // معلومات من scoreboard
  const $scoreboard = $('.scoreboard');
  info.homeTeam = {
    name: $scoreboard.find('.scoreboard__team--home .scoreboard__teamName').text().trim(),
    logo: $scoreboard.find('.scoreboard__team--home img').attr('src') || 
          $scoreboard.find('.scoreboard__team--home img').attr('data-src'),
  };
  info.awayTeam = {
    name: $scoreboard.find('.scoreboard__team--away .scoreboard__teamName').text().trim(),
    logo: $scoreboard.find('.scoreboard__team--away img').attr('src') || 
          $scoreboard.find('.scoreboard__team--away img').attr('data-src'),
  };
  
  // معلومات المسابقة
  const $competition = $('.matchTopBar__competition');
  info.competition = {
    name: $competition.find('.matchTopBar__competitionName').text().trim(),
    phase: $competition.find('.matchTopBar__phaseName').text().trim(),
  };
  
  // التاريخ والوقت
  info.datetime = $('.scoreboard__date').attr('datetime') || null;
  info.time = $('.scoreboard__score--fixture').text().trim();
  
  // النتيجة الإجمالية
  info.aggregateScore = $('.scoreboard__moreScore b').text().trim();
  
  return info;
}

function extractVenue($) {
  const venue = {};
  const $venue = $('.venue');
  
  if ($venue.length) {
    venue.name = $venue.find('.venue__name').text().trim();
    venue.city = $venue.find('.venue__cityName').text().trim();
    venue.image = $venue.find('img').attr('src') || $venue.find('img').attr('data-src');
    
    const details = {};
    $venue.find('.venue__list .venue__info').each((_, el) => {
      const label = $(el).find('.venue__label').text().trim().replace(':', '');
      const value = $(el).find('.venue__value').text().trim();
      details[label] = value;
    });
    venue.details = details;
  }
  
  return venue;
}

function extractReferees($) {
  const referees = [];
  
  $('.blockVertical__content .matchReferee').each((_, el) => {
    referees.push({
      name: $(el).find('.matchReferee__name').text().trim(),
      type: $(el).find('.matchReferee__type').text().trim(),
    });
  });
  
  return referees;
}

function extractInjuries($) {
  const injuries = {
    home: [],
    away: [],
  };
  
  $('.personCardTeamsList__team').each((index, teamEl) => {
    const teamType = index === 0 ? 'home' : 'away';
    
    $(teamEl).find('.personCard').each((_, playerEl) => {
      injuries[teamType].push({
        name: $(playerEl).find('.personCard__name').text().trim(),
        injury: $(playerEl).find('.personCard__description').text().trim(),
        severity: $(playerEl).find('.personCard__injurySeverity').attr('class')?.split('--')[1] || 'unknown',
        link: $(playerEl).attr('href'),
        image: $(playerEl).find('img').attr('src') || $(playerEl).find('img').attr('data-src'),
      });
    });
  });
  
  return injuries;
}

function extractPredictions($) {
  const predictions = {};
  const $pronostic = $('.pronostic');
  
  if ($pronostic.length) {
    predictions.matchId = $pronostic.attr('data-match-id');
    predictions.totalParticipants = $pronostic.find('.pronostic__footer__participantsCount span[data-value]').attr('data-value');
    predictions.endTime = $pronostic.find('.pronostic__footer__participantsCount span:contains("Fin dans")').text().trim();
    
    const choices = [];
    $pronostic.find('.pronostic__choices .pronosticChoice').each((index, el) => {
      const $choice = $(el);
      const value = $choice.attr('data-value');
      const label = $choice.find('.pronosticChoice__label').text().trim();
      const side = $choice.find('.pronosticChoice__side').text().trim();
      
      // البحث عن النسبة المئوية المرتبطة
      let percentage = null;
      let count = null;
      const $progressBar = $pronostic.find('.pronostic__participantsByChoice .progressBar').eq(index);
      if ($progressBar.length) {
        percentage = $progressBar.attr('data-percent');
        count = $progressBar.attr('data-count');
      }
      
      choices.push({ value, side, label, percentage, count });
    });
    
    predictions.choices = choices;
  }
  
  return predictions;
}

function extractBroadcast($) {
  const broadcast = {};
  const $broadcast = $('.affiliationMatchBroadcast__link');
  
  if ($broadcast.length) {
    broadcast.channel = $broadcast.text().trim();
    broadcast.link = $broadcast.attr('href');
  }
  
  return broadcast;
}

function extractFAQ($) {
  const faq = [];
  
  $('.faq .faq__row').each((_, el) => {
    faq.push({
      question: $(el).find('.faq__question').text().trim(),
      answer: $(el).find('.faq__answer').text().trim(),
    });
  });
  
  return faq;
}

function extractHeadToHead($) {
  const headToHead = [];
  
  $('.select__floatingList .select__itemButton').each((_, itemEl) => {
    const $item = $(itemEl);
    const competitionId = $item.attr('data-value');
    const competitionName = $item.find('.select__itemLabel').text().trim();
    const matchesCount = $item.find('.select__itemSubLabel').text().trim();
    
    // استخراج النسب المئوية للمسابقة المقابلة
    const percentages = [];
    $(`.matchTeamsHeadToHeadHistory__gaugesHistory[data-headtoheadresults="${competitionId}"] .verticalPercentageBar`).each((_, barEl) => {
      percentages.push({
        label: $(barEl).find('.verticalPercentageBar__legend').text().trim(),
        percentage: $(barEl).find('.verticalPercentageBar__gaugeOverlay').text().trim(),
        height: $(barEl).find('.verticalPercentageBar__gaugeValue').attr('style'),
      });
    });
    
    headToHead.push({
      competitionId,
      competitionName,
      matchesCount,
      percentages,
    });
  });
  
  return headToHead;
}

function extractLastMeetings($) {
  const meetings = [];
  
  $('.matchSlim').each((_, el) => {
    const $match = $(el);
    const link = $match.find('a').attr('href');
    const liveId = link ? link.split('/')[3] : null;
    
    meetings.push({
      liveId,
      link,
      homeTeam: $match.find('.matchSlim__team:first-child .matchTeam__name').text().trim(),
      awayTeam: $match.find('.matchSlim__team:last-child .matchTeam__name').text().trim(),
      homeLogo: $match.find('.matchSlim__team:first-child img').attr('data-src'),
      awayLogo: $match.find('.matchSlim__team:last-child img').attr('data-src'),
      score: $match.find('.matchSlim__scores').text().trim().replace(/\s+/g, ' '),
      homeScore: $match.find('.matchSlim__score').first().text().trim(),
      awayScore: $match.find('.matchSlim__score').last().text().trim(),
      status: $match.find('.timeline__value').text().trim(),
    });
  });
  
  return meetings;
}

function extractTeamForm($) {
  const form = {
    home: [],
    away: [],
  };
  
  // استخراج نتائج أتالانتا
  $('.blockSingle:has(.title__left:contains("Série en cours Atalanta")) .matchResult').each((_, el) => {
    form.home.push({
      result: $(el).attr('class').split('--')[1] || 'unknown',
      score: $(el).find('.matchResult__score').text().trim(),
      opponentLogo: $(el).find('img').attr('data-src'),
      link: $(el).attr('href'),
    });
  });
  
  // استخراج نتائج دورتموند
  $('.blockSingle:has(.title__left:contains("Série en cours Dortmund")) .matchResult').each((_, el) => {
    form.away.push({
      result: $(el).attr('class').split('--')[1] || 'unknown',
      score: $(el).find('.matchResult__score').text().trim(),
      opponentLogo: $(el).find('img').attr('data-src'),
      link: $(el).attr('href'),
    });
  });
  
  return form;
}

function extractTournamentTopPlayers($) {
  const topPlayers = {
    scorers: [],
    assisters: [],
  };
  
  // استخراج أفضل الهدافين
  $('.statsStandings:has(.statsStandings__headerTitle:contains("Buteurs")) .statsStandings__ranking').each((_, el) => {
    topPlayers.scorers.push({
      rank: $(el).find('.statsStandings__rank').text().trim().replace('#', ''),
      name: $(el).find('.statsStandings__name').text().trim(),
      teamLogo: $(el).find('img').attr('data-src'),
      goals: $(el).find('.statsStandings__value').first().text().trim(),
      link: $(el).attr('href'),
    });
  });
  
  // استخراج أفضل صانعي الأهداف
  $('.statsStandings:has(.statsStandings__headerTitle:contains("Passes Décisives")) .statsStandings__ranking').each((_, el) => {
    topPlayers.assisters.push({
      rank: $(el).find('.statsStandings__rank').text().trim().replace('#', ''),
      name: $(el).find('.statsStandings__name').text().trim(),
      teamLogo: $(el).find('img').attr('data-src'),
      assists: $(el).find('.statsStandings__value').first().text().trim(),
      link: $(el).attr('href'),
    });
  });
  
  return topPlayers;
}

function extractLeagueStats($) {
  const stats = [];
  
  $('.blockVertical:has(.title__left:contains("Stats globales")) .blockVertical__content').each((_, el) => {
    const $stat = $(el);
    const title = $stat.find('.statInline__title').text().trim();
    const homeValue = $stat.find('.statInline__valueMain').first().text().trim();
    const awayValue = $stat.find('.statInline__value--right .statInline__valueMain').text().trim();
    
    // استخراج نسبة التقدم إذا وجدت
    let homeProgress = null;
    let awayProgress = null;
    const $progressBars = $stat.find('.statInline__progressBarValue');
    if ($progressBars.length >= 2) {
      homeProgress = $progressBars.first().attr('style')?.match(/width:([^%;]+)/)?.[1] || null;
      awayProgress = $progressBars.last().attr('style')?.match(/width:([^%;]+)/)?.[1] || null;
    }
    
    stats.push({
      title,
      home: { value: homeValue, progress: homeProgress },
      away: { value: awayValue, progress: awayProgress },
    });
  });
  
  return stats;
}

function extractGoalsDistribution($) {
  const distribution = {
    total: [],
    home: [],
    away: [],
  };
  
  // توزيع الأهداف الإجمالي
  $('.filtersTabs__tab#taball .statsPerSegments__item').each((_, el) => {
    distribution.total.push({
      period: $(el).find('.statVerticalBarGroup__title').text().trim(),
      homeGoals: $(el).find('.statVerticalBarGroup__gaugeWrapper--home .statVerticalBarGroup__value').text().trim(),
      homePercentage: $(el).find('.statVerticalBarGroup__gaugeWrapper--home .statVerticalBarGroup__gauge').attr('style'),
      awayGoals: $(el).find('.statVerticalBarGroup__gaugeWrapper--away .statVerticalBarGroup__value').text().trim(),
      awayPercentage: $(el).find('.statVerticalBarGroup__gaugeWrapper--away .statVerticalBarGroup__gauge').attr('style'),
    });
  });
  
  // توزيع الأهداف على أرضه
  $('.filtersTabs__tab#tabhome .statsPerSegments__item').each((_, el) => {
    distribution.home.push({
      period: $(el).find('.statVerticalBarGroup__title').text().trim(),
      homeGoals: $(el).find('.statVerticalBarGroup__gaugeWrapper--home .statVerticalBarGroup__value').text().trim(),
      awayGoals: $(el).find('.statVerticalBarGroup__gaugeWrapper--away .statVerticalBarGroup__value').text().trim(),
    });
  });
  
  // توزيع الأهداف خارج أرضه
  $('.filtersTabs__tab#tabaway .statsPerSegments__item').each((_, el) => {
    distribution.away.push({
      period: $(el).find('.statVerticalBarGroup__title').text().trim(),
      homeGoals: $(el).find('.statVerticalBarGroup__gaugeWrapper--home .statVerticalBarGroup__value').text().trim(),
      awayGoals: $(el).find('.statVerticalBarGroup__gaugeWrapper--away .statVerticalBarGroup__value').text().trim(),
    });
  });
  
  return distribution;
}

function extractGoalsTypes($) {
  const types = {
    home: [],
    away: [],
  };
  
  // أنواع أهداف أتالانتا
  $('.goalsStatsByType:has(.goalsStatsByType__team span:contains("Atalanta")) .horizontalPercentageBar').each((_, el) => {
    types.home.push({
      type: $(el).find('.horizontalPercentageBar__legend').text().trim(),
      percentage: $(el).find('.horizontalPercentageBar__percent').text().trim(),
      count: $(el).find('.horizontalPercentageBar__value').text().trim(),
    });
  });
  
  // أنواع أهداف دورتموند
  $('.goalsStatsByType:has(.goalsStatsByType__team span:contains("Dortmund")) .horizontalPercentageBar').each((_, el) => {
    types.away.push({
      type: $(el).find('.horizontalPercentageBar__legend').text().trim(),
      percentage: $(el).find('.horizontalPercentageBar__percent').text().trim(),
      count: $(el).find('.horizontalPercentageBar__value').text().trim(),
    });
  });
  
  return types;
}

function extractLineupStatus($) {
  const status = {};
  
  const $message = $('.message');
  if ($message.length) {
    status.title = $message.find('.message__title').text().trim();
    status.text = $message.find('.message__text').text().trim();
  }
  
  return status;
}

// ================= FETCH DETAILS =================

export async function fetchMatchDetails(liveId) {
  if (!liveId) return {};
  const matchUrl = `https://www.footmercato.net/live/${liveId}`;
  
  try {
    const data = await fetchWithRetry(matchUrl);
    const $ = cheerio.load(data);
    
    const details = {
      matchInfo: extractMatchInfo($),
      venue: extractVenue($),
      referees: extractReferees($),
      injuries: extractInjuries($),
      predictions: extractPredictions($),
      broadcast: extractBroadcast($),
      faq: extractFAQ($),
      rawDataAttributes: [],
    };

    // استخراج البيانات الوصفية من body
    $('body').each((_, el) => {
      const attribs = el.attribs || {};
      Object.keys(attribs).forEach((k) => {
        if (k.startsWith("data-")) {
          details.rawDataAttributes.push({ key: k, value: attribs[k] });
        }
      });
    });
    
    return details;
  } catch (err) {
    console.error(`❌ Error fetching match details for ${liveId}: ${err.message}`);
    return {};
  }
}

export async function fetchMatchFormation(liveId) {
  if (!liveId) return {};
  const formationUrl = `https://www.footmercato.net/live/${liveId}/formation`;
  
  try {
    const data = await fetchWithRetry(formationUrl);
    const $ = cheerio.load(data);
    
    const formation = {
      lineupStatus: extractLineupStatus($),
      injuries: extractInjuries($),
      lineupLink: $('a[data-modal="modalLineupSurvey"]').attr('href') || null,
    };
    
    return formation;
  } catch (err) {
    console.error(`❌ Error fetching formation for ${liveId}: ${err.message}`);
    return {};
  }
}

export async function fetchMatchStats(liveId) {
  if (!liveId) return {};
  const statsUrl = `https://www.footmercato.net/live/${liveId}/stats`;

  try {
    const data = await fetchWithRetry(statsUrl);
    const $ = cheerio.load(data);

    const stats = {
      headToHead: extractHeadToHead($),
      lastMeetings: extractLastMeetings($),
      teamForm: extractTeamForm($),
      tournamentTopPlayers: extractTournamentTopPlayers($),
      leagueStats: extractLeagueStats($),
      goalsDistribution: extractGoalsDistribution($),
      goalsTypes: extractGoalsTypes($),
    };

    return stats;
  } catch (err) {
    console.error(`❌ Error fetching stats for liveId ${liveId}: ${err.message}`);
    return {};
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
            links: {
              main: liveId ? `https://www.footmercato.net/live/${liveId}` : null,
              formation: liveId ? `https://www.footmercato.net/live/${liveId}/formation` : null,
              stats: liveId ? `https://www.footmercato.net/live/${liveId}/stats` : null,
            },
            homeTeam: {
              name: homeEl.find(".matchTeam__name").text().trim(),
              logo: homeEl.find("img").attr("data-src") || "",
            },
            awayTeam: {
              name: awayEl.find(".matchTeam__name").text().trim(),
              logo: awayEl.find("img").attr("data-src") || "",
            },
            score: homeScore && awayScore ? `${homeScore} - ${awayScore}` : null,
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

    // ================= جلب البيانات الإضافية =================
    console.log("📡 Fetching additional data for all matches...");
    
    const fetchPromises = [];
    for (const league of leagues) {
      for (const match of league.matches) {
        if (!match.liveId) continue;
        
        const promise = (async () => {
          try {
            // جلب البيانات الأساسية للمباراة
            match.details = await fetchMatchDetails(match.liveId);
            
            // إذا كانت المباراة مباشرة أو مجدولة، نجلب التشكيلة والإحصائيات
            if (match.isLive || match.status === "scheduled") {
              match.formation = await fetchMatchFormation(match.liveId);
              match.stats = await fetchMatchStats(match.liveId);
              
              // تخزين في الكاش
              liveStatsCache.set(match.liveId, match.stats);
              preloadedStatsSet.add(match.liveId);
            } 
            // إذا كانت منتهية، نحاول جلب الإحصائيات من الكاش
            else if (match.status === "finished") {
              match.stats = liveStatsCache.get(match.liveId) || await fetchMatchStats(match.liveId);
            }
            
            console.log(`✅ Data fetched for match ${match.liveId}`);
          } catch (err) {
            console.error(`❌ Error fetching additional data for match ${match.liveId}: ${err.message}`);
          }
        })();
        
        fetchPromises.push(promise);
      }
    }

    // انتظار جميع طلبات الجلب
    await Promise.all(fetchPromises);

    // حفظ البيانات
    fs.writeFileSync(FILE_PATH, JSON.stringify(leagues, null, 2), "utf8");
    console.log("✅ COMPLETE MATCH DATA SAVED TO match-today.json");

    return leagues;
  } catch (err) {
    console.error("❌ Error fetching Match-Today:", err.message);
    return [];
  }
}

// تشغيل السكريبت مباشرة
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchMatchToday();
}