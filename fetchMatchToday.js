import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import pLimit from "p-limit";

const FILE_PATH = "./Match-Today.json";
const URL = "https://www.footmercato.net/live/";

const http = axios.create({
  timeout: 25000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    Connection: "keep-alive",
  },
});

const limit = pLimit(5); // 🚨 لا ترفعها فوق 5

// ✅ retry تلقائي إذا تم الحظر
async function safeRequest(url, retries = 3) {
  try {
    const { data } = await http.get(url);

    // Cloudflare check
    if (
      data.includes("Just a moment") ||
      data.includes("Checking your browser")
    ) {
      throw new Error("Blocked by Cloudflare");
    }

    return data;
  } catch (err) {
    if (retries === 0) return null;

    await new Promise((r) => setTimeout(r, 1500));

    return safeRequest(url, retries - 1);
  }
}

// ================== STATS ==================
async function fetchStats(statsURL) {
  const html = await safeRequest(statsURL);

  if (!html) return {};

  const $ = cheerio.load(html);

  // إذا لا توجد stats
  if (!$(".blockVertical").length) return {};

  const stats = {};

  $(".blockVertical").each((_, block) => {
    const category = $(block)
      .find(".title__left")
      .text()
      .trim()
      .replace(/\s+/g, " ");

    if (!category) return;

    const items = [];

    $(block)
      .find(".blockVertical__content")
      .each((_, el) => {
        const shotBlock = $(el).find(".statShotsFull");

        // 🔥 shots
        if (shotBlock.length) {
          const title = shotBlock
            .find(".statShotsFull__titleMain")
            .text()
            .trim();

          const nums = shotBlock.find(".statShotsFull__shot");

          if (nums.length >= 2) {
            items.push({
              title,
              home: nums.first().text().trim(),
              away: nums.last().text().trim(),
            });
          }

          return;
        }

        const title = $(el)
          .find(".statInline__title")
          .text()
          .trim();

        const values = $(el).find(".statInline__valueMain");

        if (values.length < 2) return;

        items.push({
          title,
          home: values.first().text().trim(),
          away: values.last().text().trim(),
        });
      });

    if (items.length) stats[category] = items;
  });

  return stats;
}

// ================== MAIN ==================
export async function fetchMatchToday() {
  try {
    const html = await safeRequest(URL);

    if (!html) throw new Error("Failed to load live page");

    const $ = cheerio.load(html);

    const leagues = [];

    const leagueElements = $(".matchesGroup").toArray();

    for (const leagueEl of leagueElements) {
      const leagueName = $(leagueEl).find(".title__leftLink").text().trim();

      const leagueLogo =
        $(leagueEl).find("img").attr("data-src") ||
        $(leagueEl).find("img").attr("src") ||
        "";

      const matchElements = $(leagueEl)
        .find(".matchesGroup__match")
        .toArray();

      const matches = await Promise.all(
        matchElements.map((matchEl) =>
          limit(async () => {
            const matchFull = $(matchEl).find(".matchFull");

            const href =
              matchFull.find("a.matchFull__link").attr("href") || "";

            if (!href.includes("/live/")) return null;

            const statsURL = `https://www.footmercato.net${href}/stats`;

            const homeEl = matchFull.find(".matchFull__team").first();
            const awayEl = matchFull.find(".matchFull__team--away");

            const homeScore = homeEl.find(".matchFull__score").text().trim();
            const awayScore = awayEl.find(".matchFull__score").text().trim();

            const score =
              homeScore && awayScore ? `${homeScore} - ${awayScore}` : null;

            const isLive = matchFull.attr("data-live") === "1";

            let status = "scheduled";

            const text = matchFull.text().toLowerCase();

            if (isLive) status = "live";
            else if (
              text.includes("termin") ||
              text.includes("ft") ||
              text.includes("finished")
            ) {
              status = "finished";
            }

            let winner = null;

            if (status === "finished" && homeScore && awayScore) {
              if (+homeScore > +awayScore) winner = "home";
              else if (+awayScore > +homeScore) winner = "away";
              else winner = "draw";
            }

            const broadcasts = [];

            matchFull.find(".matchFull__broadcastImage").each((_, img) => {
              const src =
                $(img).attr("data-src") || $(img).attr("src");

              if (src) broadcasts.push(src);
            });

            const goals = { home: [], away: [] };

            matchFull
              .find(".matchFull__strikers--home .matchFull__striker")
              .each((_, g) => {
                goals.home.push({
                  player: $(g)
                    .find(".matchFull__strikerName")
                    .text()
                    .trim(),
                  minute: $(g)
                    .find(".matchFull__strikerTime")
                    .text()
                    .trim(),
                });
              });

            matchFull
              .find(".matchFull__strikers--away .matchFull__striker")
              .each((_, g) => {
                goals.away.push({
                  player: $(g)
                    .find(".matchFull__strikerName")
                    .text()
                    .trim(),
                  minute: $(g)
                    .find(".matchFull__strikerTime")
                    .text()
                    .trim(),
                });
              });

            const stats = await fetchStats(statsURL);

            return {
              liveId: matchFull.attr("data-live-id") || null,
              matchLink: "https://www.footmercato.net" + href,
              homeTeam: {
                name: homeEl.find(".matchTeam__name").text().trim(),
                logo:
                  homeEl.find("img").attr("data-src") ||
                  homeEl.find("img").attr("src") ||
                  "",
              },
              awayTeam: {
                name: awayEl.find(".matchTeam__name").text().trim(),
                logo:
                  awayEl.find("img").attr("data-src") ||
                  awayEl.find("img").attr("src") ||
                  "",
              },
              score,
              status,
              time:
                matchFull.find("time").attr("datetime") ||
                "",
              isLive,
              winner,
              broadcasts,
              goals,
              stats,
            };
          })
        )
      );

      leagues.push({
        leagueName,
        leagueLogo,
        matches: matches.filter(Boolean),
      });
    }

    fs.writeFileSync(FILE_PATH, JSON.stringify(leagues, null, 2));

    console.log("✅ FULL MATCH DATA WITH STATS SAVED");

    return leagues;
  } catch (err) {
    console.error("❌ Error:", err.message);
    return [];
  }
}
