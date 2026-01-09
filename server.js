import express from "express";
import fs from "fs";

// ===== IMPORT FUNCTIONS SAFELY =====
// كل import يحاول استخدام default أو named export
import * as LaLigaModule from "./fetchLaLigaStandings.js";
import * as MatchTodayModule from "./fetchMatchToday.js";
import * as PremierModule from "./fetchPremierLeagueStandings.js";
import * as Ligue1Module from "./fetchLigue1Standings.js";
import * as SerieAModule from "./fetchSerieAStandings.js";
import * as BundesligaModule from "./fetchBundesligaStandings.js";

// استخراج الدوال سواء كانت default أو named
const fetchLaLigaStandings = LaLigaModule.default || LaLigaModule.fetchLaLigaStandings;
const fetchMatchToday = MatchTodayModule.default || MatchTodayModule.fetchMatchToday;
const fetchPremierLeagueStandings = PremierModule.default || PremierModule.fetchPremierLeagueStandings;
const fetchLigue1Standings = Ligue1Module.default || Ligue1Module.fetchLigue1Standings;
const fetchSerieAStandings = SerieAModule.default || SerieAModule.fetchSerieAStandings;
const fetchBundesligaStandings = BundesligaModule.default || BundesligaModule.fetchBundesligaStandings;

const app = express();
const PORT = 3000;

/* ===== CONFIG ===== */
const LEAGUES = {
  matchtoday: { file: "./Match-Today.json", fetch: fetchMatchToday },
  laliga: { file: "./laliga_standings.json", fetch: fetchLaLigaStandings },
  premierleague: { file: "./premierleague_standings.json", fetch: fetchPremierLeagueStandings },
  ligue1: { file: "./ligue1_standings.json", fetch: fetchLigue1Standings },
  seriea: { file: "./seriea_standings.json", fetch: fetchSerieAStandings },
  bundesliga: { file: "./bundesliga_standings.json", fetch: fetchBundesligaStandings },
};

/* ===== ROUTE UNIFIED ===== */
app.get("/standings/:league", (req, res) => {
  const league = req.params.league.toLowerCase();
  const config = LEAGUES[league];

  if (!config) {
    return res.status(404).json({
      error: "League not supported",
      supported: Object.keys(LEAGUES),
    });
  }

  try {
    if (!fs.existsSync(config.file)) return res.json([]);
    const data = JSON.parse(fs.readFileSync(config.file, "utf-8"));
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Invalid data file" });
  }
});

/* ===== INITIAL FETCH ===== */
Promise.all(Object.values(LEAGUES).map(l => l.fetch()));

/* ===== UPDATE EVERY 30 MIN ===== */
setInterval(() => {
  Promise.all(Object.values(LEAGUES).map(l => l.fetch()));
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
  console.log("📊 Available leagues:");
  Object.keys(LEAGUES).forEach((l) =>
    console.log(`   → /standings/${l}`)
  );
});
