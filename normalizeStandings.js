// normalizeStandings.js

// أسماء أعمدة محتملة بعدة لغات
const COLUMN_MAP = {
  rank: ["#", "Pos", "Position", "Rang"],
  team: ["Équipe", "Team", "Club"],
  points: ["Pts", "Points"],
  played: ["J", "MP", "Played"],
  wins: ["G", "W", "Wins"],
  draws: ["N", "D", "Draws"],
  losses: ["P", "L", "Losses"], // الخسارة
  goalDiff: ["Diff", "GD", "DIF"],
  goalsFor: ["BP", "GF"],
  goalsAgainst: ["BC", "GA"]
};

// دالة للعثور على قيمة العمود الصحيح في الصف
function findValue(row, keys) {
  for (const key of keys) {
    if (row[key]?.text) return row[key];
  }
  return null;
}

// الدالة الرئيسية لتطبيع الدوري
export function normalizeLeague(rawLeague) {
  if (!rawLeague?.tables?.length) return null;

  return rawLeague.tables.map(table => {
    return {
      title: table.title || `Table ${table.index + 1}`,
      rows: table.rows.map(row => ({
        rank: Number(findValue(row, COLUMN_MAP.rank)?.text),
        team: findValue(row, COLUMN_MAP.team)?.text,
        logo: findValue(row, COLUMN_MAP.team)?.images?.[0] || null,
        points: Number(findValue(row, COLUMN_MAP.points)?.text),
        played: Number(findValue(row, COLUMN_MAP.played)?.text),
        wins: Number(findValue(row, COLUMN_MAP.wins)?.text),
        draws: Number(findValue(row, COLUMN_MAP.draws)?.text),
        losses: Number(findValue(row, COLUMN_MAP.losses)?.text), // ✅ الآن الخسارة صحيحة
        goalDiff: findValue(row, COLUMN_MAP.goalDiff)?.text,
        goalsFor: Number(findValue(row, COLUMN_MAP.goalsFor)?.text),
        goalsAgainst: Number(findValue(row, COLUMN_MAP.goalsAgainst)?.text)
      }))
    };
  });
}
