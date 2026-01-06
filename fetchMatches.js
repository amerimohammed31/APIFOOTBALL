import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

const ONEFOOTBALL_URL = "https://onefootball.com/en/matches";
const FILE_PATH = "./matches.json";

function getMatchStatus(time) {
  if (!time) return "NS";
  if (time.includes(":")) return "NS";
  if (time.toLowerCase().includes("ft")) return "FT";
  return "LIVE";
}

async function fetchMatches() {
  try {
    console.log("⏱ Fetching matches...");

    const { data } = await axios.get(ONEFOOTBALL_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);
    const matches = [];

    $(".MatchCard_matchCard__iOv4G").each((_, el) => {
      const section = $(el).closest(".SectionHeader_container__iVfZ9");

      const league = section.find("h2").text().trim();
      const leagueLink = section.find("a").attr("href")
        ? "https://onefootball.com" + section.find("a").attr("href")
        : null;

      const leagueLogo = section.find("img").attr("src") || null;

      const matchLink = $(el).attr("href")
        ? "https://onefootball.com" + $(el).attr("href")
        : null;

      const homeTeam = $(el)
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__name__7Ud8D")
        .first()
        .text()
        .trim();

      const awayTeam = $(el)
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__name__7Ud8D")
        .last()
        .text()
        .trim();

      const homeScore = $(el)
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__score__UYMc_")
        .first()
        .text()
        .trim() || null;

      const awayScore = $(el)
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__score__UYMc_")
        .last()
        .text()
        .trim() || null;

      const homeLogo = $(el)
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__logo__7Vzpw img")
        .first()
        .attr("src") || null;

      const awayLogo = $(el)
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__logo__7Vzpw img")
        .last()
        .attr("src") || null;

      const time = $(el)
        .find(
          ".SimpleMatchCard_simpleMatchCard__live__kg0bW, .SimpleMatchCard_simpleMatchCard__preMatch__BtjKV time"
        )
        .text()
        .trim() || null;

      if (!homeTeam || !awayTeam) return;

      matches.push({
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
        status: getMatchStatus(time),
        updatedAt: new Date().toISOString(),
      });
    });

    if (matches.length > 0) {
      fs.writeFileSync(FILE_PATH, JSON.stringify(matches, null, 2));
      console.log(`✅ Saved ${matches.length} matches`);
    } else {
      console.log("⚠️ No matches found – file not overwritten");
    }

  } catch (err) {
    console.error("❌ Fetch error:", err.message);
  }
}

export default fetchMatches;
