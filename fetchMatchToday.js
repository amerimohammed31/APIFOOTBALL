import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

const FILE_PATH = "./Match-Today.json";
const URL = "https://www.footmercato.net/live/";

export async function fetchMatchToday() {
  try {
    const { data } = await axios.get(URL, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
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

          /* ================== IDs & LINKS ================== */
          const liveId = matchFull.attr("data-live-id") || null;
          const matchLink =
            "https://www.footmercato.net" +
            (matchFull.find("a.matchFull__link").attr("href") || "");

          /* ================== الفرق ================== */
          const homeEl = matchFull.find(".matchFull__team").first();
          const awayEl = matchFull.find(".matchFull__team--away");

          const homeTeam = {
            name: homeEl.find(".matchTeam__name").text().trim(),
            logo: homeEl.find("img").attr("data-src") || ""
          };

          const awayTeam = {
            name: awayEl.find(".matchTeam__name").text().trim(),
            logo: awayEl.find("img").attr("data-src") || ""
          };

          /* ================== النتيجة ================== */
          const homeScore = homeEl.find(".matchFull__score").text().trim();
          const awayScore = awayEl.find(".matchFull__score").text().trim();

          const score =
            homeScore && awayScore ? `${homeScore} - ${awayScore}` : null;

          /* ================== الحالة ================== */
          let status = "scheduled";

          const isLive = matchFull.attr("data-live") === "1";
          const liveValue = matchFull.attr("data-live-value") || "";
          const playedText = matchFull
            .find(".matchFull__infosPlayed")
            .text()
            .toLowerCase();

          if (isLive) {
            status = "live";
          } else if (
            playedText.includes("terminé") ||
            liveValue.includes("played")
          ) {
            status = "finished";
          }

          /* ================== الوقت ================== */
          const time =
            matchFull.find(".matchFull__infosDate time").attr("datetime") ||
            matchFull.find(".matchFull__dateTimeChrono").text().trim() ||
            "";

          /* ================== الأهداف ================== */
          const goals = {
            home: [],
            away: []
          };

          matchFull
            .find(".matchFull__strikers--home .matchFull__striker")
            .each((_, g) => {
              goals.home.push({
                player: $(g).find(".matchFull__strikerName").text().trim(),
                minute: $(g).find(".matchFull__strikerTime").text().trim()
              });
            });

          matchFull
            .find(".matchFull__strikers--away .matchFull__striker")
            .each((_, g) => {
              goals.away.push({
                player: $(g).find(".matchFull__strikerName").text().trim(),
                minute: $(g).find(".matchFull__strikerTime").text().trim()
              });
            });

          /* ================== القنوات الناقلة ================== */
          const broadcasts = [];
          matchFull.find(".matchFull__broadcastImage").each((_, img) => {
            broadcasts.push($(img).attr("data-src"));
          });

          /* ================== الفائز ================== */
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
            goals
          });
        });

      if (matches.length > 0) {
        leagues.push({
          leagueName,
          leagueLogo,
          matches
        });
      }
    });

    fs.writeFileSync(FILE_PATH, JSON.stringify(leagues, null, 2), "utf-8");
    console.log("✅ MatchToday updated successfully");

    return leagues;
  } catch (err) {
    console.error("❌ Error fetching MatchToday:", err.message);
    return [];
  }
}
