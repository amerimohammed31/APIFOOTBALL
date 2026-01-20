import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import LEAGUES from "./leagues.js"; // قائمة الـ 63 دوري

const DATA_FILE = "./all_leagues_standings.json";
const FAILED_FILE = "./failed_leagues.json";

// —————— دالة لجلب تصنيفات دوري واحد ——————
async function fetchStandings(league) {
  try {
    const response = await axios.get(league.url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15000
    });

    if (response.status !== 200) throw new Error(`HTTP status ${response.status}`);

    const $ = cheerio.load(response.data);

    const table = $("table tbody tr");
    if (table.length === 0) {
      throw new Error("No table found");
    }

    const standings = [];
    table.each((_, row) => {
      const cols = $(row).find("td");

      const rank = $(cols[0]).text().trim();
      const teamCell = $(cols[1]);
      const team = teamCell.find("span").text().trim();
      const logo = teamCell.find("img").attr("data-src") || teamCell.find("img").attr("src") || null;
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
        goalsAgainst: Number(goalsAgainst)
      });
    });

    return standings;

  } catch (err) {
    console.error(`❌ Failed ${league.name}:`, err.message);
    return null; // إرجاع null عند الفشل
  }
}

// —————— دالة لجلب كل الدوريات ——————
export default async function fetchAllLeagues() {
  const allLeagues = {};
  const failedLeagues = [];

  for (const league of LEAGUES) {
    const standings = await fetchStandings(league);
    if (standings && standings.length > 0) {
      allLeagues[league.name] = standings;
      console.log(`✅ Fetched ${league.name}`);
    } else {
      failedLeagues.push(league.name);
      console.log(`⚠ Skipped ${league.name}`);
    }

    // تأخير صغير لتجنب الحظر
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // حفظ البيانات الصحيحة
  fs.writeFileSync(DATA_FILE, JSON.stringify(allLeagues, null, 2));
  // حفظ الدوريات الفاشلة
  fs.writeFileSync(FAILED_FILE, JSON.stringify(failedLeagues, null, 2));

  console.log(`🎉 All leagues saved to ${DATA_FILE}`);
  if (failedLeagues.length > 0) {
    console.log(`⚠ Failed leagues saved to ${FAILED_FILE}`);
  }

  return allLeagues;
}
