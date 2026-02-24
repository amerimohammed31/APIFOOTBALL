import axios from "axios";
import fs from "fs/promises";
import path from "path";

// ---------------- CONFIG ----------------
const DATE = "20260224"; // تاريخ المباريات (YYYYMMDD)
const LOCALE = "en";
const OUTPUT_FILE = path.resolve("./matches-today-full.json");

// ---------------- API URLs ----------------
const API_MAIN = `https://prod-cdn-mev-api.livescore.com/v1/api/app/date/soccer/${DATE}/1?locale=${LOCALE}`;
const API_STATISTICS = (eid) => `https://prod-cdn-public-api.livescore.com/v1/api/app/statistics/soccer/${eid}`;
const API_SCOREBOARD = (eid) => `https://prod-cdn-public-api.livescore.com/v1/api/app/scoreboard/soccer/${eid}?locale=${LOCALE}`;
const API_LINEUPS = (eid) => `https://prod-cdn-public-api.livescore.com/v1/api/app/lineups/soccer/${eid}`;

// ---------------- HELPERS ----------------
async function fetchJSON(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json"
      },
      timeout: 15000
    });
    return data;
  } catch (err) {
    console.error(`❌ Error fetching: ${url} -> ${err.message}`);
    return null;
  }
}

function buildTeamImageURL(team) {
  if (!team || !team.Img) return null;
  return `https://storage.livescore.com/images/team/medium/${team.Img}`;
}

// ---------------- FETCH SINGLE MATCH ----------------
async function fetchMatchDetails(event, league) {
  const eid = event.Eid;
  const homeTeam = event.T1?.[0] || null;
  const awayTeam = event.T2?.[0] || null;

  const match = {
    Eid: eid,
    League: league.Snm,
    LeagueBadge: league.badgeUrl,
    Teams: {
      Home: homeTeam ? { ...homeTeam, Img: buildTeamImageURL(homeTeam) } : null,
      Away: awayTeam ? { ...awayTeam, Img: buildTeamImageURL(awayTeam) } : null,
    },
    Status: event.Eps || null,
    StartTime: event.Esd || null,
    Statistics: null,
    Scoreboard: null,
    Lineups: null
  };

  // ---------------- FETCH STATS, SCOREBOARD, LINEUPS ----------------
  const [stats, scoreboard, lineups] = await Promise.all([
    fetchJSON(API_STATISTICS(eid)),
    fetchJSON(API_SCOREBOARD(eid)),
    fetchJSON(API_LINEUPS(eid))
  ]);

  // ---------------- STATISTICS ----------------
  if (stats) {
    match.Statistics = stats;

    if (stats.Teams) {
      if (match.Teams.Home) {
        match.Teams.Home.Players = stats.Teams.Home?.Players || [];
        match.Teams.Home.Substitutes = stats.Teams.Home?.Substitutes || [];
        match.Teams.Home.Coach = stats.Teams.Home?.Coach || null;
      }
      if (match.Teams.Away) {
        match.Teams.Away.Players = stats.Teams.Away?.Players || [];
        match.Teams.Away.Substitutes = stats.Teams.Away?.Substitutes || [];
        match.Teams.Away.Coach = stats.Teams.Away?.Coach || null;
      }
    }

    match.Statistics.Events = stats.Events || [];
  }

  // ---------------- SCOREBOARD ----------------
  if (scoreboard) match.Scoreboard = scoreboard;

  // ---------------- LINEUPS ----------------
  if (lineups && lineups.Lu) {
    const homeTeamLineup = lineups.Lu.find(t => t.Tnb === 1);
    const awayTeamLineup = lineups.Lu.find(t => t.Tnb === 2);

    const formatLineup = (team) => {
      if (!team) return null;
      return {
        Formation: team.Fo?.join("-") || null,
        StartingXI: team.Ps?.filter(p => p.PosA >= 1 && p.PosA <= 4) || [],
        Substitutes: team.Ps?.filter(p => p.Pon === "SUBSTITUTE_PLAYER") || [],
        Coach: team.Ps?.find(p => p.Pon === "COACH") || null,
        Injured: team.IS || []
      };
    };

    match.Lineups = {
      Home: formatLineup(homeTeamLineup),
      Away: formatLineup(awayTeamLineup),
      Substitutions: lineups.Subs || {}
    };
  }

  console.log(`✅ Fetched: ${match.Teams.Home?.Nm} vs ${match.Teams.Away?.Nm}`);
  return match;
}

// ---------------- MAIN FUNCTION ----------------
async function fetchAllMatches() {
  console.log("🚀 Fetching main API...");
  const mainData = await fetchJSON(API_MAIN);
  if (!mainData || !mainData.Stages) {
    console.error("❌ Main API did not return valid data!");
    return;
  }

  const allMatchesPromises = [];

  for (const stage of mainData.Stages) {
    if (!stage.Events) continue;
    for (const event of stage.Events) {
      allMatchesPromises.push(fetchMatchDetails(event, stage));
    }
  }

  const allMatches = await Promise.all(allMatchesPromises);

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(allMatches, null, 2));
  console.log(`🎉 All matches with full data saved to ${OUTPUT_FILE}`);
}

// ---------------- RUN ----------------
fetchAllMatches();