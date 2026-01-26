// normalizeStandings.js
// هذه النسخة تعتمد على ترتيب الأعمدة كما هي في Footmercato
// لأن الحروف (D / N) تختلف معانيها من موقع لآخر

export function normalizeLeague(rawLeague) {
  if (!rawLeague || !Array.isArray(rawLeague.tables)) return null;

  return rawLeague.tables.map((table, tableIndex) => {
    return {
      title: table.title || `Table ${tableIndex + 1}`,
      rows: table.rows.map(row => {
        // نحافظ على ترتيب الأعمدة كما جاءت من HTML
        const cells = Object.values(row);

        return {
          rank: Number(cells[0]?.text ?? 0),
          team: cells[1]?.text ?? null,
          logo: cells[1]?.images?.[0] ?? null,
          points: Number(cells[2]?.text ?? 0),
          played: Number(cells[3]?.text ?? 0),
          goalDiff: cells[4]?.text ?? "0",
          wins: Number(cells[5]?.text ?? 0),
          draws: Number(cells[6]?.text ?? 0),   // N = تعادل
          losses: Number(cells[7]?.text ?? 0),  // D = خسارة (Défaites)
          goalsFor: Number(cells[8]?.text ?? 0),
          goalsAgainst: Number(cells[9]?.text ?? 0),
        };
      })
    };
  });
}
