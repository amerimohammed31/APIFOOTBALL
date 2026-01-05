import axios from "axios";
import cheerio from "cheerio";
import mongoose from "mongoose";
import Match from "./models/Match.js";
import dotenv from "dotenv";

dotenv.config();

const URL = "https://onefootball.com/en/matches";

async function fetchMatches() {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const { data } = await axios.get(URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
      },
      timeout: 20000,
    });

    const $ = cheerio.load(data);
    const matches = [];

    $(".SectionHeader_container__iVfZ9").each((_, section) => {
      const leagueName = $(section)
        .find(".Title_leftAlign__mYh6r")
        .text()
        .trim();

      const leagueLink =
        "https://onefootball.com" +
        $(section).find("a").attr("href");

      const leagueLogo =
        $(section).find("img").attr("src") || "";

      const container = $(section).next();

      container.find("a.MatchCard_matchCard__K36mC").each((__, match) => {
        const matchLink =
          "https://onefootball.com" + $(match).attr("href");

        const homeTeam = $(match)
          .find(".MatchCardTeam_home__pui4c .MatchCardTeam_name__n8GJY")
          .text()
          .trim();

        const awayTeam = $(match)
          .find(".MatchCardTeam_away__C0yA4 .MatchCardTeam_name__n8GJY")
          .text()
          .trim();

        const homeLogo =
          $(match)
            .find(".MatchCardTeam_home__pui4c img")
            .attr("src") || "";

        const awayLogo =
          $(match)
            .find(".MatchCardTeam_away__C0yA4 img")
            .attr("src") || "";

        if (!homeTeam || !awayTeam) return;

        matches.push({
          leagueName,
          leagueLink,
          leagueLogo,
          matchLink,
          homeTeam,
          awayTeam,
          homeLogo,
          awayLogo,
          updatedAt: new Date(),
        });
      });
    });

    await Match.deleteMany({});
    await Match.insertMany(matches);

    console.log(`✅ Saved ${matches.length} matches`);
    mongoose.disconnect();
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

fetchMatches();
