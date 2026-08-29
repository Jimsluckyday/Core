// validate-mlb-player
// Read-only helper for Bulk Import -- given a date and a batch of player
// names, checks whether each player's team is actually playing that day,
// using MLB's own official, free Stats API (statsapi.mlb.com). Never
// writes to any table -- purely a lookup, same safety principle as
// validate-schedule.
//
// Approach: fetch the day's schedule to get every team playing, then
// fetch each of those teams' active rosters AS OF THAT DATE, and check
// whether the named player appears on any of them. MLB Stats API doesn't
// offer a clean "look up this player's current team" in one call
// (confirmed by direct testing, not assumed), so this goes the reliable
// way instead: known teams -> known rosters -> name match.
//
// Rosters are fetched with a `date` param so this works correctly on
// historical picks -- without it, the roster endpoint silently returns
// today's real-world roster instead of the roster on the date being
// checked, which false-positives on any player who's since been traded,
// injured, DFA'd, or sent down (confirmed directly against a real case:
// a Diamondbacks pitcher who started and won on 2026-06-07 was missing
// from today's roster fetch but present once `date=2026-06-07` was added).
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
// same "first initial + surname" shape from the roster's own full name
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
    console.log(`[MLB PLAYER DEBUG] Raw first game (unprocessed):`, JSON.stringify(games[0] || null).slice(0, 1500));

    // Collect every team playing today, with which game/opponent they're
    // in, so a match can be reported with real context, not just yes/no.
    const teamsToday: { teamId: number; teamName: string; opponent: string }[] = [];
    for (const g of games) {
      const away = g.teams && g.teams.away && g.teams.away.team;
      const home = g.teams && g.teams.home && g.teams.home.team;
      if (away && home) {
        teamsToday.push({ teamId: away.id, teamName: away.name, opponent: `@ ${home.name}` });
        teamsToday.push({ teamId: home.id, teamName: home.name, opponent: `vs ${away.name}` });
      }
    }

    if (!teamsToday.length) {
      return new Response(JSON.stringify({ status: 'no_games', date: targetDate, results: checks.map((c: any) => ({ id: c.id, verifiable: true, valid: false, reason: `No MLB games found at all on ${targetDate}` })) }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Fetch every team's active roster AS OF targetDate (not today's real
    // roster -- see note at top of file). MLB's API is free with no
    // documented rate limit for this kind of light use, so one roster
    // call per team playing today (typically 18-30 teams) is reasonable.
    const rosters: { teamId: number; teamName: string; opponent: string; players: string[] }[] = [];
    let loggedFirstRoster = false;
    for (const t of teamsToday) {
      try {
        const rosterRes = await fetch(`https://statsapi.mlb.com/api/v1/teams/${t.teamId}/roster?rosterType=active&date=${targetDate}`);
        if (!rosterRes.ok) continue;
        const rosterData = await rosterRes.json();
        if (!loggedFirstRoster) {
          console.log(`[MLB PLAYER DEBUG] Raw first roster response (unprocessed, team ${t.teamName}):`, JSON.stringify(rosterData).slice(0, 1500));
          loggedFirstRoster = true;
        }
        const players = (rosterData.roster || [])
          .map((r: any) => r.person && r.person.fullName)
          .filter(Boolean);
        rosters.push({ teamId: t.teamId, teamName: t.teamName, opponent: t.opponent, players });
      } catch (e) {
        console.log(`[MLB PLAYER DEBUG] Roster fetch failed for team ${t.teamName}:`, String(e));
      }
    }

    console.log(`[MLB PLAYER DEBUG] Rosters successfully fetched: ${rosters.length} of ${teamsToday.length} teams`);

    const results = checks.map((check: any) => {
      const norm = normalize(check.playerName || '');
      if (!norm) return { id: check.id, verifiable: true, valid: false, reason: 'No player name provided' };
      const match = rosters.find(r => r.players.some((p: string) => {
        const pn = normalize(p);
        return pn === norm || pn.includes(norm) || norm.includes(pn) || initialSurname(p) === norm;
      }));
      if (match) {
        return { id: check.id, verifiable: true, valid: true, team: match.teamName, matchup: `${match.teamName} ${match.opponent}` };
      }
      return {
        id: check.id, verifiable: true, valid: false,
        reason: `"${check.playerName}" was not found on any active roster playing on ${targetDate}`,
        teamsCheckedCount: rosters.length
      };
    });

    return new Response(JSON.stringify({ status: 'checked', date: targetDate, teamsPlayingToday: teamsToday.length, rostersFetched: rosters.length, results }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
