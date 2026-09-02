// grade-golf-picks
// Grades the 3 golf-specific Player Prop bets that NEITHER grade_picks
// (TheRundown) NOR grade_picks_espn_backfill can touch -- both explicitly
// grade Moneyline/Spread/Total only and skip every Player Prop by design.
// In this system's own established convention (see PROJECT-STATE's "New
// bet_type: Tournament Winner" entry, 2026-08-01), ALL individual-sport
// golf bets -- including an outright tournament win -- route through the
// Player Prop pathway rather than a dedicated bet type, so this function
// is the only thing that will ever grade them.
//
// Recognizes exactly 3 `prop_stat` values, matched case/spacing-
// insensitively via normalize():
//   - "Tournament Winner": prop_player is picked to win the whole event
//     outright. No opponent needed.
//   - "Tournament Matchup": prop_player is picked to finish the WHOLE
//     event better than the golfer named in `selection` (the opponent).
//   - "Round Matchup": same as above, but scoped to a single round, not
//     the whole event.
// For both matchup types, `selection` holds the opponent's name -- this
// is a deliberate reuse of an existing column, not a new one. It works
// because, unlike Tennis (where the real opponent can be inferred from
// that day's actual tour draw), golf has no natural 1-on-1 pairing in the
// underlying data -- every player in the field plays the same round
// simultaneously, so there is no way to infer who a "matchup" bet is
// actually against without being told directly.
//
// Data source: ESPN's real, free, keyless golf scoreboard
// (site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=YYYYMMDD).
// Confirmed directly (live fetch, 2026-08-15, FedEx St. Jude Championship,
// mid-tournament): querying ANY calendar day within a multi-day event's
// window correctly returns that same event (not just its start date), so
// no separate "which day is this tournament's Round 1" lookup is needed
// beyond the event's own `date` field. Each competitor has:
//   - `score`: their overall to-par total for the tournament so far
//     (string, e.g. "-11", "E", "+3")
//   - `linescores[]`: one entry per round played, `period` = round number
//     (1-4), each with the same to-par `displayValue` format as above
//   - `order`: their live/final leaderboard rank (1 = the leader/winner)
// PGA TOUR ONLY for now -- confirmed this specific endpoint only covers
// PGA Tour events. LPGA/Champions Tour/Korn Ferry/European Tour picks
// will correctly fall through to "unmatched" with a clear reason (no
// event found) rather than silently mis-grading -- not a supported gap,
// just an honest one, same as Golf itself was previously fully excluded
// from schedule-sync-backfill.
//
// ROUND NUMBER: inferred from the pick's own `event_date`, using the same
// convention every other sport in this system already relies on
// (event_date = the actual calendar day of play). Computed as the whole-
// day offset between the pick's event_date and the tournament's own
// start date (event.date), so it isn't hardcoded to "Thursday = Round 1"
// -- still correct for a tournament that doesn't start on a Thursday.
// HONEST CAVEAT, not independently verified: this assumes one round per
// calendar day, the near-universal case, but can be wrong after a
// weather delay pushes a round to a 5th day. A pick entered against the
// "wrong" calendar day in that scenario would compare against the wrong
// round -- not detected or guarded against here, since ESPN's per-
// competitor data doesn't expose a clean per-round calendar date to cross-
// check against without fragile string-parsing of a tee-time field.
//
// MISSED CUT / WITHDRAWAL: no explicit status field was found on ESPN's
// golf competitors (unlike team-sport competitors elsewhere in this
// project). Handled pragmatically instead of guessed at:
//   - Tournament Matchup compares final `score` directly, whatever it is
//     -- a cut player's own score (from however many rounds they
//     actually played) is still a real, valid number to compare, and in
//     the near-universal case a cut player's score is worse anyway, so
//     this settles correctly without needing to specially detect "cut."
//     Only a player with NO score at all (a true pre-tournament WD, never
//     teed off) fails to parse and falls through to "pending" for manual
//     review.
//   - Round Matchup requires a real linescore entry for that SPECIFIC
//     round for both players; if either is missing one (round not played
//     yet, OR a WD before it -- these look identical in ESPN's own data,
//     no way to tell them apart from here), the pick is left `pending`
//     rather than guessed -- same "leave alone if not confidently
//     resolvable" principle grade_picks already uses for games not yet
//     final.
//
// PUSH: an exact tie on the relevant score grades as a push -- standard
// sportsbook convention, confirmed directly with the project owner before
// building this (2026-08-15).
//
// Only ever touches picks where result = 'pending', sport = Golf, the
// bet type has uses_prop_fields = true, and prop_stat is one of the 3
// values above -- every other pick, sport, and bet type is completely
// untouched.
//
// ADDED 2026-08-22, direct request: "Tennis cappers have a tendency to
// use last name only a lot of the time... can this be applied to Golf?"
// findCompetitor now matches by exact surname as a fallback after exact
// full name, same discipline as grade_picks_espn_backfill's player-prop
// and MMA matching -- and along the way, fixed a real pre-existing bug
// in the OLD fallback here (a loose substring match with no check for a
// SECOND golfer also containing that substring in a 150+ player field --
// same class of collision already fixed elsewhere in this codebase for
// team names). Also now registers any player confirmed by a successful
// grade into known_players (shared with grade_picks_espn_backfill) --
// only from a pick that actually resolved, never from the match alone,
// so a wrong name can't get in without a human forcing it by hand.
//
// Call with: POST /grade-golf-picks?date=2026-08-14

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '');
}

const STAT_ROUND_MATCHUP = normalize('Round Matchup');
const STAT_TOURNAMENT_MATCHUP = normalize('Tournament Matchup');
const STAT_TOURNAMENT_WINNER = normalize('Tournament Winner');

// CONFIRMED FIX, ported from validate-nba-player-txt/validate-wnba-player-txt
// (same real-world failure, same real fix): a bare fetch() to ESPN sends no
// User-Agent header at all, which is a known trigger for an API's bot-
// protection/WAF to hard-reset the connection instead of responding
// normally, even though the identical request works fine from anywhere
// that sends a real browser-style User-Agent. Applied proactively here
// (not from a confirmed failure of THIS specific function yet) since the
// underlying cause is about how Deno's Edge Function runtime talks to
// ESPN, not anything specific to golf data -- same root cause already
// twice-confirmed for two sibling functions calling the same host.
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

// ADDED 2026-08-22, same pattern/reasoning as grade_picks_espn_backfill's
// own registerKnownPlayer (see that file's comment) -- only ever called
// from a spot where a golf pick JUST resolved successfully, never from
// the matching step alone, so a wrong name structurally can't get in
// without a human forcing a grade by hand. Wrapped so a missing
// known_players table (migration not run yet) or any other failure here
// can never surface as a grading failure -- the pick above it already
// graded and was already written.
// Direct request 2026-08-31: "give us first and last name to make the
// automatic tools that check data have an easier time." Same "last
// whitespace-separated token is the surname" convention already used for
// surname-only matching elsewhere -- a single-word name has no real
// surname to split out, so first_name is left null rather than guessed.
function splitName(name: string): { first: string | null; last: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { first: null, last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}
async function registerKnownPlayer(supabaseUrl: string, serviceRoleKey: string, sportId: number, name: string | null | undefined) {
  if (!name) return;
  try {
    const { first, last } = splitName(name);
    await db(supabaseUrl, serviceRoleKey, 'known_players', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ sport_id: sportId, name, first_name: first, last_name: last })
    });
  } catch (_e) {
    // Silently skip -- see comment above.
  }
}

// Parses ESPN's own to-par display format ("-11", "E", "+3") into a plain
// number -- same format used both for a competitor's overall score and
// for a single round's score, so this one helper covers both.
function parseToPar(displayValue: string | undefined | null): number | null {
  if (displayValue === undefined || displayValue === null) return null;
  if (displayValue === 'E') return 0;
  const n = Number(displayValue);
  return isNaN(n) ? null : n;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'Missing required secret(s) (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(req.url);
    const targetDate = url.searchParams.get('date');
    if (!targetDate) {
      return new Response(JSON.stringify({ error: 'Missing required "date" query parameter, e.g. ?date=2026-08-14' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const sportsRows = await db(supabaseUrl, serviceRoleKey, `sports?select=id,name&name=eq.Golf`);
    const golfSport = sportsRows && sportsRows[0];
    if (!golfSport) {
      return new Response(JSON.stringify({ error: 'No "Golf" row found in the sports table.' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const picks = await db(supabaseUrl, serviceRoleKey,
      `picks?select=id,selection,prop_player,prop_stat,event_date,bet_types(uses_prop_fields)&sport_id=eq.${golfSport.id}&event_date=eq.${targetDate}&result=eq.pending&prop_player=not.is.null`
    );
    const relevant = (picks || []).filter((p: any) => {
      if (!p.bet_types || !p.bet_types.uses_prop_fields) return false;
      const statNorm = normalize(p.prop_stat || '');
      return statNorm === STAT_ROUND_MATCHUP || statNorm === STAT_TOURNAMENT_MATCHUP || statNorm === STAT_TOURNAMENT_WINNER;
    });

    const result = { date: targetDate, checked: relevant.length, graded: [] as any[], pending: [] as any[], unmatched: [] as any[] };

    if (!relevant.length) {
      return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const espnDate = targetDate.replace(/-/g, '');
    const scoreboardRes = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${espnDate}`);
    if (!scoreboardRes.ok) {
      return new Response(JSON.stringify({ ...result, error: `ESPN golf scoreboard request failed (${scoreboardRes.status})` }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const scoreboardData = await scoreboardRes.json();
    const event = scoreboardData.events && scoreboardData.events[0];
    if (!event) {
      for (const p of relevant) {
        result.unmatched.push({ id: p.id, reason: `No PGA Tour event found on ${targetDate} -- if this is an LPGA/Champions/Korn Ferry/European Tour pick, this function doesn't cover those tours yet.` });
      }
      return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const comp = event.competitions && event.competitions[0];
    const competitors = (comp && comp.competitors) || [];
    const eventCompleted = !!(event.status && event.status.type && event.status.type.completed);

    const tournamentStart = new Date(event.date);
    const tournamentStartUtcMidnight = Date.UTC(tournamentStart.getUTCFullYear(), tournamentStart.getUTCMonth(), tournamentStart.getUTCDate());
    const pickDateUtcMidnight = Date.UTC(
      Number(targetDate.slice(0, 4)), Number(targetDate.slice(5, 7)) - 1, Number(targetDate.slice(8, 10))
    );
    const roundNumber = Math.round((pickDateUtcMidnight - tournamentStartUtcMidnight) / 86400000) + 1;

    // CONFIRMED REAL BUG, found and fixed together with the surname
    // feature below, direct request 2026-08-22: "Tennis cappers have a
    // tendency to use last name only... can this be applied to Golf?"
    // The OLD fallback here (cn.includes(norm) || norm.includes(cn)) was
    // unsafe -- .find() stops at the FIRST substring match with no check
    // for a SECOND golfer whose name also contains the same substring, a
    // real risk in a 150+ player PGA Tour field (e.g. searching "Scott"
    // loosely matches both "Adam Scott" and "Scottie Scheffler"),
    // silently picking whichever one happens to come first instead of
    // flagging the ambiguity -- the exact class of bug already fixed
    // elsewhere in this codebase (Chicago Cubs/White Sox, Philadelphia/
    // LA Dodgers substring collisions). Replaced with exact SURNAME
    // match only, same safe discipline as grade_picks_espn_backfill's
    // player-prop and MMA matching: collects EVERY surname match and
    // returns ambiguous=true if more than one golfer shares a last name,
    // rather than guessing.
    function findCompetitor(name: string): { competitor: any | null; ambiguous: boolean } {
      const norm = normalize(name || '');
      if (!norm) return { competitor: null, ambiguous: false };
      const exact = competitors.filter((c: any) => normalize((c.athlete && c.athlete.displayName) || '') === norm);
      if (exact.length === 1) return { competitor: exact[0], ambiguous: false };
      if (exact.length > 1) return { competitor: null, ambiguous: true };
      const bySurname = competitors.filter((c: any) => {
        const displayName = (c.athlete && c.athlete.displayName) || '';
        const tokens = displayName.trim().split(/\s+/);
        const surname = tokens.length ? normalize(tokens[tokens.length - 1]) : '';
        return surname && surname === norm;
      });
      if (bySurname.length === 1) return { competitor: bySurname[0], ambiguous: false };
      if (bySurname.length > 1) return { competitor: null, ambiguous: true };
      return { competitor: null, ambiguous: false };
    }

    for (const p of relevant) {
      const statNorm = normalize(p.prop_stat || '');
      const backedResult = findCompetitor(p.prop_player);
      if (backedResult.ambiguous) {
        result.unmatched.push({ id: p.id, prop_player: p.prop_player, reason: `"${p.prop_player}" matches more than one golfer's name/surname in this field -- needs manual review.` });
        continue;
      }
      const backed = backedResult.competitor;
      if (!backed) {
        result.unmatched.push({ id: p.id, prop_player: p.prop_player, reason: `"${p.prop_player}" was not found in the field for this PGA Tour event.` });
        continue;
      }

      if (statNorm === STAT_TOURNAMENT_WINNER) {
        if (!eventCompleted) {
          result.pending.push({ id: p.id, prop_player: p.prop_player, reason: `Tournament not finished yet.` });
          continue;
        }
        const won = backed.order === 1;
        await db(supabaseUrl, serviceRoleKey, `picks?id=eq.${p.id}`, {
          method: 'PATCH', body: JSON.stringify({ result: won ? 'win' : 'loss', graded_at: new Date().toISOString() })
        });
        result.graded.push({ id: p.id, prop_player: p.prop_player, result: won ? 'win' : 'loss', finalOrder: backed.order });
        await registerKnownPlayer(supabaseUrl, serviceRoleKey, golfSport.id, (backed.athlete && backed.athlete.displayName) || p.prop_player);
        continue;
      }

      // Round Matchup / Tournament Matchup both need the opponent, stored
      // in `selection` per this function's own header comment.
      const opponentResult = findCompetitor(p.selection);
      if (opponentResult.ambiguous) {
        result.unmatched.push({ id: p.id, prop_player: p.prop_player, reason: `Opponent "${p.selection}" matches more than one golfer's name/surname in this field -- needs manual review.` });
        continue;
      }
      const opponent = opponentResult.competitor;
      if (!opponent) {
        result.unmatched.push({ id: p.id, prop_player: p.prop_player, reason: `Opponent "${p.selection}" was not found in the field for this PGA Tour event.` });
        continue;
      }

      let backedVal: number | null = null;
      let oppVal: number | null = null;
      let scopeLabel = '';

      if (statNorm === STAT_TOURNAMENT_MATCHUP) {
        if (!eventCompleted) {
          result.pending.push({ id: p.id, prop_player: p.prop_player, reason: `Tournament not finished yet.` });
          continue;
        }
        backedVal = parseToPar(backed.score);
        oppVal = parseToPar(opponent.score);
        scopeLabel = 'final tournament score';
      } else if (statNorm === STAT_ROUND_MATCHUP) {
        if (roundNumber < 1 || roundNumber > 4) {
          result.unmatched.push({ id: p.id, prop_player: p.prop_player, reason: `This pick's event_date doesn't fall within this tournament's round window (computed round ${roundNumber}) -- check the date entered.` });
          continue;
        }
        const backedRound = (backed.linescores || []).find((l: any) => l.period === roundNumber);
        const oppRound = (opponent.linescores || []).find((l: any) => l.period === roundNumber);
        if (!backedRound || !oppRound) {
          result.pending.push({ id: p.id, prop_player: p.prop_player, reason: `Round ${roundNumber} isn't recorded yet for one or both players.` });
          continue;
        }
        backedVal = parseToPar(backedRound.displayValue);
        oppVal = parseToPar(oppRound.displayValue);
        scopeLabel = `Round ${roundNumber} score`;
      } else {
        continue; // unreachable -- already filtered to the 3 known stat values above
      }

      if (backedVal === null || oppVal === null) {
        result.pending.push({ id: p.id, prop_player: p.prop_player, reason: `Could not read a usable ${scopeLabel} for one or both players yet -- may mean one hasn't teed off, missed the cut, or withdrew.` });
        continue;
      }

      let outcome: 'win' | 'loss' | 'push';
      if (backedVal < oppVal) outcome = 'win';
      else if (backedVal > oppVal) outcome = 'loss';
      else outcome = 'push';

      await db(supabaseUrl, serviceRoleKey, `picks?id=eq.${p.id}`, {
        method: 'PATCH', body: JSON.stringify({ result: outcome, graded_at: new Date().toISOString() })
      });
      result.graded.push({ id: p.id, prop_player: p.prop_player, opponent: p.selection, scope: scopeLabel, backedVal, oppVal, result: outcome });
      // Both golfers in this matchup are now confirmed real (this exact
      // matchup just resolved) -- register both, not just whichever one
      // this pick's prop_player happened to name.
      await registerKnownPlayer(supabaseUrl, serviceRoleKey, golfSport.id, (backed.athlete && backed.athlete.displayName) || p.prop_player);
      await registerKnownPlayer(supabaseUrl, serviceRoleKey, golfSport.id, (opponent.athlete && opponent.athlete.displayName) || p.selection);
    }

    return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
