const mongoose = require("mongoose");

const matchSchema = new mongoose.Schema({
  league: String,
  matchday: String,
  homeTeam: String,
  homeLogo: String,
  awayTeam: String,
  awayLogo: String,
  score: String,
  status: String,
  time: String
});

module.exports = mongoose.model("Match", matchSchema);