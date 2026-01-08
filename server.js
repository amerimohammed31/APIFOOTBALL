import express from "express";
import fs from "fs";

import fetchLaLigaStandings from "./fetchLaLigaStandings.js";
import fetchPremierLeagueStandings from "./fetchPremierLeagueStandings.js";
import fetchLigue1Standings from "./fetchLigue1Standings.js";
import fetchSerieAStandings from "./fetchSerieAStandings.js";
import fetchBundesligaStandings from "./fetchBundesligaStandings.js";

const app = express();
const PORT = 3000;

/* ===== CONFIG ===== */
const LEAGUES = {
  laliga: {
    file: "./laliga_standings.json",
    fetch: fetchLaLigaStandings,
  },
  premierleague: {
    file: "./premierleague_standings.json",
    fetch: fetchPremierLeagueStandings,
  },
  ligue1: {
    file: "./ligue1_standings.json",
    fetch: fetchLigue1Standings,
  },
  seriea: {
    file: "./seriea_standings.json",
    fetch: fetchSerieAStandings,
  },
  bundesliga: {
    file: "./bundesliga_standings.json",
    fetch: fetchBundesligaStandings,
  },
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
  } catch {
    res.status(500).json({ error: "Invalid data file" });
  }
});

/* ===== INITIAL FETCH ===== */
Object.values(LEAGUES).forEach((l) => l.fetch());

/* ===== UPDATE EVERY HOUR ===== */
setInterval(() => {
  Object.values(LEAGUES).forEach((l) => l.fetch());
}, 30 * 60 * 1000);

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
  console.log("📊 Available leagues:");
  Object.keys(LEAGUES).forEach((l) =>
    console.log(`   → /standings/${l}`)
  );
});
