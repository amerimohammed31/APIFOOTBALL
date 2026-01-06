import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";

const URL = "https://onefootball.com/en/matches";
const FILE_PATH = "./matches.json";

/* ===== Helpers ===== */

function extractLeague(section) {
  return (
    section.find("h2").first().text().trim() ||
    section.find("span.screen-reader-only").first().text().trim() ||
    "-"
  );
}

function getStatus(time) {
  if (!time) return "NS";
  if (time.includes(":")) return "NS";
  if (time.toLowerCase().includes("ft")) return "FT";
  return "LIVE";
}

async function fetchMatches() {
  try {
    const { data } = await axios.get(URL, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);
    const matches = [];

    let currentSection = null;

    $(".SectionHeader_container__iVfZ9, .MatchCard_matchCard__iOv4G").each((_, el) => {
      const element = $(el);

      if (element.hasClass("SectionHeader_container__iVfZ9")) {
        currentSection = element;
        return;
      }

      if (!currentSection) return;

      const league = extractLeague(currentSection);

      const home_team = element
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__name__7Ud8D")
        .first()
        .text()
        .trim();

      const away_team = element
        .find(".SimpleMatchCardTeam_simpleMatchCardTeam__name__7Ud8D")
        .last()
        .text()
        .trim();

      const home_team_score =
        element
          .find(".SimpleMatchCardTeam_simpleMatchCardTeam__score__UYMc_")
          .first()
          .text()
          .trim() || "-";

      const away_team_score =
        element
          .find(".SimpleMatchCardTeam_simpleMatchCardTeam__score__UYMc_")
          .last()
          .text()
          .trim() || "-";

      const home_team_logo =
        element
          .find(".SimpleMatchCardTeam_simpleMatchCardTeam__logo__7Vzpw img")
          .first()
          .attr("src") || null;

      const away_team_logo =
        element
          .find(".SimpleMatchCardTeam_simpleMatchCardTeam__logo__7Vzpw img")
          .last()
          .attr("src") || null;

      const date = element.find("time").text().trim() || null;
      const status = getStatus(date);

      matches.push({
        home_team,
        home_team_logo,
        home_team_score,
        away_team,
        away_team_logo,
        away_team_score,
        status,
        date,
        league,
      });
    });

    if (matches.length > 0) {
      fs.writeFileSync(FILE_PATH, JSON.stringify(matches, null, 2));
    }
  } catch (err) {
    console.error("Fetch error:", err.message);
  }
}

export default fetchMatches;
