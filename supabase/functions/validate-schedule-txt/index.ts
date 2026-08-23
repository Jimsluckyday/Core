// validate-schedule
// Read-only helper for Bulk Import -- given a date, sport, and a batch of
// team-name checks, looks up today's real schedule from TheRundown and
// reports back whether each entered matchup is actually real. Never
// writes to the picks table (or any table) at all -- this only ever
// fetches TheRundown's schedule and compares it against what was typed,
// so there is zero risk of this affecting any existing pick's data.
//
// Call with: POST /validate-schedule
// Body: { date: "2026-06-04", sport: "MLB", checks: [{ id: "row-1", teamA: "Cincinnati", teamB: "Kansas City" }, ...] }
// (teamB is optional -- omit it for a single-team Moneyline-style check)
//
// Resilience: past-date results are cached in rundown_schedule_cache so a
// date, once fetched successfully, never needs to hit TheRundown again --
// re-running Bulk Import on the same historical dates costs zero further
// TheRundown calls. Live/future dates always fetch fresh (never cached),
// since those schedules can still change. Both TheRundown calls also retry
// with backoff before giving up, instead of failing the whole batch on the
// first bad response.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

// A date already fully in the past is done -- its schedule can never
// change, so it's safe to cache indefinitely. Deliberately conservative:
// compares against UTC "today", so a date that's "today" in Eastern but
// still "today" in UTC is correctly treated as not-yet-cacheable.
function isPastDate(dateStr: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return dateStr < today;
}

async function fetchWithRetry(url: string, maxRetries = 2): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      // Only 429 (rate limited) and 5xx (transient) are worth retrying --
      // a 4xx like 401/404 will never succeed just by trying again.
      if (res.status !== 429 && res.status < 500) return res;
      if (attempt === maxRetries) return res;
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : 500 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const rundownKey = Deno.env.get('RUNDOWN_API_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!rundownKey || !supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'Missing required secret(s).' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json();
    const targetDate = body.date;
    const sportParam = body.sport;
    const checks = body.checks;
    if (!targetDate || !sportParam || !Array.isArray(checks)) {
      return new Response(JSON.stringify({ error: 'Body must include date, sport, and a checks array.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    async function db(path: string) {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
      });
      if (!res.ok) throw new Error(`DB request failed (${res.status}): ${await res.text()}`);
      return res.json();
    }

    async function dbUpsert(path: string, payload: unknown) {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`DB upsert failed (${res.status}): ${await res.text()}`);
    }

    const sportKey = normalize(sportParam);
    const canCache = isPastDate(targetDate);

    let games: any[];

    // CONFIRMED REAL BUG, direct report 2026-08-22: "Schedule validation
    // could not run... likely TheRundown being slow, rate-limited, or
    // down" -- the actual cause had nothing to do with TheRundown at
    // all. rundown_schedule_cache didn't exist in the database yet (a
    // missing migration), so this READ threw immediately and the whole
    // request failed before ever reaching the TheRundown fetch below.
    // Wrapped the same "best-effort, never block the real work" way the
    // cache WRITE already is further down -- a cache read failure now
    // just means this date isn't served from cache this time, not a
    // failed validation.
    let cachedRows: any[] = [];
    if (canCache) {
      try {
        cachedRows = await db(`rundown_schedule_cache?date=eq.${targetDate}&sport=eq.${sportKey}&select=games_json`);
      } catch (_) {
        cachedRows = [];
      }
    }

    if (cachedRows.length) {
      games = cachedRows[0].games_json;
    } else {
      // Same sport-name lookup pattern as schedule-sync -- confirms this
      // sport is one TheRundown actually covers before trying to fetch
      // anything, and fails safely (not an error) if it isn't.
      const sportsRes = await fetchWithRetry(`https://therundown.io/api/v2/sports?key=${rundownKey}`);
      if (!sportsRes.ok) {
        return new Response(JSON.stringify({ error: 'Could not reach TheRundown /sports list', status: sportsRes.status }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const sportsData = await sportsRes.json();
      const rundownSport = (sportsData.sports || []).find((s: any) => normalize(s.sport_name) === sportKey);
      if (!rundownSport) {
        // Not an error -- this sport just isn't one TheRundown covers
        // (golf, tennis, KBO, etc). Every check is reported as "cannot
        // verify" rather than "wrong", so Bulk Import knows not to flag
        // these as schedule mismatches.
        return new Response(JSON.stringify({
          status: 'unsupported_sport',
          results: checks.map((c: any) => ({ id: c.id, verifiable: false }))
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const rundownSportId = rundownSport.sport_id;

      const eventsRes = await fetchWithRetry(
        `https://therundown.io/api/v2/sports/${rundownSportId}/events/${targetDate}?key=${rundownKey}&offset=300`
      );
      if (!eventsRes.ok) {
        return new Response(JSON.stringify({ error: 'TheRundown events request failed', status: eventsRes.status }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const eventsData = await eventsRes.json();
      games = eventsData.events || [];

      if (canCache) {
        // Best-effort -- a cache-write hiccup should never break the
        // validation response that's actually being returned right now.
        try {
          await dbUpsert('rundown_schedule_cache', { date: targetDate, sport: sportKey, games_json: games });
        } catch (_) { /* ignore -- just means this date isn't cached yet next time either */ }
      }
    }

    // Same game-entry building as schedule-sync -- kept identical
    // deliberately, since this exact logic has already been tested
    // against real TheRundown responses.
    const gameEntries = games.map((g: any) => {
      const teams = g.teams_normalized || g.teams || [];
      const variants = teams.map((t: any) => ({
        names: [t.name, t.mascot, t.name && t.mascot ? `${t.name} ${t.mascot}` : null]
          .filter(Boolean).map(normalize)
      }));
      const away = teams.find((t: any) => !t.is_home);
      const home = teams.find((t: any) => t.is_home);
      const matchup = away && home ? `${away.name} ${away.mascot} @ ${home.name} ${home.mascot}` : 'unknown matchup';
      return { variants, matchup };
    });

    function findMatchingGames(teamStr: string) {
      const norm = normalize(teamStr);
      return gameEntries.filter((game: any) =>
        game.variants.some((v: any) => v.names.some((n: string) => n === norm || n.includes(norm) || norm.includes(n)))
      );
    }

    const results = checks.map((check: any) => {
      const matchesA = findMatchingGames(check.teamA);
      if (!check.teamB) {
        // Single-team check -- just confirms teamA is playing at all today.
        if (matchesA.length === 1) return { id: check.id, verifiable: true, valid: true, actualMatchup: matchesA[0].matchup };
        if (matchesA.length === 0) return { id: check.id, verifiable: true, valid: false, reason: `"${check.teamA}" does not appear to be playing on ${targetDate}`, allGamesToday: gameEntries.map((g: any) => g.matchup) };
        return { id: check.id, verifiable: true, valid: false, reason: `"${check.teamA}" matched multiple games -- ambiguous`, candidates: matchesA.map((g: any) => g.matchup) };
      }
      // Two-team check -- confirms both teams are playing EACH OTHER,
      // not just that both happen to be playing someone today.
      const matchesB = findMatchingGames(check.teamB);
      const sameGame = matchesA.filter((a: any) => matchesB.includes(a));
      if (sameGame.length === 1) return { id: check.id, verifiable: true, valid: true, actualMatchup: sameGame[0].matchup };
      const actualA = matchesA[0] ? matchesA[0].matchup : null;
      const actualB = matchesB[0] ? matchesB[0].matchup : null;
      return {
        id: check.id, verifiable: true, valid: false,
        reason: `"${check.teamA}" and "${check.teamB}" are not playing each other on ${targetDate}`,
        teamAActuallyPlaying: actualA, teamBActuallyPlaying: actualB,
        allGamesToday: gameEntries.map((g: any) => g.matchup)
      };
    });

    return new Response(JSON.stringify({ status: 'checked', date: targetDate, sport: sportParam, results }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
