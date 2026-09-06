// validate-mlb-player
// Read-only helper for Bulk Import -- given a date and a batch of player
// names, checks whether each player's team is actually playing that day,
// using MLB's own official, free Stats API (statsapi.mlb.com). Never
// writes to any table -- purely a lookup, same safety principle as
// validate-schedule.
//
// REBUILT 2026-09-06, direct report: "Pete Alonso has always been an
// issue and never gets found." The original approach (fetch each team's
// roster with a `date` param, hoping it reconstructs that team's real
// roster as of that historical date) turned out to be unreliable past a
// season's opening days -- confirmed directly by testing Alonso's own
// Mets roster fetch across five real dates: found on 2024-06-08 and
// 2025-04-01 (opening day), but MISSING on 2025-01-15 (offseason,
// expected), 2025-06-08, AND 2025-09-01 -- despite his own 2025 season
// stats and the real June 8 box score both confirming he was a Met the
// entire time. MLB's roster-by-date endpoint simply doesn't reconstruct
// history reliably once the season is a couple months in; this has
// nothing to do with him personally, but he's exactly the kind of
// frequently-picked player who kept surfacing it.
//
// New approach: instead of asking "who was on this team's roster on this
// date" (unreliable), ask "who actually appears in this date's real game
// box score" (fully reliable, ground truth) -- confirmed directly that a
// box score's players list includes the FULL 26-man game-day roster for
// each team, not just those who recorded a stat (a real Mets box score
// checked directly: 26 total, including 3 bench and 11 bullpen players
// who never appeared in the box score's stat lines). This is the exact
// same box-score-based technique grade_picks_espn_backfill's own MLB
// Total Bases/Singles grading already relies on -- proven reliable there,
// now reused here for the same reason: a player can only ever be missing
// from a REAL box score by being genuinely inactive/not on the roster
// that specific day, never by an API's own historical-reconstruction gap.
//
// Call with: POST /validate-mlb-player
// Body: { date: "2026-06-04", checks: [{ id: "row-1", playerName: "Carlos Rodon" }, ...] }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalize(s: string): string {
  // NFD decomposition splits an accented letter into its plain base letter
  // plus a separate combining-mark character (e.g. "é" -> "e" + U+0301);
  // stripping just the combining marks folds accents to plain ASCII
  // instead of deleting the letter outright. Without this, MLB's own
  // official roster spelling "José" normalizes to "jos", which never
  // matches the plain "Jose" typed on a pick -- confirmed directly
  // against a real case (José Soriano, LAA).
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '');
}

// CONFIRMED REAL BUG, direct report 2026-08-28: a real capper (Iowa Kid
// Pix) writes EVERY player prop as "first initial + last name" ("J.
// Duran", "T. Stephenson", "W. Adames") -- checked directly against live
// rosters for 2025-06-02 and every one of these was a genuinely active
// player on a team playing that day, yet all failed this check. Root
// cause: normalize("J. Duran") = "jduran", and neither
// normalize("Jarren Duran") ("jarrenduran") nor the input is a substring
// of the other, so the existing exact/substring check can never match an
// abbreviated first name no matter how correct it is. This builds the
// same "first initial + surname" shape from the box score's own full name
// so it can be compared on equal terms.
function initialSurname(fullName: string): string | null {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return normalize(parts[0][0] + parts[parts.length - 1]);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const targetDate = body.date;
    const checks = body.checks;
    if (!targetDate || !Array.isArray(checks)) {
      return new Response(JSON.stringify({ error: 'Body must include date and a checks array.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // sportId=1 is MLB in this API's own numbering -- confirmed from
    // documentation, this function is MLB-only by design.
    const scheduleRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${targetDate}`);
    if (!scheduleRes.ok) {
      return new Response(JSON.stringify({ error: 'MLB schedule request failed', status: scheduleRes.status }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const scheduleData = await scheduleRes.json();
    const games = (scheduleData.dates && scheduleData.dates[0] && scheduleData.dates[0].games) || [];

    console.log(`[MLB PLAYER DEBUG] Games found for ${targetDate}: ${games.length}`);

    if (!games.length) {
      return new Response(JSON.stringify({ status: 'no_games', date: targetDate, results: checks.map((c: any) => ({ id: c.id, verifiable: true, valid: false, reason: `No MLB games found at all on ${targetDate}` })) }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // One box score per GAME (not per team, so half as many requests as
    // the old per-team roster approach) -- this is the real, ground-truth
    // game-day roster for both teams at once, not a reconstruction attempt.
    const players: { teamName: string; opponent: string; fullName: string }[] = [];
    let boxscoresFetched = 0;
    for (const g of games) {
      const gamePk = g.gamePk;
      const awayTeam = g.teams && g.teams.away && g.teams.away.team;
      const homeTeam = g.teams && g.teams.home && g.teams.home.team;
      if (!gamePk || !awayTeam || !homeTeam) continue;
      try {
        // Same small courtesy delay grade_picks_espn_backfill already uses
        // before each MLB Stats API boxscore fetch -- no documented rate
        // limit, kept anyway since that's the proven-safe pattern.
        await new Promise(resolve => setTimeout(resolve, 250));
        const boxRes = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`);
        if (!boxRes.ok) continue;
        const box = await boxRes.json();
        boxscoresFetched++;
        for (const side of ['home', 'away'] as const) {
          const team = box.teams && box.teams[side];
          const teamInfo = side === 'home' ? homeTeam : awayTeam;
          const opponentInfo = side === 'home' ? awayTeam : homeTeam;
          if (!team || !team.players) continue;
          for (const pid of Object.keys(team.players)) {
            const fullName = team.players[pid].person && team.players[pid].person.fullName;
            if (!fullName) continue;
            players.push({
              teamName: teamInfo.name,
              opponent: side === 'home' ? `vs ${opponentInfo.name}` : `@ ${opponentInfo.name}`,
              fullName
            });
          }
        }
      } catch (e) {
        console.log(`[MLB PLAYER DEBUG] Boxscore fetch failed for gamePk ${gamePk}:`, String(e));
      }
    }

    console.log(`[MLB PLAYER DEBUG] Box scores successfully fetched: ${boxscoresFetched} of ${games.length} games, ${players.length} total player entries`);

    const results = checks.map((check: any) => {
      const norm = normalize(check.playerName || '');
      if (!norm) return { id: check.id, verifiable: true, valid: false, reason: 'No player name provided' };
      const match = players.find(p => {
        const pn = normalize(p.fullName);
        return pn === norm || pn.includes(norm) || norm.includes(pn) || initialSurname(p.fullName) === norm;
      });
      if (match) {
        return { id: check.id, verifiable: true, valid: true, team: match.teamName, matchup: `${match.teamName} ${match.opponent}` };
      }
      return {
        id: check.id, verifiable: true, valid: false,
        reason: `"${check.playerName}" was not found in any real box score on ${targetDate} -- check spelling, or this player genuinely didn't appear in a game that day.`,
        gamesCheckedCount: boxscoresFetched
      };
    });

    return new Response(JSON.stringify({ status: 'checked', date: targetDate, gamesPlaying: games.length, boxscoresFetched, results }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
