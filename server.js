import express from "express";
import fs from "fs";
import fetchAllLeagues from "./fetchAllLeagues.js";
import { fetchMatchToday } from "./fetchMatchToday.js";

const app = express();
const PORT = 3000;

const DATA_FILE = "./all_leagues_standings.json";

// ===== ROUTE: Standings for each league =====
app.get("/standings/:league", (req, res) => {
  const league = req.params.league.toLowerCase();

  try {
    if (!fs.existsSync(DATA_FILE)) return res.json({});
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));

    if (!data[league]) {
      return res.status(404).json({
        error: "League not found",
        supported: Object.keys(data),
      });
    }

    res.json(data[league]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Invalid data file" });
  }
});

// ===== ROUTE: Matches Today =====
app.get("/match-today", async (req, res) => {
  try {
    const matches = await fetchMatchToday();
    res.json(matches);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch matches today" });
  }
});

// ===== INITIAL FETCH =====
(async () => {
  // 1️⃣ جلب الدوريات
  const allStandings = await fetchAllLeagues();
  fs.writeFileSync(DATA_FILE, JSON.stringify(allStandings, null, 2));
  console.log("✅ All leagues standings fetched and saved");

  // 2️⃣ جلب مباريات اليوم عند التشغيل وحفظها في Match-Today.json
  await fetchMatchToday();
  console.log("✅ Match-Today fetched and saved");
})();

// ===== UPDATE STANDINGS AND MATCHES EVERY 30 MIN =====
setInterval(async () => {
  const allStandings = await fetchAllLeagues();
  fs.writeFileSync(DATA_FILE, JSON.stringify(allStandings, null, 2));
  console.log("🔄 All leagues standings updated");

  await fetchMatchToday();
  console.log("🔄 Match-Today updated");
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
  console.log("📊 Available endpoints:");
  console.log("   → /standings/:league");
  console.log("   → /match-today");
});