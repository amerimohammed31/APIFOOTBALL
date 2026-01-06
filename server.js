import express from "express";
import fs from "fs";
import fetchMatches from "./fetchMatches.js";

const app = express();
const PORT = 3000;
const FILE_PATH = "./matches.json";

app.get("/matches", (req, res) => {
  if (!fs.existsSync(FILE_PATH)) return res.json([]);
  const data = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
  res.json(data);
});

// تشغيل أولي
fetchMatches();

// تحديث كل 3 دقائق
setInterval(fetchMatches, 180000);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
