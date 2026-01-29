import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";

const FILE_PATH = path.resolve("Match-Today.json");
const BASE_URL = "https://www.footmercato.net";
const URL = BASE_URL + "/live/";

// axios instance احترافي
const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
  },
});

// delay لمنع الحظر
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================
   Retry Request (مهم جداً للـ scraping)
========================================= */
async function safeRequest(url, retries = 3) {
  try {
    const res = await http.get(url);
    return res.data;
  } catch (err) {
    if (retries > 0) {
      await sleep(1500);
      return safeRequest(url, retries - 1);
    }
    console.error("❌ Failed:", url);
    return null;
  }
}

/* =========================================
   استخراج تفاصيل المباراة كاملة
========================================= */
async function fetchMatchDetails(link, liveId) {
  // استخدام الرابط الصحيح stats لكل مباراة
  const statsLink = `${BASE_URL}/live/${liveId}/stats`;

  const html = await safeRequest(statsLink);
  if (!html) return {};

  const $ = cheerio.load(html);

  const details = {
    stadium: $(".matchHeader__stadium").text().trim() || null,
    referee: $(".matchHeader__referee").text().trim() || null,
    competition: $(".matchHeader__competition").text().trim() || null,
    stats: {},
  };

  $("#tabMatchStats .blockVertical, #tabMatchStats .blockSingle, #tabMatchStats .blockHorizontal").each(
    (_, block) => {
      const blockTitle = $(block)
        .find(
          ".blockVertical__title .title__left, .blockSingle__title .title__left, .blockHorizontal__title .title__left"
        )
        .text()
        .trim();

      if (!blockTitle) return;

      // ----- BlockVertical -----
      if ($(block).hasClass("blockVertical")) {
        const contents = {};
        $(block)
          .find(".blockVertical__content")
          .each((_, content) => {
            const label = $(content)
              .find(".statInline__title")
              .text()
              .trim();
            const home = $(content)
              .find(".statInline__value .statInline__valueMain")
              .first()
              .text()
              .trim();
            const away = $(content)
              .find(".statInline__value .statInline__valueMain")
              .last()
              .text()
              .trim();

            if (label) contents[label] = { home, away };
          });

        if (Object.keys(contents).length) details.stats[blockTitle] = contents;
      }

      // ----- BlockSingle (Face à face) -----
      if ($(block).hasClass("blockSingle")) {
        const players = [];
        $(block)
          .find(".matchBestPlayersComparator__players a.personCard")
          .each((_, playerEl) => {
            const name = $(playerEl).find(".personCard__name").text().trim();
            const desc = $(playerEl).find(".personCard__description").text().trim();
            const link = $(playerEl).attr("href");
            const image = $(playerEl).find("img").attr("data-src");
            players.push({ name, desc, link, image });
          });

        const compareLink = $(block)
          .find("a[data-modal='modalMatchStatComparator']")
          .attr("data-api");

        if (players.length)
          details.stats[blockTitle] = { players, compareLink };
      }

      // ----- BlockHorizontal (Tops & Flops) -----
      if ($(block).hasClass("blockHorizontal")) {
        const horizontalStats = [];
        $(block)
          .find(".blockHorizontal__content")
          .each((_, hContent) => {
            const statName = $(hContent)
              .find(".statsStandings__headerTitle")
              .text()
              .trim();
            const players = [];
            $(hContent)
              .find(".statsStandings__ranking")
              .each((_, pEl) => {
                const rank = $(pEl)
                  .find(".statsStandings__rank")
                  .text()
                  .trim();
                const name = $(pEl)
                  .find(".statsStandings__name")
                  .text()
                  .trim();
                const logo = $(pEl).find("img").attr("data-src");
                const valueHighlight = $(pEl)
                  .find(".statsStandings__value--highlight")
                  .text()
                  .trim();
                const value = $(pEl)
                  .find(".statsStandings__value")
                  .not(".statsStandings__value--highlight")
                  .text()
                  .trim();
                const link = $(pEl).attr("href");

                players.push({ rank, name, logo, valueHighlight, value, link });
              });

            if (statName) horizontalStats.push({ statName, players });
          });

        if (horizontalStats.length)
          details.stats[blockTitle] = horizontalStats;
      }
    }
  );

  return details;
}

/* =========================================
   MAIN SCRAPER
========================================= */
export async function fetchMatchToday() {
  try {
    console.log("🚀 Fetching matches...");

    const html = await safeRequest(URL);
    if (!html) return [];

    const $ = cheerio.load(html);
    const leagues = [];
    const matchesToFetchDetails = [];

    $(".matchesGroup").each((_, leagueEl) => {
      const leagueName = $(leagueEl)
        .find(".title__leftLink")
        .text()
        .trim();
      const leagueLogo = $(leagueEl).find("img").attr("data-src") || "";

      const matches = [];

      $(leagueEl)
        .find(".matchesGroup__match")
        .each((_, matchEl) => {
          const matchFull = $(matchEl).find(".matchFull");
          const matchPath = matchFull.find("a.matchFull__link").attr("href") || "";
          if (!matchPath) return;

          const homeEl = matchFull.find(".matchFull__team").first();
          const awayEl = matchFull.find(".matchFull__team--away");

          const homeScore = homeEl.find(".matchFull__score").text().trim();
          const awayScore = awayEl.find(".matchFull__score").text().trim();
          const isLive = matchFull.attr("data-live") === "1";

          let status = "NS";
          if (isLive) status = "LIVE";
          else if (homeScore && awayScore) status = "FT";

          const match = {
            liveId: matchFull.attr("data-live-id") || null,
            matchLink: BASE_URL + matchPath,
            status,
            isLive,
            time: matchFull.find(".matchFull__infosDate time").attr("datetime") || "",
            homeTeam: {
              name: homeEl.find(".matchTeam__name").text().trim(),
              logo: homeEl.find("img").attr("data-src") || "",
            },
            awayTeam: {
              name: awayEl.find(".matchTeam__name").text().trim(),
              logo: awayEl.find("img").attr("data-src") || "",
            },
            score: homeScore && awayScore ? `${homeScore}-${awayScore}` : null,
            details: {}, // سيتم ملؤها لاحقاً
          };

          matches.push(match);
          matchesToFetchDetails.push(match);
        });

      if (matches.length) {
        leagues.push({ leagueName, leagueLogo, matches });
      }
    });

    console.log("📊 Fetching match details...");
    for (const match of matchesToFetchDetails) {
      await sleep(1200); // مهم لتجنب الحظر
      match.details = await fetchMatchDetails(match.matchLink, match.liveId);
    }

    // دمج مع البيانات القديمة بدون تكرار
    let oldData = [];
    if (fs.existsSync(FILE_PATH)) {
      const raw = fs.readFileSync(FILE_PATH, "utf-8");
      oldData = JSON.parse(raw);
    }

    const mergedLeagues = [...oldData];
    for (const newLeague of leagues) {
      const existingLeague = mergedLeagues.find(
        (l) => l.leagueName === newLeague.leagueName
      );
      if (existingLeague) {
        for (const match of newLeague.matches) {
          if (
            !existingLeague.matches.some(
              (m) => m.liveId === match.liveId || m.matchLink === match.matchLink
            )
          ) {
            existingLeague.matches.push(match);
          }
        }
      } else {
        mergedLeagues.push(newLeague);
      }
    }

    fs.writeFileSync(FILE_PATH, JSON.stringify(mergedLeagues, null, 2), "utf-8");
    console.log("✅ SCRAPER COMPLETED");

    return mergedLeagues;
  } catch (err) {
    console.error("❌ Fatal Error:", err.message);
    return [];
  }
}
