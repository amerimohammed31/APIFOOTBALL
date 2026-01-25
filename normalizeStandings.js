// أسماء أعمدة محتملة بعدة لغات
const COLUMN_MAP = {
  rank: ["#", "Pos", "Position", "Rang"],
  team: ["Équipe", "Team", "Club"],
  points: ["Pts", "Points"],
  played: ["J", "MP", "Played"],
  wins: ["G", "W", "Wins"],
  draws: ["N", "D", "Draws"],
  losses: ["P", "L", "Losses"],
  goalDiff: ["Diff", "GD", "DIF"],
  goalsFor: ["BP", "GF"],
  goalsAgainst: ["BC", "GA"]
};

function findValue(row, keys) {
  for (const key of keys) {
    if (row[key]?.text) return row[key];
  }
  return null;
}

export function normalizeLeague(rawLeague) {
  if (!rawLeague?.tables?.length) return null;

  // اختيار جدول الترتيب (ذكي)
  const table =
    rawLeague.tables.find(t =>
      t.rows.some(r =>
        COLUMN_MAP.points.some(p => r[p])
      )
    ) || rawLeague.tables[0];

  return table.rows.map(row => ({
    rank: Number(findValue(row, COLUMN_MAP.rank)?.text),
    team: findValue(row, COLUMN_MAP.team)?.text,
    logo: findValue(row, COLUMN_MAP.team)?.images?.[0] || null,
    points: Number(findValue(row, COLUMN_MAP.points)?.text),
    played: Number(findValue(row, COLUMN_MAP.played)?.text),
    wins: Number(findValue(row, COLUMN_MAP.wins)?.text),
    draws: Number(findValue(row, COLUMN_MAP.draws)?.text),
    losses: Number(findValue(row, COLUMN_MAP.losses)?.text),
    goalDiff: findValue(row, COLUMN_MAP.goalDiff)?.text,
    goalsFor: Number(findValue(row, COLUMN_MAP.goalsFor)?.text),
    goalsAgainst: Number(findValue(row, COLUMN_MAP.goalsAgainst)?.text)
  }));
}
