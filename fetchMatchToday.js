import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const FILE_PATH = path.resolve("./match-today.json");
const URL = "https://www.footmercato.net/live/";
const RETRY_COUNT = 3;
const TIMEOUT = 30000;
const DELAY_BETWEEN_REQUESTS = 1000; // 1 ثانية بين الطلبات لتجنب حظر IP
const MAX_CONCURRENT = 3; // عدد المباريات المتزامنة

// ================= CACHE =================
export const liveStatsCache = new Map();
export const preloadedStatsSet = new Set();

// ================= UTILS =================
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ================= RETRY WITH BACKOFF =================
async function fetchWithRetry(url, retries = RETRY_COUNT) {
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await axios.get(url, {
        timeout: TIMEOUT,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3",
          "Accept-Encoding": "gzip, deflate, br",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Cache-Control": "max-age=0"
        },
      });
      return data;
    } catch (err) {
      console.warn(`⚠️ Attempt ${i + 1} failed for ${url}: ${err.message}`);
      if (i === retries) throw err;
      // زيادة وقت الانتظار مع كل محاولة فاشلة
      await delay(2000 * (i + 1));
    }
  }
}

// ================= EXTRACTOR FUNCTIONS =================

function extractMatchInfo($) {
  const info = {};
  
  try {
    // معلومات من scoreboard
    const $scoreboard = $('.scoreboard');
    if ($scoreboard.length) {
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
    }
    
    // معلومات المسابقة
    const $competition = $('.matchTopBar__competition');
    if ($competition.length) {
      info.competition = {
        name: $competition.find('.matchTopBar__competitionName').text().trim(),
        phase: $competition.find('.matchTopBar__phaseName').text().trim(),
      };
    }
    
    // التاريخ والوقت
    info.datetime = $('.scoreboard__date').attr('datetime') || null;
    info.time = $('.scoreboard__score--fixture').text().trim();
    
    // النتيجة الإجمالية
    const $moreScore = $('.scoreboard__moreScore b');
    info.aggregateScore = $moreScore.length ? $moreScore.text().trim() : null;
  } catch (err) {
    console.error("Error extracting match info:", err.message);
  }
  
  return info;
}

function extractVenue($) {
  const venue = {};
  
  try {
    const $venue = $('.venue');
    
    if ($venue.length) {
      venue.name = $venue.find('.venue__name').text().trim();
      venue.city = $venue.find('.venue__cityName').text().trim();
      venue.image = $venue.find('img').attr('src') || $venue.find('img').attr('data-src');
      
      const details = {};
      $venue.find('.venue__list .venue__info').each((_, el) => {
        const label = $(el).find('.venue__label').text().trim().replace(':', '');
        const value = $(el).find('.venue__value').text().trim();
        if (label && value) details[label] = value;
      });
      venue.details = details;
    }
  } catch (err) {
    console.error("Error extracting venue:", err.message);
  }
  
  return venue;
}

function extractReferees($) {
  const referees = [];
  
  try {
    $('.blockVertical__content .matchReferee').each((_, el) => {
      referees.push({
        name: $(el).find('.matchReferee__name').text().trim(),
        type: $(el).find('.matchReferee__type').text().trim(),
      });
    });
  } catch (err) {
    console.error("Error extracting referees:", err.message);
  }
  
  return referees;
}

function extractInjuries($) {
  const injuries = {
    home: [],
    away: [],
  };
  
  try {
    $('.personCardTeamsList__team').each((index, teamEl) => {
      const teamType = index === 0 ? 'home' : 'away';
      
      $(teamEl).find('.personCard').each((_, playerEl) => {
        const $player = $(playerEl);
        injuries[teamType].push({
          name: $player.find('.personCard__name').text().trim(),
          injury: $player.find('.personCard__description').text().trim(),
          severity: $player.attr('class')?.match(/personCard--injurySeverity-(\w+)/)?.[1] || 'unknown',
          link: $player.attr('href'),
          image: $player.find('img').attr('src') || $player.find('img').attr('data-src'),
        });
      });
    });
  } catch (err) {
    console.error("Error extracting injuries:", err.message);
  }
  
  return injuries;
}

function extractPredictions($) {
  const predictions = {};
  
  try {
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
        
        if (value && label) {
          choices.push({ value, side, label, percentage, count });
        }
      });
      
      predictions.choices = choices;
    }
  } catch (err) {
    console.error("Error extracting predictions:", err.message);
  }
  
  return predictions;
}

function extractBroadcast($) {
  const broadcast = {};
  
  try {
    const $broadcast = $('.affiliationMatchBroadcast__link');
    
    if ($broadcast.length) {
      broadcast.channel = $broadcast.text().trim();
      broadcast.link = $broadcast.attr('href');
    }
  } catch (err) {
    console.error("Error extracting broadcast:", err.message);
  }
  
  return broadcast;
}

function extractFAQ($) {
  const faq = [];
  
  try {
    $('.faq .faq__row').each((_, el) => {
      const question = $(el).find('.faq__question').text().trim();
      const answer = $(el).find('.faq__answer').text().trim();
      if (question && answer) {
        faq.push({ question, answer });
      }
    });
  } catch (err) {
    console.error("Error extracting FAQ:", err.message);
  }
  
  return faq;
}

function extractHeadToHead($) {
  const headToHead = [];
  
  try {
    $('.select__floatingList .select__itemButton').each((_, itemEl) => {
      const $item = $(itemEl);
      const competitionId = $item.attr('data-value');
      const competitionName = $item.find('.select__itemLabel').text().trim();
      const matchesCount = $item.find('.select__itemSubLabel').text().trim();
      
      if (!competitionId || !competitionName) return;
      
      // استخراج النسب المئوية للمسابقة المقابلة
      const percentages = [];
      $(`.matchTeamsHeadToHeadHistory__gaugesHistory[data-headtoheadresults="${competitionId}"] .verticalPercentageBar`).each((_, barEl) => {
        const label = $(barEl).find('.verticalPercentageBar__legend').text().trim();
        const percentage = $(barEl).find('.verticalPercentageBar__gaugeOverlay').text().trim();
        const style = $(barEl).find('.verticalPercentageBar__gaugeValue').attr('style');
        
        if (label && percentage) {
          percentages.push({ label, percentage, style });
        }
      });
      
      headToHead.push({
        competitionId,
        competitionName,
        matchesCount,
        percentages,
      });
    });
  } catch (err) {
    console.error("Error extracting head to head:", err.message);
  }
  
  return headToHead;
}

function extractLastMeetings($) {
  const meetings = [];
  
  try {
    $('.matchSlim').each((_, el) => {
      const $match = $(el);
      const link = $match.find('a').attr('href');
      const liveId = link ? link.split('/')[3] : null;
      
      meetings.push({
        liveId,
        link,
        homeTeam: $match.find('.matchSlim__team:first-child .matchTeam__name').text().trim(),
        awayTeam: $match.find('.matchSlim__team:last-child .matchTeam__name').text().trim(),
        homeLogo: $match.find('.matchSlim__team:first-child img').attr('data-src') || 
                  $match.find('.matchSlim__team:first-child img').attr('src'),
        awayLogo: $match.find('.matchSlim__team:last-child img').attr('data-src') || 
                  $match.find('.matchSlim__team:last-child img').attr('src'),
        score: $match.find('.matchSlim__scores').text().trim().replace(/\s+/g, ' '),
        homeScore: $match.find('.matchSlim__score').first().text().trim(),
        awayScore: $match.find('.matchSlim__score').last().text().trim(),
        status: $match.find('.timeline__value').text().trim(),
      });
    });
  } catch (err) {
    console.error("Error extracting last meetings:", err.message);
  }
  
  return meetings;
}

function extractTeamForm($) {
  const form = {
    home: [],
    away: [],
  };
  
  try {
    // استخراج نتائج الفريق المضيف
    $('.blockSingle:has(.title__left:contains("Série en cours"))').each((_, blockEl) => {
      const $block = $(blockEl);
      const title = $block.find('.title__left').text().trim();
      
      if (title.includes("Atalanta") || title.includes("home")) {
        $block.find('.matchResult').each((_, el) => {
          form.home.push({
            result: $(el).attr('class')?.split('--')[1] || 'unknown',
            score: $(el).find('.matchResult__score').text().trim(),
            opponentLogo: $(el).find('img').attr('data-src'),
            link: $(el).attr('href'),
          });
        });
      } else if (title.includes("Dortmund") || title.includes("away")) {
        $block.find('.matchResult').each((_, el) => {
          form.away.push({
            result: $(el).attr('class')?.split('--')[1] || 'unknown',
            score: $(el).find('.matchResult__score').text().trim(),
            opponentLogo: $(el).find('img').attr('data-src'),
            link: $(el).attr('href'),
          });
        });
      }
    });
  } catch (err) {
    console.error("Error extracting team form:", err.message);
  }
  
  return form;
}

function extractTournamentTopPlayers($) {
  const topPlayers = {
    scorers: [],
    assisters: [],
  };
  
  try {
    // استخراج أفضل الهدافين
    $('.statsStandings:has(.statsStandings__headerTitle:contains("Buteurs")) .statsStandings__ranking').each((_, el) => {
      const rank = $(el).find('.statsStandings__rank').text().trim().replace('#', '');
      const name = $(el).find('.statsStandings__name').text().trim();
      const goals = $(el).find('.statsStandings__value').first().text().trim();
      
      if (name && goals) {
        topPlayers.scorers.push({
          rank,
          name,
          teamLogo: $(el).find('img').attr('data-src'),
          goals,
          link: $(el).attr('href'),
        });
      }
    });
    
    // استخراج أفضل صانعي الأهداف
    $('.statsStandings:has(.statsStandings__headerTitle:contains("Passes Décisives")) .statsStandings__ranking').each((_, el) => {
      const rank = $(el).find('.statsStandings__rank').text().trim().replace('#', '');
      const name = $(el).find('.statsStandings__name').text().trim();
      const assists = $(el).find('.statsStandings__value').first().text().trim();
      
      if (name && assists) {
        topPlayers.assisters.push({
          rank,
          name,
          teamLogo: $(el).find('img').attr('data-src'),
          assists,
          link: $(el).attr('href'),
        });
      }
    });
  } catch (err) {
    console.error("Error extracting tournament top players:", err.message);
  }
  
  return topPlayers;
}

function extractLeagueStats($) {
  const stats = [];
  
  try {
    $('.blockVertical:has(.title__left:contains("Stats globales")) .blockVertical__content').each((_, el) => {
      const $stat = $(el);
      const title = $stat.find('.statInline__title').text().trim();
      
      if (!title) return;
      
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
  } catch (err) {
    console.error("Error extracting league stats:", err.message);
  }
  
  return stats;
}

function extractGoalsDistribution($) {
  const distribution = {
    total: [],
    home: [],
    away: [],
  };
  
  try {
    // توزيع الأهداف الإجمالي
    $('.filtersTabs__tab#taball .statsPerSegments__item').each((_, el) => {
      const period = $(el).find('.statVerticalBarGroup__title').text().trim();
      if (!period) return;
      
      distribution.total.push({
        period,
        homeGoals: $(el).find('.statVerticalBarGroup__gaugeWrapper--home .statVerticalBarGroup__value').text().trim(),
        homeStyle: $(el).find('.statVerticalBarGroup__gaugeWrapper--home .statVerticalBarGroup__gauge').attr('style'),
        awayGoals: $(el).find('.statVerticalBarGroup__gaugeWrapper--away .statVerticalBarGroup__value').text().trim(),
        awayStyle: $(el).find('.statVerticalBarGroup__gaugeWrapper--away .statVerticalBarGroup__gauge').attr('style'),
      });
    });
    
    // توزيع الأهداف على أرضه
    $('.filtersTabs__tab#tabhome .statsPerSegments__item').each((_, el) => {
      const period = $(el).find('.statVerticalBarGroup__title').text().trim();
      if (!period) return;
      
      distribution.home.push({
        period,
        homeGoals: $(el).find('.statVerticalBarGroup__gaugeWrapper--home .statVerticalBarGroup__value').text().trim(),
        awayGoals: $(el).find('.statVerticalBarGroup__gaugeWrapper--away .statVerticalBarGroup__value').text().trim(),
      });
    });
    
    // توزيع الأهداف خارج أرضه
    $('.filtersTabs__tab#tabaway .statsPerSegments__item').each((_, el) => {
      const period = $(el).find('.statVerticalBarGroup__title').text().trim();
      if (!period) return;
      
      distribution.away.push({
        period,
        homeGoals: $(el).find('.statVerticalBarGroup__gaugeWrapper--home .statVerticalBarGroup__value').text().trim(),
        awayGoals: $(el).find('.statVerticalBarGroup__gaugeWrapper--away .statVerticalBarGroup__value').text().trim(),
      });
    });
  } catch (err) {
    console.error("Error extracting goals distribution:", err.message);
  }
  
  return distribution;
}

function extractGoalsTypes($) {
  const types = {
    home: [],
    away: [],
  };
  
  try {
    // أنواع أهداف الفريق المضيف
    $('.goalsStatsByType .horizontalPercentageBar').each((_, el) => {
      const $bar = $(el);
      const type = $bar.find('.horizontalPercentageBar__legend').text().trim();
      const percentage = $bar.find('.horizontalPercentageBar__percent').text().trim();
      const count = $bar.find('.horizontalPercentageBar__value').text().trim();
      
      if (!type) return;
      
      // محاولة تحديد الفريق من السياق
      const $container = $bar.closest('.goalsStatsByType');
      const teamText = $container.find('.goalsStatsByType__team').text().trim();
      
      if (teamText.includes('home') || teamText.includes('Atalanta')) {
        types.home.push({ type, percentage, count });
      } else {
        types.away.push({ type, percentage, count });
      }
    });
  } catch (err) {
    console.error("Error extracting goals types:", err.message);
  }
  
  return types;
}

function extractLineupStatus($) {
  const status = {};
  
  try {
    const $message = $('.message');
    if ($message.length) {
      status.title = $message.find('.message__title').text().trim();
      status.text = $message.find('.message__text').text().trim();
    }
  } catch (err) {
    console.error("Error extracting lineup status:", err.message);
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
  console.log("🚀 Starting Foot Mercato scraper...");
  console.log(`📁 Output file: ${FILE_PATH}`);
  
  try {
    console.log(`🌐 Fetching main page: ${URL}`);
    const data = await fetchWithRetry(URL);
    const $ = cheerio.load(data);
    const leagues = [];

    $(".matchesGroup").each((_, leagueEl) => {
      const leagueName = $(leagueEl).find(".title__leftLink").text().trim();
      const leagueLogo = $(leagueEl).find(".title__leftLink img").attr("data-src") || 
                        $(leagueEl).find(".title__leftLink img").attr("src") || "";

      const matches = [];

      $(leagueEl)
        .find(".matchesGroup__match")
        .each((_, matchEl) => {
          try {
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
              const src = $(img).attr("data-src") || $(img).attr("src");
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
                logo: homeEl.find("img").attr("data-src") || homeEl.find("img").attr("src") || "",
              },
              awayTeam: {
                name: awayEl.find(".matchTeam__name").text().trim(),
                logo: awayEl.find("img").attr("data-src") || awayEl.find("img").attr("src") || "",
              },
              score: homeScore && awayScore ? `${homeScore} - ${awayScore}` : null,
              status,
              isLive,
              goals,
              broadcasts,
              rawHTML: matchFull.html(),
              attributes: matchFull.get(0)?.attribs || {},
              rawText: matchFull.text().trim().replace(/\s+/g, ' '),
              details: {},
              formation: {},
              stats: {},
            });
          } catch (err) {
            console.error("Error processing match:", err.message);
          }
        });

      const blockedKeywords = ["amicaux", "friendly", "club friendlies", "test"];
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

    console.log(`✅ Found ${leagues.length} leagues with ${leagues.reduce((acc, l) => acc + l.matches.length, 0)} matches`);

    // ================= جلب البيانات الإضافية لجميع المباريات =================
    console.log("📡 Fetching additional data for ALL matches...");
    
    // تجميع كل المباريات في مصفوفة واحدة
    const allMatches = [];
    for (const league of leagues) {
      for (const match of league.matches) {
        if (match.liveId) {
          allMatches.push({ league, match });
        }
      }
    }
    
    console.log(`📊 Will fetch details for ${allMatches.length} matches (with concurrency limit of ${MAX_CONCURRENT})`);
    
    // جلب البيانات بشكل متزامن مع تحديد عدد الطلبات المتزامنة
    const results = [];
    for (let i = 0; i < allMatches.length; i += MAX_CONCURRENT) {
      const batch = allMatches.slice(i, i + MAX_CONCURRENT);
      console.log(`🔄 Processing batch ${Math.floor(i/MAX_CONCURRENT) + 1}/${Math.ceil(allMatches.length/MAX_CONCURRENT)}`);
      
      const batchPromises = batch.map(async ({ league, match }) => {
        try {
          console.log(`  ⏳ Fetching data for ${match.homeTeam.name} vs ${match.awayTeam.name} (${match.status})...`);
          
          // جلب البيانات الأساسية للمباراة
          match.details = await fetchMatchDetails(match.liveId);
          await delay(DELAY_BETWEEN_REQUESTS); // تأخير بين الطلبات
          
          // جلب التشكيلة (إذا كانت متوفرة)
          match.formation = await fetchMatchFormation(match.liveId);
          await delay(DELAY_BETWEEN_REQUESTS);
          
          // جلب الإحصائيات
          match.stats = await fetchMatchStats(match.liveId);
          
          // تخزين في الكاش للاستخدام المستقبلي
          if (match.stats && Object.keys(match.stats).length > 0) {
            liveStatsCache.set(match.liveId, match.stats);
            preloadedStatsSet.add(match.liveId);
            console.log(`  ✅ Stats found for ${match.liveId}`);
          } else {
            console.log(`  ⚠️ No stats available for ${match.liveId}`);
          }
          
          return { success: true, liveId: match.liveId };
        } catch (err) {
          console.error(`  ❌ Error fetching data for match ${match.liveId}: ${err.message}`);
          return { success: false, liveId: match.liveId, error: err.message };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // تأخير بين البatches
      if (i + MAX_CONCURRENT < allMatches.length) {
        await delay(DELAY_BETWEEN_REQUESTS * 2);
      }
    }

    // تقرير النتائج
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`\n📊 FETCH REPORT: ${successful} successful, ${failed} failed`);

    // تحليل توفر الإحصائيات
    console.log("\n📊 STATS AVAILABILITY REPORT:");
    let statsCount = 0;
    let totalMatches = 0;

    for (const league of leagues) {
      console.log(`\n${league.leagueName}:`);
      for (const match of league.matches) {
        totalMatches++;
        const hasStats = match.stats && Object.keys(match.stats).length > 0;
        const hasFormation = match.formation && Object.keys(match.formation).length > 0;
        
        if (hasStats) statsCount++;
        
        let indicators = [];
        if (hasStats) indicators.push("📊 Stats");
        if (hasFormation) indicators.push("📋 Formation");
        if (match.goals.home.length || match.goals.away.length) indicators.push("⚽ Goals");
        
        const indicatorStr = indicators.length ? ` (${indicators.join(', ')})` : '';
        
        console.log(`  ${hasStats ? '✅' : '❌'} ${match.homeTeam.name} vs ${match.awayTeam.name}${indicatorStr}`);
        
        // تفاصيل الإحصائيات إذا وجدت
        if (hasStats && match.stats.headToHead?.length) {
          console.log(`    📈 Head-to-head: ${match.stats.headToHead.length} competitions`);
        }
        if (hasStats && match.stats.lastMeetings?.length) {
          console.log(`    📅 Last meetings: ${match.stats.lastMeetings.length} matches`);
        }
      }
    }

    console.log(`\n📈 Summary: ${statsCount}/${totalMatches} matches have full stats (${Math.round(statsCount/totalMatches*100)}%)`);

    // حفظ البيانات
    fs.writeFileSync(FILE_PATH, JSON.stringify(leagues, null, 2), "utf8");
    console.log(`\n✅ COMPLETE MATCH DATA SAVED TO ${FILE_PATH}`);
    console.log(`📁 File size: ${(fs.statSync(FILE_PATH).size / 1024).toFixed(2)} KB`);

    return leagues;
  } catch (err) {
    console.error("❌ Error fetching Match-Today:", err.message);
    return [];
  }
}

// تشغيل السكريبت مباشرة
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchMatchToday().then(() => {
    console.log("🏁 Script finished");
  }).catch(err => {
    console.error("💥 Fatal error:", err);
    process.exit(1);
  });
}