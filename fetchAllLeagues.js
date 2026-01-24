import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import LEAGUES from "./leagues.js";

const DATA_FILE = "./all_leagues_standings.json";
const FAILED_FILE = "./failed_leagues.json";

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// —————— Axios instance محسّن ——————
const client = axios.create({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9"
  },
  validateStatus: status => status >= 200 && status < 500
});

// —————— جلب ترتيب دوري واحد مع Retry ذكي ——————
async function fetchStandings(league, retries = 4) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const timeout = 15000 + attempt * 10000; // يزيد مع كل محاولة

      const response = await client.get(league.url, { timeout });

      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }

      const $ = cheerio.load(response.data);
      const rows = $("table tbody tr");

      if (!rows.length) {
        throw new Error("Standings table not found");
      }

      const standings = [];

      rows.each((_, row) => {
        const cols = $(row).find("td");
        if (cols.length < 10) return;

        const teamCell = $(cols[1]);

        standings.push({
          rank: Number($(cols[0]).text().trim()),
          team: teamCell.find("span").text().trim() || teamCell.text().trim(),
          logo:
            teamCell.find("img").attr("data-src") ||
            teamCell.find("img").attr("src") ||
            null,
          points: Number($(cols[2]).text().trim()),
          played: Number($(cols[3]).text().trim()),
          goalDiff: $(cols[4]).text().trim(),
          wins: Number($(cols[5]).text().trim()),
          draws: Number($(cols[6]).text().trim()),
          losses: Number($(cols[7]).text().trim()),
          goalsFor: Number($(cols[8]).text().trim()),
          goalsAgainst: Number($(cols[9]).text().trim())
        });
      });

      return standings;

    } catch (err) {
      console.warn(
        `⚠ ${league.name} | Attempt ${attempt}/${retries} failed → ${err.message}`
      );

      if (attempt === retries) return null;

      // Exponential backoff + random jitter
      const delay = 2000 * attempt + Math.random() * 1000;
      await sleep(delay);
    }
  }
}

// —————— جلب كل الدوريات مع Concurrency آمن ——————
export default async function fetchAllLeagues(concurrency = 4) {
  const allLeagues = {};
  const failedLeagues = [];

  const queue = [...LEAGUES];

  async function worker(id) {
    while (true) {
      const league = queue.shift();
      if (!league) return;

      console.log(`👷 Worker ${id} → ${league.name}`);

      const standings = await fetchStandings(league);

      if (standings?.length) {
        allLeagues[league.name] = standings;
        console.log(`✅ ${league.name} fetched (${standings.length} teams)`);
      } else {
        failedLeagues.push(league.name);
        console.log(`❌ ${league.name} failed`);
      }

      // Delay عشوائي لتفادي الحظر
      await sleep(700 + Math.random() * 800);
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => worker(i + 1))
  );

  fs.writeFileSync(DATA_FILE, JSON.stringify(allLeagues, null, 2));
  fs.writeFileSync(FAILED_FILE, JSON.stringify(failedLeagues, null, 2));

  console.log(`🎉 Saved → ${DATA_FILE}`);
  if (failedLeagues.length) {
    console.log(`⚠ Failed → ${FAILED_FILE}`);
  }

  return allLeagues;
}
