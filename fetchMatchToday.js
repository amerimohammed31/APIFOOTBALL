import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";

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

// ================= FULL STATS =================
async function fetchMatchStats(liveId) {
  if (!liveId) return {};

  const statsUrl = `https://www.footmercato.net/live/${liveId}/stats`;

  try {
    const data = await fetchWithRetry(statsUrl);
    const $ = cheerio.load(data);

    const stats = {
      faceToFace: [],
      goalStats: [],
      extraStats: [],
      timeline: [],
      cards: [],
      rawDataAttributes: [],
    };

    $(".blockFaceToFace__history .blockFaceToFace__match").each((_, el) => {
      stats.faceToFace.push({
        homeTeam: $(el).find(".teamHome .teamName").text().trim(),
        awayTeam: $(el).find(".teamAway .teamName").text().trim(),
        score: $(el).find(".score").text().trim(),
        status: $(el).find(".matchStatus").text().trim(),
      });
    });

    $(".blockVertical__contents .blockVertical__content").each((_, el) => {
      stats.goalStats.push({
        title: $(el).find(".statInline__title").text().trim(),
        homeMain: $(el).find(".statInline__valueMain").first().text().trim(),
        homeAdd: $(el).find(".statInline__valueAdditional").first().text().trim(),
        awayMain: $(el)
          .find(".statInline__value--right .statInline__valueMain")
          .text()
          .trim(),
        awayAdd: $(el)
          .find(".statInline__value--right .statInline__valueAdditional")
          .text()
          .trim(),
      });
    });

    $(".statHorizontal").each((_, el) => {
      stats.extraStats.push({
        title: $(el).find(".statHorizontal__title").text().trim(),
        home: $(el).find(".statHorizontal__value").first().text().trim(),
        away: $(el).find(".statHorizontal__value").last().text().trim(),
      });
    });

    $(".timeline__event").each((_, el) => {
      stats.timeline.push({
        minute: $(el).find(".timeline__time").text().trim(),
        player: $(el).find(".timeline__player").text().trim(),
        team: $(el).attr("data-team") || "",
        type: $(el).attr("data-type") || "",
      });
    });

    $(".timeline__card").each((_, el) => {
      stats.cards.push({
        player: $(el).find(".player").text().trim(),
        minute: $(el).find(".time").text().trim(),
        cardType: $(el).hasClass("red") ? "red" : "yellow",
      });
    });

    $("[data-live-id], [data-team], [data-type]").each((_, el) => {
      const attribs = el.attribs || {};
      Object.keys(attribs).forEach((k) => {
        if (k.startsWith("data-")) {
          stats.rawDataAttributes.push({ key: k, value: attribs[k] });
        }
      });
    });

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
      const leagueLogo =
        $(leagueEl).find(".title__leftLink img").attr("data-src") || "";

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

    for (const league of leagues) {
      await Promise.all(
        league.matches.map(async (match) => {
          if (match.isLive || match.status === "finished") {
            match.stats = await fetchMatchStats(match.liveId);
          } else {
            match.stats = null;
          }
        })
      );
    }

    fs.writeFileSync(FILE_PATH, JSON.stringify(leagues, null, 2), "utf8");
    console.log("✅ FULL ULTRA DATA SAVED");

    return leagues;
  } catch (err) {
    console.error("❌ Error fetching Match-Today:", err.message);
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchMatchToday();
}