import mongoose from "mongoose";

const MatchSchema = new mongoose.Schema({
  leagueName: String,
  leagueLink: String,
  leagueLogo: String,

  matchLink: String,

  homeTeam: String,
  awayTeam: String,

  homeLogo: String,
  awayLogo: String,

  updatedAt: Date,
});

export default mongoose.model("Match", MatchSchema);
