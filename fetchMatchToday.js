import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

const FILE_PATH = "./Match-Today.json";
const URL = "https://www.footmercato.net/live/";

export async function fetchMatchToday() {
  try {
    const { data } = await axios.get(URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const $ = cheerio.load(data);
    const leagues = [];

    const leagueElements = $(".matchesGroup").toArray();

    for (const leagueEl of leagueElements) {
      const leagueName = $(leagueEl).find(".title__leftLink").text().trim();
      const leagueLogo =
        $(leagueEl).find(".title__leftLink img").attr("data-src") || "";

      const matches = [];
      const matchElements = $(leagueEl).find(".matchesGroup__match").toArray();

      for (const matchEl of matchElements) {
        const matchFull = $(matchEl).find(".matchFull");

        const liveId = matchFull.attr("data-live-id") || null;
        const href = matchFull.find("a.matchFull__link").attr("href") || "";
        const matchLink = "https://www.footmercato.net" + href;

        // ================== الرابط الجزئي و stats URL ==================
        const pathVariable = href.startsWith("/") ? href.slice(1) : href;
        const statsURL = `https://www.footmercato.net/live/${pathVariable}/stats`;

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
        const score =
          homeScore && awayScore ? `${homeScore} - ${awayScore}` : null;

        let status = "scheduled";
        const isLive = matchFull.attr("data-live") === "1";
        const liveValue = matchFull.attr("data-live-value") || "";
        const playedText = matchFull
          .find(".matchFull__infosPlayed")
          .text()
          .toLowerCase();

        if (isLive) status = "live";
        else if (playedText.includes("terminé") || liveValue.includes("played"))
          status = "finished";

        const time =
          matchFull.find(".matchFull__infosDate time").attr("datetime") ||
          matchFull.find(".matchFull__dateTimeChrono").text().trim() ||
          "";

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
          broadcasts.push($(img).attr("data-src"));
        });

        let winner = null;
        if (status === "finished" && homeScore && awayScore) {
          if (+homeScore > +awayScore) winner = "home";
          else if (+awayScore > +homeScore) winner = "away";
          else winner = "draw";
        }

        // ================== STATS ==================
        let stats = {};
        try {
          const { data: statsHtml } = await axios.get(statsURL, {
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          const $$ = cheerio.load(statsHtml);

          // Possession / Duels / Passes
          stats.possession = [];
          $$(".blockVertical__contents")
            .first()
            .find(".blockVertical__content")
            .each((i, el) => {
              const home = $$(el)
                .find(".statInline__valueMain--highlight")
                .text()
                .trim();
              const away = $$(el)
                .find(".statInline__valueMain")
                .not(".statInline__valueMain--highlight")
                .text()
                .trim();
              const title = $$(el).find(".statInline__title").text().trim();
              if (title) stats.possession.push({ title, home, away });
            });

          // Shots / Goals / Other stats
          stats.attacking = [];
          $$(".statShotsFull").each((_, el) => {
            const title = $$(el).find(".statShotsFull__titleMain").text().trim();
            const home = $$(el)
              .find(".statShotsFull__shot.statShotsFull__shot--highlight")
              .first()
              .text()
              .trim();
            const away = $$(el)
              .find(".statShotsFull__shot")
              .not(".statShotsFull__shot--highlight")
              .first()
              .text()
              .trim();
            stats.attacking.push({ title, home, away });
          });

          // Defensive / Corners / Passes
          stats.defensive = [];
          $$(".blockVertical__contents")
            .last()
            .find(".blockVertical__content")
            .each((_, el) => {
              const title = $$(el).find(".statInline__title").text().trim();
              const home = $$(el)
                .find(".statInline__valueMain--highlight")
                .text()
                .trim();
              const away = $$(el)
                .find(".statInline__valueMain")
                .not(".statInline__valueMain--highlight")
                .text()
                .trim();
              if (title) stats.defensive.push({ title, home, away });
            });
        } catch (err) {
          console.log("⚠️ Failed to fetch stats for match:", statsURL);
        }

        matches.push({
          liveId,
          matchLink,
          homeTeam,
          awayTeam,
          score,
          status,
          time,
          isLive,
          winner,
          broadcasts,
          goals,
          stats,
        });
      }

      if (matches.length > 0) {
        leagues.push({
          leagueName,
          leagueLogo,
          matches,
        });
      }
    }

    fs.writeFileSync(FILE_PATH, JSON.stringify(leagues, null, 2), "utf-8");
    console.log("✅ MatchToday updated successfully with stats");

    return leagues;
  } catch (err) {
    console.error("❌ Error fetching MatchToday:", err.message);
    return [];
  }
}
