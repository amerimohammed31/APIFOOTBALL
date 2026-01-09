// fetchMatchToday.js
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

const FILE_PATH = "./Match-Today.json";
const URL = "https://www.footmercato.net/live/";

export async function fetchMatchToday() {
  try {
    const { data } = await axios.get(URL);
    const $ = cheerio.load(data);

    const leagues = [];

    $(".matchesGroup").each((i, el) => {
      const leagueName = $(el).find(".title__leftLink").text().trim();

      const matches = [];

      $(el)
        .find(".matchesGroup__match")
        .each((j, matchEl) => {
          const homeTeamEl = $(matchEl).find("span.matchFull__team").first();
          const awayTeamEl = $(matchEl).find("span.matchFull__team.matchFull__team--away");

          const homeTeam = {
            name: homeTeamEl.find("span.matchTeam__name").text().trim(),
            logo: homeTeamEl.find("img.matchTeam__logo").attr("data-src")
          };

          const awayTeam = {
            name: awayTeamEl.find("span.matchTeam__name").text().trim(),
            logo: awayTeamEl.find("img.matchTeam__logo").attr("data-src")
          };

          const time = $(matchEl).find("span.matchFull__infosDate time").attr("datetime") || "";

          matches.push({ homeTeam, awayTeam, time });
        });

      leagues.push({ leagueName, matches });
    });

    // حفظ البيانات في ملف JSON
    fs.writeFileSync(FILE_PATH, JSON.stringify(leagues, null, 2), "utf-8");
    console.log("✅ MatchToday updated successfully.");
    return leagues;
  } catch (err) {
    console.error("❌ Error fetching MatchToday:", err.message);
    return [];
  }
}
