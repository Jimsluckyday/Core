// validate-wnba-player
// Read-only helper for Add Pick's "Auto-fill" button (and Bulk Import,
// same as its MLB/NBA/NHL siblings) -- given a date and a batch of player
// names, checks whether each player's team is actually playing that day,
// and returns the real team name so it can be auto-filled into prop_team.
// Never writes to any table -- purely a lookup, same safety principle as
// validate-mlb-player/validate-nba-player/validate-nhl-player.
//
// Built 2026-08-12, direct request right after the schedule-sync-backfill
// WNBA prop-lookup fix: "I don't think we build in WNBA and should add
// that."
//
// REVISED same day, direct follow-up: "would it be beneficial to have
// something I run once a day or week... which the uploader/add picks
// would check against?" -- while researching that question, confirmed
// directly that ESPN's OWN team roster endpoint
// (site.api.espn.com/.../teams/{id}/roster) has NO observed rate limit at
// all (8 rapid real requests in ~2 seconds, zero issues), unlike
// BALLDONTLIE's confirmed 5-requests-per-minute free-tier ceiling that
// this file's FIRST version had to work around with sequential requests
// and pagination. Rebuilt on ESPN instead -- same trusted, already-proven
// source used everywhere else in this project for schedule/roster data,
// no API key or secret needed at all, and noticeably simpler and faster
// as a direct result (no more 30-90+ second lookups).
//
// HONEST CAVEAT, confirmed directly: ESPN's roster endpoint only returns
// each team's CURRENT roster -- querying a past season returns zero
// athletes, so there's no real historical/date-anchored option here. For
// an interactive Add Pick lookup (entering a pick at or near real time)
// this is a non-issue; BALLDONTLIE's own data wasn't meaningfully more
// historical either (its "roster" data was an all-time list including
// retired players, not a real season-accurate snapshot), so this isn't a
// regression on that front.
//
// Call with: POST /validate-wnba-player
// Body: { date: "2026-06-01", checks: [{ id: "1", playerName: "Natisha Hiedeman" }, ...] }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalize(s: string): string {
  // NFD decomposition splits an accented letter into its plain base letter
  // plus a separate combining-mark character (e.g. "é" -> "e" + U+0301);
  // stripping just the combining marks folds accents to plain ASCII
  // instead of deleting the letter outright. Without this, a real roster
  // spelling with an accent never matches the plain-ASCII name typed on a
  // pick -- ported from the same fix proven in validate-mlb-player (real
  // case: José Soriano) and schedule-sync-backfill (real case: Walbert
  // Ureña).
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '');
}

// CONFIRMED FIX, direct real-world report: two consecutive live runs both
// failed with "ESPN WNBA scoreboard request failed" alongside the NBA
// sibling failing the exact same way on the exact same date -- ruled out
// ESPN being down (the exact same URL fetched fine from a normal browser
// at the same time). Same root cause and fix already proven in this
// project for CricketData.org (schedule-sync-backfill's own Fix #28):
// Deno's default fetch() sends no User-Agent header at all, which is a
// common trigger for an API's bot-protection/WAF to hard-reset the
// connection instead of responding normally, even though the identical
// request works fine from anywhere that sends a real browser-style
// User-Agent. Every fetch to ESPN in this file now goes through this
// wrapper instead of a bare fetch() -- also retries once on a network-
// level failure, same defensive pattern as the Cricket fix, in case the
// real cause turns out to be an intermittent block rather than a
// consistent one either way.
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

    // ESPN wants YYYYMMDD, no dashes -- same convention used throughout
    // schedule-sync-backfill.
    const espnDate = targetDate.replace(/-/g, '');
    const scoreboardRes = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${espnDate}`);
    if (!scoreboardRes.ok) {
      return new Response(JSON.stringify({ error: 'ESPN WNBA scoreboard request failed', status: scoreboardRes.status }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const scoreboardData = await scoreboardRes.json();
    const games = scoreboardData.events || [];

    // Collect every real team playing today (deduped by ESPN's own team
    // id), with which game/opponent they're in, so a match can be
    // reported with real context, not just yes/no -- same pattern
    // validate-nhl-player already uses.
    const teamsToday = new Map<string, { teamName: string; opponent: string; startTime: string }>();
    for (const g of games) {
      const competitors = (g.competitions && g.competitions[0] && g.competitions[0].competitors) || [];
      const home = competitors.find((c: any) => c.homeAway === 'home');
      const away = competitors.find((c: any) => c.homeAway === 'away');
      if (home && home.team && home.team.id && !teamsToday.has(home.team.id)) {
        teamsToday.set(home.team.id, {
          teamName: home.team.displayName || home.team.name,
          opponent: away && away.team ? `vs ${away.team.displayName || away.team.name}` : '',
          startTime: g.date
        });
      }
      if (away && away.team && away.team.id && !teamsToday.has(away.team.id)) {
        teamsToday.set(away.team.id, {
          teamName: away.team.displayName || away.team.name,
          opponent: home && home.team ? `@ ${home.team.displayName || home.team.name}` : '',
          startTime: g.date
        });
      }
    }

    if (!teamsToday.size) {
      return new Response(JSON.stringify({
        status: 'no_games', date: targetDate,
        results: checks.map((c: any) => ({ id: c.id, verifiable: true, valid: false, reason: `No WNBA games found on ${targetDate}` }))
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // No rate limit on this endpoint (confirmed directly) -- safe to fetch
    // every team's roster in parallel, unlike BALLDONTLIE.
    const rosterResults = await Promise.allSettled(
      [...teamsToday.keys()].map(id =>
        espnFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/${id}/roster`).then(r => r.ok ? r.json() : null)
      )
    );
    const rosterByNorm = new Map<string, { teamName: string; opponent: string; displayName: string }>();
    let i = 0;
    let rostersFetched = 0;
    for (const id of teamsToday.keys()) {
      const result = rosterResults[i++];
      const t = teamsToday.get(id)!;
      if (result.status !== 'fulfilled' || !result.value) continue;
      rostersFetched++;
      const athletes = result.value.athletes || [];
      for (const a of athletes) {
        const name = a.fullName || a.displayName;
        if (name) rosterByNorm.set(normalize(name), { teamName: t.teamName, opponent: t.opponent, displayName: name });
      }
    }

    const rosterNames = [...rosterByNorm.keys()];
    const results = checks.map((check: any) => {
      const norm = normalize(check.playerName || '');
      if (!norm) return { id: check.id, verifiable: true, valid: false, reason: 'No player name provided' };
      // Exact match first, then substring containment (same tolerance
      // validate-nhl-player already uses -- catches a bare surname or a
      // slightly abbreviated first name without over-matching).
      let hitKey = rosterNames.find(n => n === norm);
      if (!hitKey) hitKey = rosterNames.find(n => n.includes(norm) || norm.includes(n));
      const match = hitKey ? rosterByNorm.get(hitKey) : null;
      if (match) {
        return { id: check.id, verifiable: true, valid: true, team: match.teamName, matchup: `${match.teamName} ${match.opponent}` };
      }
      return {
        id: check.id, verifiable: true, valid: false,
        reason: `"${check.playerName}" was not found on any WNBA roster for a team playing on ${targetDate}`,
        teamsCheckedCount: teamsToday.size
      };
    });

    return new Response(JSON.stringify({
      status: 'checked', date: targetDate, teamsPlayingToday: teamsToday.size, rostersFetched, results
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
