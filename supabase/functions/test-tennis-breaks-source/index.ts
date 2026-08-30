// test-tennis-breaks-source
//
// READ-ONLY DIAGNOSTIC -- this function NEVER writes to `picks`. It exists
// to build confidence in stats.tennismylife.org (a free, keyless, one-
// person project) as a possible future source for grading "Breaks" bets,
// which ESPN's tennis feed has no data for at all (see
// grade_picks_espn_backfill's header comment -- Breaks was deliberately
// left unsupported for exactly that reason, no other free source existed).
//
// HOW THIS VALIDATES A SOURCE THAT CAN'T BE DIRECTLY CHECKED: there is no
// second free breaks-of-serve source to compare TennisMyLife against, so
// its bpSaved/bpFaced columns can't be checked directly. Instead, this
// cross-checks the things ESPN's OWN feed can already independently
// confirm for the SAME real match -- who won, and the total games played
// -- against TennisMyLife's record of that same match. Agreement on those
// is used as a PROXY: if TennisMyLife has the right match, correctly
// scored, that's the best available signal that the rest of its row
// (including the breaks columns) is trustworthy too, short of manually
// watching every match. Confirmed working directly, 2026-08-30 (see
// PROJECT-STATE): TennisMyLife's ongoing_tourneys.csv already had the
// Winston-Salem final ~6 hours after ESPN showed it complete.
//
// Call with: POST /test-tennis-breaks-source?date=2026-08-30
//   Runs one day's check, logs one row per real match into
//   tennis_breaks_validation_log (upserted -- safe to re-run the same
//   date), and returns a SHORT summary only (counts, not every match) --
//   direct user request 2026-08-30: "validate it without having to go
//   through my results line by line each day."
// Call with: POST /test-tennis-breaks-source?summary=true&days=7
//   No date needed -- rolls up everything logged in the last N days
//   (default 7) into one readable report: coverage rate, winner/games
//   agreement rates, and the specific rows (if any) that actually
//   disagreed, which are the only ones worth a manual look.
//
// COVERAGE CAVEAT, confirmed directly 2026-08-30: TennisMyLife's
// "ongoing_tourneys.csv" files each appeared to track a SINGLE live
// tournament (the ATP ongoing file held only Winston-Salem), not
// necessarily every tournament ESPN shows running that week. A
// "not_found" count materially above zero is expected, useful signal
// (it measures real coverage) -- not necessarily a bug in this function.
// A lazy fallback to the full current-year season CSVs is included below
// to reduce false "not found" results once a tournament rolls out of the
// "ongoing" window, but even that only covers what TennisMyLife tracks at
// all.
//
// DATE-ATTRIBUTION CAVEAT, confirmed directly 2026-08-30: TennisMyLife's
// own tourney_date for a match can land one calendar day off from ESPN's
// UTC match timestamp (a U.S. evening match crossing into UTC's next day
// is the likely cause -- the Winston-Salem final was recorded by ESPN at
// 2026-08-29T20:05Z but tagged tourney_date=20260830 by TennisMyLife).
// Matching here is deliberately done by NORMALIZED PLAYER-PAIR only, never
// by exact date, to avoid re-making the "over-strict date filter" mistake
// already fixed once in grade_picks_espn_backfill's real Tennis grading --
// this time in the opposite direction (a source disagreeing with ESPN on
// the date, not ESPN returning too much for one date).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalize(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '');
}

function pairKey(a: string, b: string): string {
  return [normalize(a), normalize(b)].sort().join('|');
}

// Same fix already twice-confirmed for sibling functions calling ESPN from
// this Edge Function runtime -- a bare fetch() with no User-Agent is a
// known trigger for ESPN's bot-protection to hard-reset the connection.
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

async function db(supabaseUrl: string, serviceRoleKey: string, path: string, opts: RequestInit = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: opts.method === 'PATCH' ? 'return=minimal' : 'return=representation',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase request failed (${res.status}): ${await res.text()}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Minimal CSV line splitter. TennisMyLife's files are plain comma-
// separated with no embedded commas observed in any real field (confirmed
// by inspecting the actual header + sample rows directly, 2026-08-30),
// but this still respects a quoted field defensively in case one ever
// appears (e.g. a tournament name with a comma in it).
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim().replace(/\r$/, ''));
}

type TmlRow = {
  tourneyDate: string; winnerName: string; loserName: string; score: string;
  wBpSaved: number | null; wBpFaced: number | null; lBpSaved: number | null; lBpFaced: number | null;
};

function parseTmlCsv(text: string): TmlRow[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const iDate = idx('tourney_date'), iWinner = idx('winner_name'), iLoser = idx('loser_name'), iScore = idx('score'),
    iWBpSaved = idx('w_bpSaved'), iWBpFaced = idx('w_bpFaced'), iLBpSaved = idx('l_bpSaved'), iLBpFaced = idx('l_bpFaced');
  const rows: TmlRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCsvLine(lines[i]);
    const toNum = (v: string | undefined) => { if (v === undefined || v === '') return null; const n = Number(v); return isNaN(n) ? null : n; };
    rows.push({
      tourneyDate: cols[iDate] || '', winnerName: cols[iWinner] || '', loserName: cols[iLoser] || '', score: cols[iScore] || '',
      wBpSaved: toNum(cols[iWBpSaved]), wBpFaced: toNum(cols[iWBpFaced]),
      lBpSaved: toNum(cols[iLBpSaved]), lBpFaced: toNum(cols[iLBpFaced]),
    });
  }
  return rows;
}

// Sums the games in a Sackmann-format score string ("6-4 7-6(2) 6-1"),
// stripping tiebreak parentheticals, so it's directly comparable to
// ESPN's own per-set linescores summed the same way. Retirement/walkover
// scores ("6-4 1-2 RET") are intentionally left imperfect here (the
// partial final set is counted at face value) -- this is a diagnostic
// comparison, not a grading path, and a real mismatch on a retirement is
// expected/acceptable noise, not something worth extra handling for.
function totalGamesFromScoreString(score: string): number | null {
  const sets = score.split(' ').filter(s => s && !/^(RET|W\/O|DEF)$/i.test(s));
  if (!sets.length) return null;
  let total = 0;
  for (const set of sets) {
    const clean = set.replace(/\(\d+\)/, '');
    const parts = clean.split('-').map(Number);
    if (parts.length !== 2 || parts.some(isNaN)) return null;
    total += parts[0] + parts[1];
  }
  return total;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'Missing required secret(s) (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(req.url);

    // --- Summary mode: roll up the log table, no new check run ---
    if (url.searchParams.get('summary') === 'true') {
      const days = Number(url.searchParams.get('days') || '7');
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const rows = await db(supabaseUrl, serviceRoleKey, `tennis_breaks_validation_log?select=*&checked_date=gte.${since}&order=checked_date.asc`);
      const found = (rows || []).filter((r: any) => r.found_in_source);
      const notFound = (rows || []).filter((r: any) => !r.found_in_source);
      const winnerDisagree = found.filter((r: any) => r.winner_agrees === false);
      const gamesDisagree = found.filter((r: any) => r.games_agree === false);
      const daysRun = [...new Set((rows || []).map((r: any) => r.checked_date))].sort();
      return new Response(JSON.stringify({
        window_days: days,
        days_run: daysRun,
        total_matches_checked: (rows || []).length,
        found_in_tennismylife: found.length,
        coverage_rate_pct: (rows || []).length ? Math.round((found.length / (rows || []).length) * 1000) / 10 : null,
        winner_agreement_rate_pct: found.length ? Math.round(((found.length - winnerDisagree.length) / found.length) * 1000) / 10 : null,
        games_agreement_rate_pct: found.length ? Math.round(((found.length - gamesDisagree.length) / found.length) * 1000) / 10 : null,
        winner_disagreements: winnerDisagree.map((r: any) => ({ date: r.checked_date, players: `${r.player_a} vs ${r.player_b}`, espn_winner: r.espn_winner, tennismylife_winner: r.tml_winner })),
        games_disagreements: gamesDisagree.map((r: any) => ({ date: r.checked_date, players: `${r.player_a} vs ${r.player_b}`, espn_total_games: r.espn_total_games, tennismylife_total_games: r.tml_total_games })),
        not_found_examples: notFound.slice(0, 15).map((r: any) => ({ date: r.checked_date, players: `${r.player_a} vs ${r.player_b}`, tour: r.tour })),
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const targetDate = url.searchParams.get('date');
    if (!targetDate) {
      return new Response(JSON.stringify({ error: 'Missing required "date" query parameter, e.g. ?date=2026-08-30 (or use ?summary=true&days=7 for the rolled-up report -- no date needed for that).' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const espnDate = targetDate.replace(/-/g, '');

    // --- Pull ESPN's real completed matches for this date (ATP + WTA) ---
    type EspnMatch = { tour: string; winner: string; loser: string; totalGames: number | null };
    const espnMatches: EspnMatch[] = [];
    const seenIds = new Set<string>();
    const tourResults = await Promise.allSettled(
      ['atp', 'wta'].map(tour =>
        espnFetch(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${espnDate}`)
          .then(r => r.ok ? r.json().then(j => ({ tour, j })) : null)
      )
    );
    for (const settled of tourResults) {
      if (settled.status !== 'fulfilled' || !settled.value) continue;
      const { tour, j } = settled.value;
      for (const tournament of (j.events || [])) {
        for (const grouping of (tournament.groupings || [])) {
          for (const comp of (grouping.competitions || [])) {
            // Same "entire draw, not just this date" ESPN quirk already
            // documented and fixed in grade_picks_espn_backfill.
            const compDateStr = (comp.date || '').slice(0, 10);
            if (compDateStr !== targetDate) continue;
            const matchId = `${tournament.id}-${comp.id}`;
            if (seenIds.has(matchId)) continue;
            seenIds.add(matchId);
            const completed = !!(comp.status && comp.status.type && comp.status.type.completed);
            if (!completed) continue;
            const names: string[] = [];
            const winnerByName = new Map<string, boolean>();
            const gamesByName = new Map<string, number>();
            for (const competitor of (comp.competitors || [])) {
              if (competitor.athlete && competitor.athlete.displayName) {
                const name = competitor.athlete.displayName;
                names.push(name);
                if (typeof competitor.winner === 'boolean') winnerByName.set(name, competitor.winner);
                const setValues = Array.isArray(competitor.linescores) ? competitor.linescores : [];
                let sum = 0; let bad = false;
                for (const set of setValues) {
                  if (set && typeof set.value === 'number' && Number.isFinite(set.value)) sum += set.value; else bad = true;
                }
                if (!bad) gamesByName.set(name, sum);
              }
            }
            if (names.length !== 2) continue;
            const winnerName = names.find(n => winnerByName.get(n) === true);
            const loserName = names.find(n => n !== winnerName);
            if (!winnerName || !loserName) continue;
            const gA = gamesByName.get(names[0]); const gB = gamesByName.get(names[1]);
            const totalGames = (typeof gA === 'number' && typeof gB === 'number') ? gA + gB : null;
            espnMatches.push({ tour: tour.toUpperCase(), winner: winnerName, loser: loserName, totalGames });
          }
        }
      }
    }

    const result = { date: targetDate, espn_completed_matches: espnMatches.length, checked: 0, found_in_source: 0, not_found: 0, winner_agree: 0, winner_disagree: 0 };

    if (!espnMatches.length) {
      return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Pull TennisMyLife's CSVs via its real, documented JSON file listing ---
    const fileListRes = await fetch('https://stats.tennismylife.org/api/data-files');
    if (!fileListRes.ok) {
      return new Response(JSON.stringify({ ...result, error: `TennisMyLife file listing request failed (${fileListRes.status})` }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const fileList = ((await fileListRes.json()).files || []) as { name: string; url: string }[];
    const findFile = (name: string) => fileList.find(f => f.name === name)?.url;

    const tmlByPair = new Map<string, TmlRow>();
    for (const name of ['ongoing_tourneys.csv', 'ch_ongoing_tourney.csv', 'wta_ongoing_tourneys.csv']) {
      const fileUrl = findFile(name);
      if (!fileUrl) continue;
      const csvRes = await fetch(fileUrl);
      if (csvRes.ok) {
        for (const row of parseTmlCsv(await csvRes.text())) tmlByPair.set(pairKey(row.winnerName, row.loserName), row);
      }
    }

    const currentYear = targetDate.slice(0, 4);
    let fallbackLoaded = false;

    const logRows: any[] = [];
    for (const m of espnMatches) {
      result.checked++;
      let tmlRow = tmlByPair.get(pairKey(m.winner, m.loser));

      // Lazy fallback: only fetch the full current-year season files (much
      // larger, so not worth the cost every run) if the fast "ongoing"
      // files didn't have at least one match -- covers a tournament that
      // already rolled out of TennisMyLife's "ongoing" window.
      if (!tmlRow && !fallbackLoaded) {
        fallbackLoaded = true;
        for (const name of [`${currentYear}.csv`, `${currentYear}_challenger.csv`, `${currentYear}_wta.csv`]) {
          const fileUrl = findFile(name);
          if (!fileUrl) continue;
          const csvRes = await fetch(fileUrl);
          if (csvRes.ok) {
            for (const row of parseTmlCsv(await csvRes.text())) tmlByPair.set(pairKey(row.winnerName, row.loserName), row);
          }
        }
        tmlRow = tmlByPair.get(pairKey(m.winner, m.loser));
      }

      // CONFIRMED REAL BUG, direct report 2026-08-30: PostgREST's bulk
      // insert (POST with a JSON array body) requires EVERY object in the
      // array to have the exact same set of keys ("All object keys must
      // match", PGRST102) -- a row with fewer keys than its neighbors
      // fails the whole batch, not just that row. Both branches below now
      // always emit the full, identical key set, explicitly null-filling
      // whatever a "not found" row can't know yet.
      if (!tmlRow) {
        result.not_found++;
        logRows.push({
          checked_date: targetDate, match_key: pairKey(m.winner, m.loser), tour: m.tour,
          player_a: m.winner, player_b: m.loser,
          espn_winner: m.winner, tml_winner: null, winner_agrees: null,
          espn_total_games: m.totalGames, tml_total_games: null, games_agree: null,
          found_in_source: false, tml_tourney_date: null,
          player_a_breaks: null, player_b_breaks: null,
        });
        continue;
      }

      result.found_in_source++;
      const winnerAgrees = normalize(tmlRow.winnerName) === normalize(m.winner);
      if (winnerAgrees) result.winner_agree++; else result.winner_disagree++;
      const tmlTotalGames = totalGamesFromScoreString(tmlRow.score);
      const gamesAgree = (m.totalGames !== null && tmlTotalGames !== null) ? m.totalGames === tmlTotalGames : null;
      const winnerBreaks = (tmlRow.wBpFaced !== null && tmlRow.wBpSaved !== null) ? tmlRow.wBpFaced - tmlRow.wBpSaved : null;
      const loserBreaks = (tmlRow.lBpFaced !== null && tmlRow.lBpSaved !== null) ? tmlRow.lBpFaced - tmlRow.lBpSaved : null;

      logRows.push({
        checked_date: targetDate, match_key: pairKey(m.winner, m.loser), tour: m.tour,
        player_a: m.winner, player_b: m.loser,
        espn_winner: m.winner, tml_winner: tmlRow.winnerName, winner_agrees: winnerAgrees,
        espn_total_games: m.totalGames, tml_total_games: tmlTotalGames, games_agree: gamesAgree,
        found_in_source: true,
        tml_tourney_date: tmlRow.tourneyDate.length === 8 ? `${tmlRow.tourneyDate.slice(0, 4)}-${tmlRow.tourneyDate.slice(4, 6)}-${tmlRow.tourneyDate.slice(6, 8)}` : null,
        // Aligned to ESPN's winner/loser labels (player_a/player_b) regardless
        // of which side TennisMyLife itself calls the winner.
        player_a_breaks: winnerAgrees ? winnerBreaks : loserBreaks,
        player_b_breaks: winnerAgrees ? loserBreaks : winnerBreaks,
      });
    }

    if (logRows.length) {
      await db(supabaseUrl, serviceRoleKey, 'tennis_breaks_validation_log?on_conflict=checked_date,match_key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(logRows),
      });
    }

    return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
