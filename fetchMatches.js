import axios from "axios";
import * as cheerio from "cheerio";
import Match from "./models/Match.js";

const ONEFOOTBALL_URL = "https://www.onefootball.com/en/football-matches";

async function fetchMatches() {
  const { data } = await axios.get(ONEFOOTBALL_URL);
  const $ = cheerio.load(data);

  const matches = [];

  $(".MatchCard_matchCard__iOv4G").each((i, el) => {
    const league = $(el).closest(".SectionHeader_container__iVfZ9").find(".SectionHeader_title__bD8pp h2").text().trim();
    const matchLink = $(el).attr("href") ? "https://onefootball.com" + $(el).attr("href") : null;

    const leagueLink = $(el).closest(".SectionHeader_container__iVfZ9").find(".SectionHeader_link__K8K1f").attr("href");
    const leagueLogo = $(el).closest(".SectionHeader_container__iVfZ9").find("img.EntityLogo_entityLogoImage__4X0wF").attr("src");

    const homeTeam = $(el).find(".SimpleMatchCardTeam_simpleMatchCardTeam__name__7Ud8D").first().text().trim();
    const homeScore = $(el).find(".SimpleMatchCardTeam_simpleMatchCardTeam__score__UYMc_").first().text().trim();
    const homeLogo = $(el).find(".SimpleMatchCardTeam_simpleMatchCardTeam__logo__7Vzpw img").first().attr("src");

    const awayTeam = $(el).find(".SimpleMatchCardTeam_simpleMatchCardTeam__name__7Ud8D").last().text().trim();
    const awayScore = $(el).find(".SimpleMatchCardTeam_simpleMatchCardTeam__score__UYMc_").last().text().trim();
    const awayLogo = $(el).find(".SimpleMatchCardTeam_simpleMatchCardTeam__logo__7Vzpw img").last().attr("src");

    const time = $(el).find(".SimpleMatchCard_simpleMatchCard__live__kg0bW, .SimpleMatchCard_simpleMatchCard__preMatch__BtjKV time").text().trim();

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
      time
    });
  });

  // حذف البيانات القديمة واستبدالها بالجديدة
  await Match.deleteMany({});
  await Match.insertMany(matches);
  console.log("✅ Matches updated:", matches.length);
}

export default fetchMatches;
