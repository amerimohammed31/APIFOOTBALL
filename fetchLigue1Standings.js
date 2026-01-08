import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

const URL = "https://www.footmercato.net/france/ligue-1/classement";
const FILE_PATH = "./ligue1_standings.json";

async function fetchLigue1Standings() {
  try {
    const { data } = await axios.get(URL, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "fr-FR,fr;q=0.9",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);
    const standings = [];

    $("table tbody tr").each((_, row) => {
      const cols = $(row).find("td");

      const rank = $(cols[0]).find(".rankingTable__rankValue").text().trim();

      const teamCell = $(cols[1]);
      const team = teamCell.find("span").text().trim();
      const logo =
        teamCell.find("img").attr("data-src") ||
        teamCell.find("img").attr("src") ||
        null;

      const points = $(cols[2]).text().trim();
      const played = $(cols[3]).text().trim();
      const goalDiff = $(cols[4]).text().trim();
      const wins = $(cols[5]).text().trim();
      const draws = $(cols[6]).text().trim();
      const losses = $(cols[7]).text().trim();
      const goalsFor = $(cols[8]).text().trim();
      const goalsAgainst = $(cols[9]).text().trim();

      standings.push({
        rank: Number(rank),
        team,
        logo,
        points: Number(points),
        played: Number(played),
        goalDiff,
        wins: Number(wins),
        draws: Number(draws),
        losses: Number(losses),
        goalsFor: Number(goalsFor),
        goalsAgainst: Number(goalsAgainst),
      });
    });

    fs.writeFileSync(FILE_PATH, JSON.stringify(standings, null, 2));
    console.log("✅ Ligue 1 standings saved");
  } catch (err) {
    console.error("❌ Error fetching Ligue 1:", err.message);
  }
}

export default fetchLigue1Standings;