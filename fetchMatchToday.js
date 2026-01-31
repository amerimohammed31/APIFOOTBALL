import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

const FILE_PATH = "./match-today.json";
const URL = "https://www.footmercato.net/live/";

export async function fetchMatchToday() {
  try {
    const { data } = await axios.get(URL, {
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html",
      },
    });

    const $ = cheerio.load(data);
    const leagues = [];

    $(".matchesGroup").each((_, leagueEl) => {
      const leagueName = $(leagueEl)
        .find(".title__leftLink")
        .text()
        .trim();

      const leagueLogo =
        $(leagueEl).find(".title__leftLink img").attr("data-src") || "";

      const matches = [];

      $(leagueEl)
        .find(".matchesGroup__match")
        .each((_, matchEl) => {
          const matchFull = $(matchEl).find(".matchFull");

          const liveId = matchFull.attr("data-live-id") || null;

          const matchLink =
            "https://www.footmercato.net" +
            (matchFull.find("a.matchFull__link").attr("href") || "");

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
          const playedText = matchFull
            .find(".matchFull__infosPlayed")
            .text()
            .toLowerCase();

          if (isLive) status = "live";
          else if (playedText.includes("terminé")) status = "finished";

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
          });
        });

      if (matches.length > 0) {
        leagues.push({
          leagueName,
          leagueLogo,
          matches,
        });
      }
    });

    fs.writeFileSync(FILE_PATH, JSON.stringify(leagues, null, 2), "utf8");
    console.log("✅ Match-Today fetched successfully");

    return leagues;
  } catch (err) {
    console.error("❌ Error fetching Match-Today:", err.message);
    return [];
  }
}
