import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";

const FILE_PATH = path.resolve("./match-today.json");
const PREV_FILE_PATH = path.resolve("./match-today.json");
const URL = "https://www.footmercato.net/live/";
const RETRY_COUNT = 3;
const TIMEOUT = 20000;

// ======== دالة Retry آلية ========
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

// ======== دالة مسح إحصائيات مباراة ========
async function fetchMatchStats(liveId) {
  if (!liveId) return {};
  const statsUrl = `https://www.footmercato.net/live/${liveId}/stats`;

  try {
    const data = await fetchWithRetry(statsUrl);
    const $ = cheerio.load(data);
    const stats = {};

    // Face à face
    stats.faceToFace = [];
    $(".blockFaceToFace__history .blockFaceToFace__match").each((_, el) => {
      stats.faceToFace.push({
        homeTeam: $(el).find(".teamHome .teamName").text().trim(),
        awayTeam: $(el).find(".teamAway .teamName").text().trim(),
        score: $(el).find(".score").text().trim(),
        status: $(el).find(".matchStatus").text().trim(),
      });
    });

    // Stats des buts
    stats.goalStats = [];
    $(".blockVertical__contents .blockVertical__content").each((_, el) => {
      const title = $(el).find(".statInline__title").text().trim();
      const leftMain = $(el)
        .find(".statInline__valueWrapper .statInline__value")
        .first()
        .find(".statInline__valueMain")
        .first()
        .text()
        .trim();
      const leftAdd = $(el)
        .find(".statInline__valueWrapper .statInline__value")
        .first()
        .find(".statInline__valueAdditional")
        .first()
        .text()
        .trim();
      const rightMain = $(el)
        .find(".statInline__valueWrapper .statInline__value--right .statInline__valueMain")
        .first()
        .text()
        .trim();
      const rightAdd = $(el)
        .find(".statInline__valueWrapper .statInline__value--right .statInline__valueAdditional")
        .first()
        .text()
        .trim();

      stats.goalStats.push({
        title,
        left: { main: leftMain, additional: leftAdd },
        right: { main: rightMain, additional: rightAdd },
      });
    });

    return stats;
  } catch (err) {
    console.error(`❌ Error fetching stats for liveId ${liveId}: ${err.message}`);
    return {};
  }
}

// ======== دالة مقارنة المباريات ========
function compareMatches(oldMatches, newMatches) {
  const changes = [];
  const oldMap = {};
  oldMatches.forEach((m) => {
    oldMap[m.liveId] = m;
  });

  newMatches.forEach((m) => {
    const oldM = oldMap[m.liveId];
    if (!oldM) {
      changes.push({ type: "new_match", match: m });
    } else {
      if (JSON.stringify(oldM) !== JSON.stringify(m)) {
        changes.push({ type: "update", match: m });
      }
    }
  });

  return changes;
}

// ======== دالة سحب المباريات اليومية مع حفظ التغييرات ========
export async function fetchMatchToday() {
  try {
    const data = await fetchWithRetry(URL);
    const $ = cheerio.load(data);
    const leagues = [];

    $(".matchesGroup").each((_, leagueEl) => {
      const leagueName = $(leagueEl)
        .find(".title__leftLink")
        .text()
        .trim();
      const leagueLogo = $(leagueEl).find(".title__leftLink img").attr("data-src") || "";
      const matches = [];

      $(leagueEl)
        .find(".matchesGroup__match")
        .each((_, matchEl) => {
          const matchFull = $(matchEl).find(".matchFull");
          const liveId = matchFull.attr("data-live-id") || null;

          const homeEl = matchFull.find(".matchFull__team").first();
          const awayEl = matchFull.find(".matchFull__team--away");

          const homeTeam = {
            name: homeEl.find(".matchTeam__name").text().trim(),
            logo: homeEl.find("img").attr("data-src") || "",
          };
          const awayTeam = {
            name: awayEl.find(".matchTeam__name").text().trim(),
            logo: awayEl.find("img").attr("data-src") || "",
          };

          const homeScore = homeEl.find(".matchFull__score").text().trim();
          const awayScore = awayEl.find(".matchFull__score").text().trim();
          const score = homeScore && awayScore ? `${homeScore} - ${awayScore}` : null;

          let status = "scheduled";
          const isLive = matchFull.attr("data-live") === "1";
          const playedText = matchFull.find(".matchFull__infosPlayed").text().toLowerCase();
          if (isLive) status = "live";
          else if (playedText.includes("terminé")) status = "finished";

          const time = matchFull.find(".matchFull__infosDate time").attr("datetime") || "";

          const goals = { home: [], away: [] };
          matchFull.find(".matchFull__strikers--home .matchFull__striker").each((_, g) => {
            goals.home.push({
              player: $(g).find(".matchFull__strikerName").text().trim(),
              minute: $(g).find(".matchFull__strikerTime").text().trim(),
            });
          });
          matchFull.find(".matchFull__strikers--away .matchFull__striker").each((_, g) => {
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

          let winner = null;
          if (status === "finished" && homeScore && awayScore) {
            if (+homeScore > +awayScore) winner = "home";
            else if (+awayScore > +homeScore) winner = "away";
            else winner = "draw";
          }

          matches.push({
            liveId,
            statsLink: liveId ? `https://www.footmercato.net/live/${liveId}/stats` : null,
            homeTeam,
            awayTeam,
            score,
            status,
            time,
            isLive,
            winner,
            broadcasts,
            goals,
          });
        });

      if (matches.length > 0) leagues.push({ leagueName, leagueLogo, matches });
    });

    // تتبع إحصائيات كل مباراة بشكل متوازي
    for (const league of leagues) {
      await Promise.all(
        league.matches.map(async (match) => {
          match.stats = await fetchMatchStats(match.liveId);
        })
      );
    }

    // قراءة البيانات السابقة
    let prevData = [];
    if (fs.existsSync(PREV_FILE_PATH)) {
      try {
        prevData = JSON.parse(fs.readFileSync(PREV_FILE_PATH, "utf8"));
      } catch {
        console.warn("⚠️ Previous JSON corrupted or empty.");
      }
    }

    // مقارنة التغييرات
    const changes = [];
    leagues.forEach((league) => {
      const oldLeague = prevData.find((l) => l.leagueName === league.leagueName);
      const oldMatches = oldLeague ? oldLeague.matches : [];
      changes.push(...compareMatches(oldMatches, league.matches));
    });

    if (changes.length > 0) {
      console.log("🟢 Changes detected:");
      changes.forEach((c) => {
        console.log(`- [${c.type}] ${c.match.homeTeam.name} vs ${c.match.awayTeam.name}`);
      });
    } else {
      console.log("🟢 No changes detected today.");
    }

    // حفظ الملفات
    fs.writeFileSync(PREV_FILE_PATH, JSON.stringify(leagues, null, 2), "utf8");
    fs.writeFileSync(FILE_PATH, JSON.stringify(leagues, null, 2), "utf8");
    console.log("✅ Match-Today FULL stats saved.");

    return leagues;
  } catch (err) {
    console.error("❌ Error fetching Match-Today:", err.message);
    return [];
  }
}

// ======== تشغيل تلقائي عند التنفيذ في ES Module ========
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchMatchToday();
}
