import mongoose from "mongoose";

const matchSchema = new mongoose.Schema({
  league: String,
  leagueLink: String,
  leagueLogo: String,
  matchLink: String,
  homeTeam: String,
  homeScore: String,
  homeLogo: String,
  awayTeam: String,
  awayScore: String,
  awayLogo: String,
  time: String,
});

export default mongoose.model("Match", matchSchema);
