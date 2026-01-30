import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

const FILE_PATH = "./Match-Today.json";
const URL = "https://www.footmercato.net/live/";

const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent": "Mozilla/5.0",
  },
});

// ✅ استخراج الإحصاءات بطريقة احترافية
async function fetchStats(statsURL) {
  try {
    const { data } = await http.get(statsURL);
    const $ = cheerio.load(data);

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
          const title = $(el)
            .find(".statInline__title, .statShotsFull__titleMain")
            .first()
            .text()
            .trim();

          // 🔥 مهم: لا تعتمد على highlight
          const values = $(el).find(".statInline__valueMain");

          let home = "";
          let away = "";

          if (values.length >= 2) {
            home = values.first().text().trim();
            away = values.last().text().trim();
          }

          // معالجة خاصة لـ shots
          if (!title && $(el).find(".statShotsFull").length) {
            const shot = $(el).find(".statShotsFull");

            const t = shot.find(".statShotsFull__titleMain").text().trim();

            const nums = shot.find(".statShotsFull__shot");

            if (nums.length >= 2) {
              items.push({
                title: t,
                home: nums.first().text().trim(),
                away: nums.last().text().trim(),
              });
            }

            return;
          }

          if (title && home !== "" && away !== "") {
            items.push({ title, home, away });
          }
        });

      if (items.length) {
        stats[category] = items;
      }
    });

    return stats;
  } catch {
    return {}; // لا توقف السكريبت
  }
}

export async function fetchMatchToday() {
  try {
    const { data } = await http.get(URL);
    const $ = cheerio.load(data);

    const leagues = [];

    const leagueElements = $(".matchesGroup").toArray();

    for (const leagueEl of leagueElements) {
      const leagueName = $(leagueEl).find(".title__leftLink").text().trim();

      const leagueLogo =
        $(leagueEl).find(".title__leftLink img").attr("data-src") || "";

      const matches = [];
      const matchElements = $(leagueEl).find(".matchesGroup__match").toArray();

      // 🔥 نجلب stats بشكل متوازي (أسرع بكثير)
      const matchPromises = matchElements.map(async (matchEl) => {
        const matchFull = $(matchEl).find(".matchFull");

        const liveId = matchFull.attr("data-live-id") || null;
        const href = matchFull.find("a.matchFull__link").attr("href") || "";

        const matchLink = "https://www.footmercato.net" + href;

        const statsURL = `https://www.footmercato.net${href}/stats`;

        const homeEl = matchFull.find(".matchFull__team").first();
        const awayEl = matchFull.find(".matchFull__team--away");

        const homeScore = homeEl.find(".matchFull__score").text().trim();
        const awayScore = awayEl.find(".matchFull__score").text().trim();

        const score =
          homeScore && awayScore ? `${homeScore} - ${awayScore}` : null;

        const homeTeam = {
          name: homeEl.find(".matchTeam__name").text().trim(),
          logo: homeEl.find("img").attr("data-src") || "",
        };

        const awayTeam = {
          name: awayEl.find(".matchTeam__name").text().trim(),
          logo: awayEl.find("img").attr("data-src") || "",
        };

        const isLive = matchFull.attr("data-live") === "1";

        let status = "scheduled";

        if (isLive) status = "live";
        else if (
          matchFull.text().toLowerCase().includes("terminé")
        )
          status = "finished";

        const time =
          matchFull.find("time").attr("datetime") ||
          matchFull.find(".matchFull__dateTimeChrono").text().trim() ||
          "";

        // 🔥 الأهداف
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

        // 🔥 القنوات
        const broadcasts = [];
        matchFull.find(".matchFull__broadcastImage").each((_, img) => {
          const src = $(img).attr("data-src");
          if (src) broadcasts.push(src);
        });

        // 🔥 الفائز
        let winner = null;
        if (status === "finished" && homeScore && awayScore) {
          if (+homeScore > +awayScore) winner = "home";
          else if (+awayScore > +homeScore) winner = "away";
          else winner = "draw";
        }

        // ✅ جلب الإحصاءات
        const stats = await fetchStats(statsURL);

        return {
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
          stats, // 👈 تمت إضافتها بدون كسر أي بيانات قديمة
        };
      });

      const resolvedMatches = await Promise.all(matchPromises);

      if (resolvedMatches.length) {
        leagues.push({
          leagueName,
          leagueLogo,
          matches: resolvedMatches,
        });
      }
    }

    fs.writeFileSync(FILE_PATH, JSON.stringify(leagues, null, 2));

    console.log("✅ MatchToday updated WITH FULL STATS");

    return leagues;
  } catch (err) {
    console.error("❌ Error:", err.message);
    return [];
  }
}
