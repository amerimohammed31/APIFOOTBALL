import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import LEAGUES from "./leagues.js";

const DATA_FILE = "./all_leagues_raw_tables.json";
const FAILED_FILE = "./failed_leagues.json";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* —————— Axios Client قوي —————— */
const client = axios.create({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml"
  },
  validateStatus: s => s >= 200 && s < 500
});

/* —————— استخراج عنوان الجدول —————— */
function getTableTitle($, table, index) {
  return (
    $(table).find("caption").text().trim() ||
    $(table).prevAll("h1,h2,h3,h4").first().text().trim() ||
    $(table).closest("section,div").find("h2,h3").first().text().trim() ||
    `table_${index}`
  );
}

/* —————— تحليل جدول واحد RAW 100% —————— */
function parseTable($, table) {
  const headers = [];

  $(table)
    .find("thead th")
    .each((_, th) => {
      headers.push($(th).text().trim() || `col_${headers.length}`);
    });

  const rows = [];

  $(table)
    .find("tbody tr")
    .each((_, tr) => {
      const row = {};

      $(tr)
        .find("td")
        .each((i, td) => {
          const key = headers[i] || `col_${i}`;
          const cell = $(td);

          row[key] = {
            text: cell.text().replace(/\s+/g, " ").trim() || null,
            html: cell.html() || null,
            links: cell.find("a").map((_, a) => $(a).attr("href")).get(),
            images: cell
              .find("img")
              .map((_, img) =>
                $(img).attr("data-src") ||
                $(img).attr("data-lazy") ||
                $(img).attr("src")
              )
              .get()
          };
        });

      if (Object.keys(row).length) rows.push(row);
    });

  return rows;
}

/* —————— جلب كل الجداول من صفحة واحدة —————— */
async function fetchLeagueTables(league, retries = 4) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const timeout = 20000 + attempt * 10000;
      const res = await client.get(league.url, { timeout });

      if (res.status !== 200) {
        throw new Error(`HTTP ${res.status}`);
      }

      if (!res.data || res.data.length < 5000) {
        throw new Error("Empty or blocked HTML");
      }

      const $ = cheerio.load(res.data);
      const tables = [];

      $("table").each((i, table) => {
        const rows = parseTable($, table);
        if (!rows.length) return;

        tables.push({
          index: i,
          title: getTableTitle($, table, i),
          rows
        });
      });

      if (!tables.length) {
        throw new Error("No tables found");
      }

      return tables;
    } catch (err) {
      if (attempt === retries) {
        return { error: err.message };
      }

      const delay = 2000 * attempt + Math.random() * 1500;
      await sleep(delay);
    }
  }
}

/* —————— جلب جميع الدوريات (Concurrency آمن) —————— */
export default async function fetchAllLeagues(concurrency = 2) {
  const results = {};
  const failed = [];

  const queue = [...LEAGUES];

  async function worker(id) {
    while (queue.length) {
      const league = queue.shift();
      if (!league) return;

      console.log(`👷 Worker ${id} → ${league.name}`);

      const data = await fetchLeagueTables(league);

      if (Array.isArray(data)) {
        results[league.name] = {
          url: league.url,
          tables: data
        };
        console.log(
          `✅ ${league.name} → ${data.length} tables`
        );
      } else {
        failed.push({
          name: league.name,
          url: league.url,
          reason: data?.error || "unknown"
        });
        console.log(`❌ ${league.name}`);
      }

      await sleep(800 + Math.random() * 1200);
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => worker(i + 1))
  );

  fs.writeFileSync(DATA_FILE, JSON.stringify(results, null, 2));
  fs.writeFileSync(FAILED_FILE, JSON.stringify(failed, null, 2));

  console.log(`🎉 Saved → ${DATA_FILE}`);
  if (failed.length) console.log(`⚠ Failed → ${FAILED_FILE}`);

  return results;
}
