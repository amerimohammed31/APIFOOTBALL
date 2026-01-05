const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const Match = require("./models/Match");

async function fetchMatches() {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", req => {
    if (["font", "media"].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  await page.goto("https://onefootball.com/en/matches", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector("div.SectionHeader_container__iVfZ9", { timeout: 90000 });
  const html = await page.content();
  const $ = cheerio.load(html);

  const matches = [];

  $("div.SectionHeader_container__iVfZ9").each((_, section) => {
    const league = $(section).find("h2").text().trim();
    const matchday = $(section).find("h3").text().trim();
    let next = $(section).next();

    while (next.length && !next.hasClass("SectionHeader_container__iVfZ9")) {
      next.find("a.MatchCard_matchCard__iOv4G").each((__, card) => {
        const teamNames = $(card).find(".SimpleMatchCardTeam_simpleMatchCardTeam__name__7Ud8D");
        const scores = $(card).find(".SimpleMatchCardTeam_simpleMatchCardTeam__score__UYMc_");
        const logos = $(card).find(".SimpleMatchCardTeam_simpleMatchCardTeam__logo__7Vzpw img");

        const homeTeam = $(teamNames[0]).text().trim();
        const awayTeam = $(teamNames[1]).text().trim();
        const homeLogo = $(logos[0]).attr("src") || "";
        const awayLogo = $(logos[1]).attr("src") || "";
        const homeScore = $(scores[0]).text().trim();
        const awayScore = $(scores[1]).text().trim();

        let status = "Upcoming";
        let time = "";

        if ($(card).find(".SimpleMatchCard_simpleMatchCard__live__kg0bW").length) {
          status = "Live";
          time = $(card).find(".SimpleMatchCard_simpleMatchCard__live__kg0bW").text().trim();
        }

        if ($(card).find(".SimpleMatchCard_simpleMatchCard__infoMessage___NJqW").text().includes("Full time")) {
          status = "Finished";
        }

        const timeTag = $(card).find("time");
        if (timeTag.length && !time) time = timeTag.attr("datetime") || timeTag.text().trim();

        matches.push({ league, matchday, homeTeam, homeLogo, awayTeam, awayLogo, score: homeScore && awayScore ? `${homeScore} - ${awayScore}` : "", status, time });
      });

      next = next.next();
    }
  });

  await Match.deleteMany({});
  await Match.insertMany(matches);

  await browser.close();
  console.log(`✅ Updated ${matches.length} matches in DB`);
}

module.exports = fetchMatches;