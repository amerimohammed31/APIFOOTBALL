import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

const URL = "https://onefootball.com/en/matches";
const FILE_PATH = "./matches.json";

/* ===== أدوات مساعدة ===== */

// استخراج اسم الدوري بأمان
function extractLeague(section) {
  return (
    section.find("h2").first().text().trim() ||
    section.find("span.screen-reader-only").first().text().trim() ||
    null
  );
}

// حالة المباراة
function getStatus(time) {
  if (!time) return "NS";
  if (time.includes(":")) return "NS";
  if (time.toLowerCase().includes("ft")) return "FT";
  return "LIVE";
}

async function fetchMatches() {
  try {
    console.log("⏱ Fetching matches...");

    const { data } = await axios.get(URL, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);

    const leaguesMap = {};
    let currentSection = null;

    $(".SectionHeader_container__iVfZ9, .MatchCard_matchCard__iOv4G").each((_, el) => {
      const element = $(el);

      // Header الدوري
      if (element.hasClass("SectionHeader_container__iVfZ9")) {
        currentSection = element;
        return;
      }

      // كارت المباراة
      if (!element.hasClass("MatchCard_matchCard__iOv4G")) return;
      if (!currentSection) return;

      const league = extractLeague(currentSection);

      const leagueLink = currentSection.find("a").attr("href")
        ? "https://onefootball.com" + currentSection.find("a").attr("href")
        : null;

      const leagueLogo = currentSection.find("img").attr("src") || null;

      const matchLink = element.attr("href")
        ? "https://onefootball.com" + element.attr("href")
        : null;

      const homeTeam = element
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__name__7Ud8D")
        .first()
        .text()
        .trim();

      const awayTeam = element
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__name__7Ud8D")
        .last()
        .text()
        .trim();

      const homeScore = element
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__score__UYMc_")
        .first()
        .text()
        .trim() || null;

      const awayScore = element
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__score__UYMc_")
        .last()
        .text()
        .trim() || null;

      const homeLogo = element
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__logo__7Vzpw img")
        .first()
        .attr("src") || null;

      const awayLogo = element
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__logo__7Vzpw img")
        .last()
        .attr("src") || null;

      const time = element.find("time").text().trim() || null;

      const match = {
        league,
        leagueLink,
        leagueLogo,
        matchLink,
        homeTeam,
        homeScore,
        homeLogo,
        awayTeam,
        awayScore,
        awayLogo,
        time,
        status: getStatus(time),
        updatedAt: new Date().toISOString(),
      };

      if (!leaguesMap[league]) leaguesMap[league] = [];
      leaguesMap[league].push(match);
    });

    // ترتيب حسب الدوري
    const sortedData = Object.keys(leaguesMap).map((league) => ({
      league,
      matches: leaguesMap[league],
    }));

    if (sortedData.length > 0) {
      fs.writeFileSync(FILE_PATH, JSON.stringify(sortedData, null, 2));
      console.log("✅ matches.json updated (all old fields kept + league fixed)");
    } else {
      console.log("⚠️ No data collected – file not overwritten");
    }
  } catch (err) {
    console.error("❌ Fetch error:", err.message);
  }
}

export default fetchMatches;
