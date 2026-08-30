// validate-nhl-player
// Read-only helper for Bulk Import -- given a date and a batch of player
// names, checks whether each player's team is actually playing that day,
// using the NHL's own official, free Web API (api-web.nhle.com). Never
// writes to any table -- purely a lookup, same safety principle as
// validate-mlb-player and validate-schedule.
//
// Approach: fetch the day's schedule to get every team playing, then
// fetch each of those teams' current rosters, and check whether the named
// player appears on any of them. Same known-teams -> known-rosters ->
// name-match approach as validate-mlb-player, since the NHL API doesn't
// offer a clean "look up this player's current team" in one call either.
//
// HONEST CAVEAT, confirmed directly rather than assumed: a plain browser-
// style fetch to api-web.nhle.com from outside Supabase's own
// infrastructure was blocked by bot detection during earlier testing for
// this project. This function has NOT been confirmed to work end-to-end
// against the live API from within a real Supabase Edge Function
// deployment -- test this on a single, small date range first before
// relying on it for anything time-sensitive. If it turns out Supabase's
// own infrastructure also gets blocked, this will need a different
// approach (e.g. a proxy, or a paid data source) rather than this direct
// fetch.
//
// CONFIRMED FIX, applied proactively for exactly this suspected issue:
// validate-nba-player-txt and validate-wnba-player-txt both hit a real,
// confirmed version of this same failure shape against ESPN (not this
// host, but the same class of API) -- "request failed" from inside Deno's
// Edge Function runtime on a URL that worked fine fetched directly, root-
// caused to Deno's default fetch() sending no User-Agent header at all, a
// common bot-protection/WAF trigger for a hard connection reset instead
// of a normal response. Every call to api-web.nhle.com in this file now
// goes through the nhlFetch() wrapper below (real User-Agent + one retry)
// instead of a bare fetch() -- this doesn't independently confirm the
// caveat above, but it's the same fix that resolved the confirmed NBA/
// WNBA case, so it's the natural first thing to try here too before
// assuming a proxy or paid source is actually needed.
//
// Call with: POST /validate-nhl-player
// Body: { date: "2026-06-04", checks: [{ id: "row-1", playerName: "Jack Eichel" }, ...] }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

// Same "first initial + last name" fix as validate-mlb-player-txt -- a
// capper writing "J. Duran"-style abbreviated names never matches a
// roster's full name via plain equality/substring, no matter how correct
// the pick is. See that file's own comment for the confirmed real case.
function initialSurname(fullName: string): string | null {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return normalize(parts[0][0] + parts[parts.length - 1]);
}

async function nhlFetch(url: string, attempts = 2): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CoreBettingSolutions-ScheduleSync/1.0)' } });
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
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

    // The NHL's own schedule endpoint returns a whole WEEK of games
    // (a gameWeek array, each entry its own date), not just the single
    // requested day -- confirmed directly from real documentation/usage
    // examples, not assumed. Filter down to the one matching date.
    const scheduleRes = await nhlFetch(`https://api-web.nhle.com/v1/schedule/${targetDate}`);
    if (!scheduleRes.ok) {
      return new Response(JSON.stringify({ error: 'NHL schedule request failed', status: scheduleRes.status }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const scheduleData = await scheduleRes.json();
    const gameWeek = scheduleData.gameWeek || [];

    console.log(`[NHL PLAYER DEBUG] gameWeek entries returned: ${gameWeek.length}`);
    console.log(`[NHL PLAYER DEBUG] Raw first gameWeek entry (unprocessed):`, JSON.stringify(gameWeek[0] || null).slice(0, 1500));

    const dayEntry = gameWeek.find((d: any) => d.date === targetDate);
    const games = (dayEntry && dayEntry.games) || [];

    // Collect every team playing today, with which game/opponent they're
    // in, so a match can be reported with real context, not just yes/no.
    const teamsToday: { abbrev: string; teamName: string; opponent: string }[] = [];
    for (const g of games) {
      const away = g.awayTeam;
      const home = g.homeTeam;
      if (away && home) {
        const awayName = (away.placeName && away.placeName.default) || away.abbrev;
        const homeName = (home.placeName && home.placeName.default) || home.abbrev;
        teamsToday.push({ abbrev: away.abbrev, teamName: awayName, opponent: `@ ${homeName}` });
        teamsToday.push({ abbrev: home.abbrev, teamName: homeName, opponent: `vs ${awayName}` });
      }
    }

    if (!teamsToday.length) {
      return new Response(JSON.stringify({ status: 'no_games', date: targetDate, results: checks.map((c: any) => ({ id: c.id, verifiable: true, valid: false, reason: `No NHL games found at all on ${targetDate}` })) }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // CONFIRMED FIX, verified live 2026-08-30 (was previously shipped as
    // "likely, not confirmed"): direct report -- "Matthew Tchachuk was not
    // found on any current roster playing on 2025-06-04" for a real
    // Stanley Cup Final game. /current always returns the CURRENT (as-of-
    // whenever-this-runs) roster, not a historical snapshot for the actual
    // backfill date -- the exact same bug already found and fixed for MLB
    // (see this repo's schedule-sync-backfill Fix #4, which found MLB's
    // Stats API accepts a real date= param). Directly queried
    // https://api-web.nhle.com/v1/roster/FLA/20242025 just now: Matthew
    // Tkachuk (correct spelling -- the original report's "Tchachuk" was
    // also a typo) is genuinely present in that season's real roster,
    // confirming this endpoint actually returns historical data, unlike
    // ESPN's equivalent team-roster endpoint (tested separately the same
    // day for NBA -- ESPN's ?season= param returns HTTP 200 with a
    // deliberately empty roster, no working historical data at all). Falls
    // back to /current if the season-specific fetch fails for any reason.
    function nhlSeasonFor(dateStr: string): string {
      const [y, m] = dateStr.split('-').map(Number);
      const startYear = m >= 7 ? y : y - 1;
      return `${startYear}${startYear + 1}`;
    }
    const season = nhlSeasonFor(targetDate);

    // Fetch every team's roster for the season covering targetDate
    // (typically 2-16 teams playing on a given day, well within reasonable
    // free-API use).
    const rosters: { abbrev: string; teamName: string; opponent: string; players: string[] }[] = [];
    let loggedFirstRoster = false;
    for (const t of teamsToday) {
      try {
        let rosterRes = await nhlFetch(`https://api-web.nhle.com/v1/roster/${t.abbrev}/${season}`);
        if (!rosterRes.ok) rosterRes = await nhlFetch(`https://api-web.nhle.com/v1/roster/${t.abbrev}/current`);
        if (!rosterRes.ok) continue;
        const rosterData = await rosterRes.json();
        if (!loggedFirstRoster) {
          console.log(`[NHL PLAYER DEBUG] Raw first roster response (unprocessed, team ${t.teamName}):`, JSON.stringify(rosterData).slice(0, 1500));
          loggedFirstRoster = true;
        }
        // Confirmed structure: grouped into forwards/defensemen/goalies,
        // each player with firstName.default / lastName.default.
        const players: string[] = [];
        for (const group of ['forwards', 'defensemen', 'goalies']) {
          for (const p of (rosterData[group] || [])) {
            const first = p.firstName && p.firstName.default;
            const last = p.lastName && p.lastName.default;
            if (first && last) players.push(`${first} ${last}`);
          }
        }
        rosters.push({ abbrev: t.abbrev, teamName: t.teamName, opponent: t.opponent, players });
      } catch (e) {
        console.log(`[NHL PLAYER DEBUG] Roster fetch failed for team ${t.teamName}:`, String(e));
      }
    }

    console.log(`[NHL PLAYER DEBUG] Rosters successfully fetched: ${rosters.length} of ${teamsToday.length} teams`);

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
        reason: `"${check.playerName}" was not found on any current roster playing on ${targetDate}`,
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
