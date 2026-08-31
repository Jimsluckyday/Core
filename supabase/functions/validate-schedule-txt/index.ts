// validate-schedule
// Read-only helper for Bulk Import -- given a date, sport, and a batch of
// team-name checks, looks up the real schedule and reports back whether
// each entered matchup is actually real. Never writes to the picks table
// (or any table) at all -- this only ever fetches the schedule and
// compares it against what was typed, so there is zero risk of this
// affecting any existing pick's data.
//
// Call with: POST /validate-schedule
// Body: { date: "2026-06-04", sport: "MLB", checks: [{ id: "row-1", teamA: "Cincinnati", teamB: "Kansas City" }, ...] }
// (teamB is optional -- omit it for a single-team Moneyline-style check)
//
// REWRITTEN 2026-08-23, direct request: "if ESPN is this robust why do we
// need the Rundown at all... is there something it does differently than
// ESPN that is worth paying for?" Switched from TheRundown to ESPN's
// public scoreboard entirely for schedule/team-matchup validation.
// TheRundown's free plan has a 7-day history limit, which made this tool
// structurally unable to validate anything in a planned year-long
// historical backfill (starting June 2025) unless the date happened to
// already be cached from a previous run. ESPN has no observed rolling
// window at all (confirmed repeatedly elsewhere in this project going
// back months of real use) and no rate limit worth caching against, so
// this drops the rundown_schedule_cache table and all its read/write
// error handling entirely -- there's nothing left to cache, and nothing
// left that needs SUPABASE_URL/SERVICE_ROLE_KEY at all, since this
// function no longer touches the database in any way.
//
// Team-matching logic (bareNameIsUnique dedup so a bare city name like
// "Chicago" only counts when unique, exact-vs-substring safety for short
// abbreviations like "ARI" so it can't match inside "Mariners") is ported
// directly from the already-proven, already-bug-fixed version in
// grade_picks_espn_backfill.ts, rather than reinvented here a third time.
// Soccer's 23-competition-slug coverage (ESPN has no single "soccer"
// endpoint the way MLB/NBA do) is ported directly from
// schedule-sync-backfill.ts's own proven SOCCER_COMPETITION_SLUGS list --
// already confirmed end-to-end against real production data there, not
// re-verified from scratch here. Reuses the same ESPN_SPORT_MAP as both
// of those files for every other sport -- one shared source of truth for
// "which sports ESPN can cover."
//
// TheRundown is NOT being dropped from the project entirely -- it remains
// the only automated source this system has for actual betting ODDS
// (moneyline/spread/total prices), which ESPN's public API doesn't expose
// at all. This rewrite only removes it from schedule/team-matchup
// validation specifically, a job ESPN already did better, for free, with
// no history-window limit.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// CONFIRMED REAL BUG, direct report 2026-08-30 (same root cause proven in
// grade_picks_espn_backfill against a real case: "Teoscar Hernandez"
// Total Bases came back "no player found" despite genuinely playing, MLB
// Stats API spells it "Teoscar Hernández"): stripping any non-[a-z0-9]
// character outright deletes an accented letter instead of folding it to
// its plain equivalent, so an accented team/location name never matches a
// plain-ASCII-typed one. NFD-decompose-then-strip-diacritics first, same
// as every other normalize() in this project.
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '');
}

// Same fix already proven across every other ESPN-calling function in
// this project: Deno's default fetch() sends no User-Agent at all, a
// common trigger for an API's bot-protection/WAF to hard-reset the
// connection instead of responding normally.
async function espnFetch(url: string, attempts = 2): Promise<Response> {
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

// Same mapping as grade_picks_espn_backfill.ts / schedule-sync-backfill.ts
// -- kept identical on purpose, one shared source of truth for which
// sports have a real ESPN scoreboard slug.
const ESPN_SPORT_MAP: Record<string, string> = {
  mlb: 'baseball/mlb',
  nfl: 'football/nfl',
  nba: 'basketball/nba',
  nhl: 'hockey/nhl',
  wnba: 'basketball/wnba',
  ncaaf: 'football/college-football',
  ncaafootball: 'football/college-football',
  ncaab: 'basketball/mens-college-basketball',
  ncaabaseball: 'baseball/college-baseball',
  cfl: 'football/cfl',
  mma: 'mma/ufc',
};

// Ported directly from schedule-sync-backfill.ts's own proven list --
// ESPN has no single "soccer" endpoint the way MLB/NBA do, it exposes one
// endpoint per competition instead.
const SOCCER_COMPETITION_SLUGS = [
  'eng.1', 'esp.1', 'ger.1', 'ita.1', 'fra.1',
  'uefa.champions', 'uefa.europa', 'uefa.europa.conf',
  'concacaf.champions', 'conmebol.libertadores', 'conmebol.sudamericana',
  'usa.1', 'mex.1',
  'fifa.friendly', 'fifa.world',
  'fifa.worldq.uefa', 'fifa.worldq.concacaf', 'fifa.worldq.conmebol', 'fifa.worldq.afc', 'fifa.worldq.caf',
  'uefa.euro', 'conmebol.america', 'concacaf.gold',
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const targetDate = body.date;
    const sportParam = body.sport;
    const checks = body.checks;
    if (!targetDate || !sportParam || !Array.isArray(checks)) {
      return new Response(JSON.stringify({ error: 'Body must include date, sport, and a checks array.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const sportKey = normalize(sportParam);
    const isSoccer = sportKey === 'soccer';
    const espnPath = ESPN_SPORT_MAP[sportKey];

    if (!isSoccer && !espnPath) {
      // Not an error -- this sport just isn't one ESPN's generic
      // scoreboard covers (golf, tennis, KBO, cricket, etc). Every check
      // is reported as "cannot verify" rather than "wrong", so Bulk
      // Import knows not to flag these as schedule mismatches.
      return new Response(JSON.stringify({
        status: 'unsupported_sport',
        results: checks.map((c: any) => ({ id: c.id, verifiable: false }))
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const espnDate = targetDate.replace(/-/g, '');
    let games: any[];

    if (isSoccer) {
      const competitionResults = await Promise.allSettled(
        SOCCER_COMPETITION_SLUGS.map(slug =>
          espnFetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${espnDate}`).then(r => r.ok ? r.json() : null)
        )
      );
      const seenEventIds = new Set<string>();
      games = [];
      for (const result of competitionResults) {
        if (result.status === 'fulfilled' && result.value && Array.isArray(result.value.events)) {
          for (const ev of result.value.events) {
            if (seenEventIds.has(ev.id)) continue;
            seenEventIds.add(ev.id);
            games.push(ev);
          }
        }
      }
    } else {
      const eventsRes = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${espnDate}`);
      if (!eventsRes.ok) {
        return new Response(JSON.stringify({ error: 'ESPN scoreboard request failed', status: eventsRes.status }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const eventsData = await eventsRes.json();
      games = eventsData.events || [];
    }

    // Same "Chicago Cubs vs Chicago White Sox" / "ARI inside Mariners"
    // safety already proven in grade_picks_espn_backfill.ts -- a bare
    // city/location name is only trusted as a matchable variant when no
    // OTHER team playing this sport today shares that same city; short
    // abbreviations/short names always require an EXACT match, never
    // substring containment.
    const allTeamsToday: any[] = [];
    for (const e of games) {
      const competitors = (e.competitions && e.competitions[0] && e.competitions[0].competitors) || [];
      for (const c of competitors) if (c.team) allTeamsToday.push(c.team);
    }
    const bareNameCounts = new Map<string, number>();
    for (const t of allTeamsToday) {
      if (!t.location) continue;
      const n = normalize(t.location);
      bareNameCounts.set(n, (bareNameCounts.get(n) || 0) + 1);
    }

    const gameEntries = games.map((e: any) => {
      const competitors = (e.competitions && e.competitions[0] && e.competitions[0].competitors) || [];
      const home = competitors.find((c: any) => c.homeAway === 'home');
      const away = competitors.find((c: any) => c.homeAway === 'away');

      function variantsFor(c: any) {
        if (!c || !c.team) return null;
        const t = c.team;
        const bareNameIsUnique = t.location && (bareNameCounts.get(normalize(t.location)) || 0) <= 1;
        const substringSafeNames = [bareNameIsUnique ? t.location : null, t.displayName].filter(Boolean).map(normalize);
        const exactOnlyNames = [t.shortDisplayName, t.name, t.abbreviation].filter(Boolean).map(normalize);
        return { substringSafeNames, exactOnlyNames };
      }

      const homeV = variantsFor(home);
      const awayV = variantsFor(away);
      const matchup = (home && away) ? `${away.team.displayName} @ ${home.team.displayName}` : 'unknown matchup';
      return { variants: [homeV, awayV].filter(Boolean), matchup };
    });

    function findMatchingGames(teamStr: string) {
      const norm = normalize(teamStr);
      return gameEntries.filter((game: any) =>
        game.variants.some((v: any) =>
          v.substringSafeNames.some((n: string) => n === norm || n.includes(norm) || norm.includes(n)) ||
          v.exactOnlyNames.some((n: string) => n === norm)
        )
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
