// normalizeStandings.js

// ===== أسماء أعمدة محتملة بعدة لغات =====
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

// ===== دالة للبحث عن قيمة داخل صف الجدول =====
function findValue(row, keys) {
  for (const key of keys) {
    if (row[key]?.text) return row[key];
  }
  return null;
}

// ===== تحويل جدول واحد =====
function normalizeTable(table) {
  return table.rows.map(row => ({
    rank: Number(findValue(row, COLUMN_MAP.rank)?.text) || null,
    team: findValue(row, COLUMN_MAP.team)?.text || null,
    logo: findValue(row, COLUMN_MAP.team)?.images?.[0] || null,
    points: Number(findValue(row, COLUMN_MAP.points)?.text) || null,
    played: Number(findValue(row, COLUMN_MAP.played)?.text) || null,
    wins: Number(findValue(row, COLUMN_MAP.wins)?.text) || null,
    draws: Number(findValue(row, COLUMN_MAP.draws)?.text) || null,
    losses: Number(findValue(row, COLUMN_MAP.losses)?.text) || null,
    goalDiff: findValue(row, COLUMN_MAP.goalDiff)?.text || null,
    goalsFor: Number(findValue(row, COLUMN_MAP.goalsFor)?.text) || null,
    goalsAgainst: Number(findValue(row, COLUMN_MAP.goalsAgainst)?.text) || null
  }));
}

// ===== تحويل دوري كامل مع دعم جميع الجداول (المجموعات) =====
export function normalizeLeague(rawLeague) {
  if (!rawLeague?.tables?.length) return null;

  // إعادة جميع الجداول مع الحفاظ على عنوان الجدول
  const normalizedTables = rawLeague.tables.map(table => ({
    title: table.title, // اسم المجموعة أو اسم الجدول
    rows: normalizeTable(table)
  }));

  return normalizedTables;
}
