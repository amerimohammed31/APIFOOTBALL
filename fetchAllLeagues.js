import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import LEAGUES from "./leagues.js";

const DATA_FILE = "./all_leagues_standings.json";
const FAILED_FILE = "./failed_leagues.json";

// —————— دالة لجلب تصنيفات دوري واحد مع دعم إعادة المحاولة ——————
async function fetchStandings(league, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(league.url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 15000
      });

      if (response.status !== 200) throw new Error(`HTTP status ${response.status}`);

      const $ = cheerio.load(response.data);
      const table = $("table tbody tr");

      if (!table.length) throw new Error("No table found");

      const standings = [];
      table.each((_, row) => {
        const cols = $(row).find("td");
        const rank = Number($(cols[0]).text().trim());
        const teamCell = $(cols[1]);
        const team = teamCell.find("span").text().trim() || teamCell.text().trim();
        const logo = teamCell.find("img").attr("data-src") || teamCell.find("img").attr("src") || null;
        const points = Number($(cols[2]).text().trim());
        const played = Number($(cols[3]).text().trim());
        const goalDiff = $(cols[4]).text().trim();
        const wins = Number($(cols[5]).text().trim());
        const draws = Number($(cols[6]).text().trim());
        const losses = Number($(cols[7]).text().trim());
        const goalsFor = Number($(cols[8]).text().trim());
        const goalsAgainst = Number($(cols[9]).text().trim());

        standings.push({ rank, team, logo, points, played, goalDiff, wins, draws, losses, goalsFor, goalsAgainst });
      });

      return standings;

    } catch (err) {
      console.warn(`⚠ Attempt ${attempt} failed for ${league.name}: ${err.message}`);
      if (attempt === retries) return null;
      await new Promise(res => setTimeout(res, 2000));
    }
  }
}

// —————— دالة لجلب كل الدوريات مع تحديث JSON بطريقة احترافية ——————
export default async function fetchAllLeagues(concurrency = 5) {
  // قراءة البيانات الموجودة مسبقًا إذا كان الملف موجود
  let allLeagues = {};
  if (fs.existsSync(DATA_FILE)) {
    try {
      allLeagues = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    } catch {
      console.warn("⚠ Failed to read existing data, starting fresh.");
      allLeagues = {};
    }
  }

  // قراءة الدوريات الفاشلة السابقة
  let previousFailed = [];
  if (fs.existsSync(FAILED_FILE)) {
    try {
      previousFailed = JSON.parse(fs.readFileSync(FAILED_FILE, "utf-8"));
    } catch {
      previousFailed = [];
    }
  }

  const failedLeagues = [];

  // قائمة الدوريات للمعالجة (يمكن إعادة المحاولة فقط للفاشلة سابقًا)
  const queue = [...LEAGUES];

  async function worker() {
    while (queue.length > 0) {
      const league = queue.shift();
      const standings = await fetchStandings(league);
      if (standings && standings.length > 0) {
        allLeagues[league.name] = {
          lastUpdated: new Date().toISOString(),
          standings
        };
        console.log(`✅ Fetched ${league.name}`);
      } else {
        failedLeagues.push(league.name);
        console.log(`❌ Failed ${league.name}`);
      }
      await new Promise(res => setTimeout(res, 500)); // تأخير بسيط لتجنب الحظر
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  // حفظ البيانات بعد الدمج
  fs.writeFileSync(DATA_FILE, JSON.stringify(allLeagues, null, 2));
  fs.writeFileSync(FAILED_FILE, JSON.stringify(failedLeagues, null, 2));

  console.log(`🎉 All leagues saved to ${DATA_FILE}`);
  if (failedLeagues.length) console.log(`⚠ Failed leagues saved to ${FAILED_FILE}`);

  return allLeagues;
}
