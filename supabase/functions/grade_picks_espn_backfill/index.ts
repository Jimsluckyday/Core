// grade_picks_espn_backfill
// Same job as grade_picks (fetches final scores, grades pending picks for
// one date), but sources scores from ESPN's public scoreboard endpoint
// instead of TheRundown -- built specifically for grading OLD picks that
// TheRundown's Free plan can no longer reach (7-day history limit).
// No API key needed at all: this is ESPN's unofficial, undocumented
// scoreboard API, but it has genuine historical coverage with no rolling
// window observed. Kept as a SEPARATE function from grade_picks on
// purpose -- TheRundown continues to handle anything within its 7-day
// window going forward; this one is for the backlog specifically.
//
// Only sports with a real ESPN scoreboard mapping below are attempted --
// anything else (Golf, Cricket, KBO, CBA, Euro Basketball, Soccer, etc.)
// is safely skipped, same "not covered" pattern as grade_picks already
// uses for TheRundown-uncovered sports -- either because ESPN has no
// matching generic scoreboard endpoint, or because it's not a team-vs-
// team sport this function's Moneyline/Spread/Total logic could ever
// grade anyway. Tennis is the one exception, added 2026-08-29 (see the
// isTennis branch's own comment) -- Moneyline, Spread, and Total, Singles
// only, its own dedicated ATP/WTA fetch and matching entirely separate
// from everything else here, since it has no flat scoreboard endpoint to add to
// ESPN_SPORT_MAP the way every other sport does.
//
// ADDED MMA (UFC) Moneyline grading, 2026-08-22, direct request: "every
// piece we can automate is time saved from manual work." Straight
// winner-take-all only (no rounds/method-of-victory grading) -- ESPN's
// mma/ufc scoreboard slug returns a plain winner:true/false flag right
// on each competitor, same STATUS_FINAL completion flag every other
// sport already uses, so this reuses the exact same reliability
// discipline, just a completely separate matching path (fighter name,
// not team name -- see isMma below) since a bout has no home/away
// concept and ESPN's competitor shape here is athlete, not team.
//
// CONFIRMED REAL BUG, fixed here (direct report): bet-type detection used
// to be `const isTotal = pick.selection.includes('/')` -- inferring
// "this is a Total/Over-Under bet" purely from a "/" character in the
// selection, with NO check against the pick's actual bet_type. That was
// safe before admin.html v260 shipped Team 1/Team 2 dropdowns, back when
// "/" only ever showed up on genuine Total selections. Since v260, a
// "/"-combined selection is also normal for Moneyline (two named teams),
// No Run First Inning, Yes Run First Inning, Both Teams to Score, and
// Draw No Bet -- none of which should ever be graded with gradeTotal()'s
// combined-score-vs-line math. CONFIRMED this already silently mis-graded
// 3 real "No Run First Inning" picks as Total bets, writing wrong loss
// results with no error or note (the games were actually 0-0 through the
// 1st inning -- real NRFI wins). Bet-type detection is now based entirely
// on the pick's own real bet_types.name, never inferred from the
// selection text. No Run First Inning / Yes Run First Inning are now
// properly graded using each game's own 1st-inning linescores (added to
// the game/score object below) rather than the full-game total.
//
// ALSO FIXED: an unsupported bet type used to just get skipped with
// nothing written to the pick at all -- no grading_status, no
// grading_note -- so there was no record anywhere of why it wasn't
// graded. Now writes grading_status='unsupported' + a real grading_note,
// same as the ambiguous case already did.
//
// CONFIRMED REAL BUG, fixed here (direct report: "2 possible games
// matched" for Philadelphia Phillies and Los Angeles Dodgers, which only
// have ONE real game each): team matching used to substring-match every
// team-name variant, including short ones like abbreviation/
// shortDisplayName/name. Short strings collide by coincidence -- "LAD" is
// literally embedded in "phil-AD-elphia", "SD" is literally embedded in
// "los angele-s-d-odgers". Fixed by requiring an EXACT match for the short
// variants and reserving substring matching for the full location/
// displayName strings only (same fix already applied once before in
// schedule-sync-backfill.ts's "ARI inside Mariners" case, just never
// carried over to this separate file).
//
// ADDED: Team Total, Moneyline First5, and Over/Under First5/First7
// grading -- direct request: "anything we can build to catch as much of
// these without having to stop to find results is what we want as this
// needs to be as automatic and done correctly as possible." All three use
// the exact same final-score/linescore data already being fetched; no new
// data source needed. Also fixed a latent bug this surfaced: the old
// isTotalType check (`betTypeNorm.startsWith('overunder')`) would have
// silently also caught "Over/Under First 5"/"Over/Under First 7" and
// graded them off the FULL GAME score instead of just the first 5/7
// innings -- now explicitly excluded from that bucket and routed to their
// own period-scoped grading functions instead.
//
// CFL: investigated a real reported "0 games found" case (user supplied a
// screenshot proving a real CFL game existed for that date). Confirmed
// directly against ESPN's own CFL scoreboard endpoint that the sport
// mapping itself is correct, but ESPN genuinely has zero events indexed
// for CFL on that date -- a real data-coverage gap, not a bug in this
// function. No working alternate free source found (checked TheSportsDB).
// Parked the same way KBO already is: documented, not blocking.
//
// ADDED: Player Prop grading for MLB + WNBA, folded directly into this
// same function/button rather than a new separate tool -- direct request:
// "that's extra work to have to run 2 buttons and wait for results as
// well as it's possible someone forgets or the button itself breaks and
// no one notices." One run now covers games AND player props together.
// Confirmed directly against ESPN's own box score data (the summary?event=
// endpoint, same one used for linescores above) that real per-player stats
// are available for both sports -- Hits/HR/RBI/Strikeouts/Earned Runs for
// MLB, Points/Assists/Rebounds/etc for WNBA. Total Bases and pitcher Outs
// aren't their own ESPN columns and are derived instead (from slugging% x
// at-bats, and from innings-pitched notation, respectively) -- see
// deriveTotalBases/deriveOuts below for the exact math and safety checks.
// Player name matching is EXACT-normalized-match only, deliberately no
// fuzzy/substring matching (same discipline as the team-matching fix
// above) -- a typo'd name (a real, recurring issue) won't silently match
// the wrong player, it just won't match at all and gets flagged for
// review, same as any other unmatched pick.
//
// Call with: POST /grade_picks_espn_backfill?date=2026-06-04

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

// Direct request 2026-08-22, following a real case (New York Yankees @
// Boston Red Sox, 2026-06-06, confirmed postponed via ESPN's own
// scoreboard): a postponed or canceled game will never become final on
// its original event_date, so leaving it in "not final yet, check back
// later" is actively misleading -- it will NEVER resolve that way,
// unlike a genuinely in-progress or not-yet-started game. Standard
// sportsbook convention for a game that doesn't complete is "no action"
// -- void the bet, grade it push, don't hold it as pending or lose it as
// a loss. Baseball postpones frequently (rainouts), so this is worth
// handling automatically rather than something to notice by digging into
// ESPN by hand each time.
function isVoidGameStatus(statusName: string | null | undefined): boolean {
  return statusName === 'STATUS_POSTPONED' || statusName === 'STATUS_CANCELED';
}

// CONFIRMED FIX, ported from validate-nba-player-txt/validate-wnba-player-txt
// (same real-world failure, same real fix): a bare fetch() to ESPN sends no
// User-Agent header at all, which is a known trigger for an API's bot-
// protection/WAF to hard-reset the connection instead of responding
// normally, even though the identical request works fine from anywhere
// that sends a real browser-style User-Agent. Applied proactively here
// (not from a confirmed failure of THIS specific function yet) -- the
// underlying cause is about how Deno's Edge Function runtime talks to
// ESPN, not anything specific to grading.
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

// Our own sports.name (normalized) -> ESPN's {sport}/{league} URL segment.
// Confirmed directly against ESPN's real API before shipping this.
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
  // ADDED 2026-08-22, direct request: "every piece we can automate is
  // time saved... should be explored." Confirmed directly against ESPN's
  // real API before shipping (same discipline as every other mapping
  // here) -- mma/ufc is a real, working slug on the exact same free
  // scoreboard endpoint already used for every other sport, no new
  // vendor/key/cost. Straight Moneyline (winner take all) only for now --
  // see the isMma branch below for why this needs its own matching path
  // entirely separate from the team-vs-team logic every other sport uses.
  mma: 'mma/ufc',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'Missing required secret(s).' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(req.url);
    const targetDate = url.searchParams.get('date');
    const sportFilter = url.searchParams.get('sport');
    if (!targetDate) {
      return new Response(JSON.stringify({ error: 'Missing required "date" query parameter, e.g. ?date=2026-06-04' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    async function db(path: string, options: RequestInit = {}) {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        ...options,
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          ...(options.headers || {})
        }
      });
      if (!res.ok) throw new Error(`DB request failed (${res.status}): ${await res.text()}`);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    // ADDED 2026-08-22, direct request: "matching once a pick is resolved
    // so that gives us an accurate name as a wrong name wouldn't get
    // resolved unless we do it manually... this process isn't about
    // speed but accuracy." Deliberately only ever called from a spot
    // where a pick JUST got successfully graded (a real player/fighter
    // name that matched a real box score or fight card) -- never from
    // Teams/Tournaments' own roster lookup, which confirms a name earlier
    // but before the outcome is known. resolution=ignore-duplicates makes
    // this a safe no-op once a name is already registered for this sport,
    // no need to check first. Wrapped so a missing known_players table
    // (migration not run yet) or any other failure here can NEVER surface
    // as a grading failure -- the pick above this call already graded
    // successfully and was already written; this is optional bookkeeping
    // on top of that, not part of the real result.
    async function registerKnownPlayer(sportId: string, name: string | null | undefined) {
      if (!name) return;
      try {
        await db('known_players', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify({ sport_id: sportId, name })
        });
      } catch (_e) {
        // Silently skip -- see comment above.
      }
    }

    // Parlay auto-grading is date-scoped, not sport-scoped (a parlay's own
    // sport_id reflects only its most prominent leg). The caller loops this
    // function once per real sport for the ESPN-fetch work below, so this
    // rollup runs as its own dedicated, single call (?parlaysOnly=true, no
    // per-sport ESPN work at all) instead of once per sport -- otherwise the
    // same pending/graded parlays get redundantly reprocessed and reported
    // once under every sport name in the loop.
    if (url.searchParams.get('parlaysOnly') === 'true') {
      const parlayRollup = { graded: [] as any[], still_pending: [] as any[], errors: [] as any[] };
      try {
        const parlayBetType = await db(`bet_types?select=id&name=eq.Parlay`);
        const parlayBetTypeId = parlayBetType && parlayBetType[0] ? parlayBetType[0].id : null;
        if (parlayBetTypeId) {
          const pendingParlays = await db(
            `picks?select=id,selection&bet_type_id=eq.${parlayBetTypeId}&event_date=eq.${targetDate}&result=eq.pending`
          );
          for (const parlay of (pendingParlays || [])) {
            try {
              const links = await db(`parlay_legs?select=leg_pick_id&parlay_pick_id=eq.${parlay.id}`);
              const legIds = (links || []).map((l: any) => l.leg_pick_id);
              if (!legIds.length) continue;

              // CONFIRMED REAL BUG, direct report 2026-08-29: "I have no
              // way of knowing where that pick is without digging through
              // a bunch of data... the parlays need to be shown better on
              // the failure report." A real case: one leg (a real matchup
              // that already had a clear result) was correctly graded, but
              // a SECOND leg (a Tennis Moneyline pick, "Djokovic") was
              // never graded at all -- and the old report only ever said
              // "one or more legs not final yet" on the PARLAY itself, with
              // zero indication which leg, or that it wasn't even an
              // ambiguity/date problem, just a sport this function has
              // never supported. Now fetches each leg's own selection/
              // event_date/grading_note (not just result/grading_status)
              // and attaches the full per-leg breakdown directly onto every
              // still_pending/errors entry, so the actual blocking leg(s)
              // are named right in the report -- no separate query needed
              // to find them.
              const legs = await db(`picks?select=id,selection,event_date,result,grading_status,grading_note&id=in.(${legIds.join(',')})`);
              const anyLoss = legs.some((l: any) => l.result === 'loss');
              const anyAmbiguous = legs.some((l: any) => l.grading_status === 'ambiguous');
              const allDecided = legs.every((l: any) => l.result === 'win' || l.result === 'loss' || l.result === 'push');
              const allWinOrPush = legs.every((l: any) => l.result === 'win' || l.result === 'push');
              const anyWin = legs.some((l: any) => l.result === 'win');
              const legSummary = (l: any) => ({
                id: l.id, selection: l.selection, event_date: l.event_date,
                result: l.result, grading_status: l.grading_status, grading_note: l.grading_note
              });
              // Each leg's own id is embedded directly in the text (not
              // just its own JSON field) so it's pasteable straight into a
              // SQL lookup or the picks-list search from the CSV export
              // alone, without needing to open the raw JSON.
              const legsBrief = legs.map((l: any) =>
                `"${l.selection}" (${l.event_date}, id ${l.id}): ${l.result}${l.grading_status === 'ambiguous' ? ' [ambiguous' + (l.grading_note ? ' -- ' + l.grading_note : '') + ']' : ''}`
              ).join(' | ');
              const notFinalLegs = legs.filter((l: any) => l.result !== 'win' && l.result !== 'loss' && l.result !== 'push');

              if (anyLoss) {
                await db(`picks?id=eq.${parlay.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ result: 'loss', grading_status: 'graded', grading_note: null })
                });
                parlayRollup.graded.push({ id: parlay.id, selection: parlay.selection, result: 'loss', legs: legs.map(legSummary) });
              } else if (allDecided && allWinOrPush) {
                const grade = anyWin ? 'win' : 'push';
                await db(`picks?id=eq.${parlay.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ result: grade, grading_status: 'graded', grading_note: null })
                });
                parlayRollup.graded.push({ id: parlay.id, selection: parlay.selection, result: grade, legs: legs.map(legSummary) });
              } else if (anyAmbiguous) {
                await db(`picks?id=eq.${parlay.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({
                    grading_status: 'ambiguous',
                    grading_note: 'At least one linked leg could not be confidently graded -- resolve that leg first.'
                  })
                });
                parlayRollup.still_pending.push({
                  id: parlay.id, selection: parlay.selection, reason: `a leg is ambiguous -- legs: ${legsBrief}`,
                  legs: legs.map(legSummary)
                });
              } else {
                const blockerNames = notFinalLegs.map((l: any) => `"${l.selection}" (${l.event_date}, id ${l.id})`).join(', ');
                parlayRollup.still_pending.push({
                  id: parlay.id, selection: parlay.selection,
                  reason: `still pending on: ${blockerNames} -- full legs: ${legsBrief}`,
                  legs: legs.map(legSummary)
                });
              }
            } catch (legErr) {
              parlayRollup.errors.push({ id: parlay.id, selection: parlay.selection, reason: String(legErr) });
            }
          }
        }
      } catch (rollupErr) {
        parlayRollup.errors.push({ error: String(rollupErr) });
      }
      return new Response(JSON.stringify({ date: targetDate, parlay_rollup: parlayRollup }, null, 2), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    let ourSports = await db(`sports?select=id,name`);
    if (sportFilter) ourSports = (ourSports || []).filter((s: any) => normalize(s.name) === normalize(sportFilter));
    if (!ourSports || !ourSports.length) {
      return new Response(JSON.stringify({ error: sportFilter ? `No sport named "${sportFilter}" found.` : 'No sports found in your sports table at all.' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    function gradeMoneyline(score: any, isHome: boolean): 'win' | 'loss' | null {
      const won = isHome ? score.winner_home === 1 : score.winner_away === 1;
      const lost = isHome ? score.winner_away === 1 : score.winner_home === 1;
      if (won) return 'win';
      if (lost) return 'loss';
      return null;
    }

    function gradeSpread(score: any, isHome: boolean, line: number): 'win' | 'loss' | 'push' {
      const ownScore = isHome ? score.score_home : score.score_away;
      const oppScore = isHome ? score.score_away : score.score_home;
      const adjusted = (ownScore - oppScore) + line;
      if (adjusted > 0) return 'win';
      if (adjusted < 0) return 'loss';
      return 'push';
    }

    function gradeTotal(score: any, line: number): 'win' | 'loss' | 'push' {
      const combined = score.score_home + score.score_away;
      const threshold = Math.abs(line);
      const isOver = line < 0;
      if (combined === threshold) return 'push';
      if (isOver) return combined > threshold ? 'win' : 'loss';
      return combined < threshold ? 'win' : 'loss';
    }

    // Game-level -- doesn't matter which team, just whether EITHER team
    // scored in the 1st. Needs both teams' 1st-inning runs to be known;
    // returns null (treated as ambiguous/needs-review, same as an
    // incomplete score elsewhere in this file) if either is missing.
    function gradeNoRunFirstInning(score: any): 'win' | 'loss' | null {
      if (score.first_inning_home === null || score.first_inning_away === null) return null;
      return (score.first_inning_home === 0 && score.first_inning_away === 0) ? 'win' : 'loss';
    }

    function gradeYesRunFirstInning(score: any): 'win' | 'loss' | null {
      const nrfi = gradeNoRunFirstInning(score);
      if (nrfi === null) return null;
      return nrfi === 'win' ? 'loss' : 'win';
    }

    // CONFIRMED real gap, direct request: "anything we can build to catch
    // as much of these without having to stop to find results is what we
    // want." Team Total (one team's own score vs. a line -- same
    // negative-line=Over/positive=Under sign convention already used
    // everywhere else in this project, inferred directly from real data:
    // the same capper's own Pittsburgh Pirates (+4.5) and Houston Astros
    // (-4.5) picks on the same real day only make sense if that same
    // convention is already what's being typed in) was previously routed
    // straight to unsupported_bet_type even though the exact same
    // final-score data already being fetched is all it needs.
    function gradeTeamTotal(ownScore: number, line: number): 'win' | 'loss' | 'push' {
      const threshold = Math.abs(line);
      const isOver = line < 0;
      if (ownScore === threshold) return 'push';
      if (isOver) return ownScore > threshold ? 'win' : 'loss';
      return ownScore < threshold ? 'win' : 'loss';
    }

    // Sums the first N linescore entries (innings) for one team -- null
    // (never guessed) the moment any of the first N entries is missing,
    // same "don't know beats a wrong guess" discipline as
    // first_inning_home/away above.
    function sumFirstNInnings(linescores: any, n: number): number | null {
      if (!linescores) return null;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const entry = linescores[i];
        if (!entry || entry.displayValue === undefined || entry.displayValue === null || entry.displayValue === '') return null;
        sum += Number(entry.displayValue);
      }
      return sum;
    }

    // Moneyline First 5/First 7 -- same idea as full-game Moneyline, just
    // scoped to the first N innings using first5_home/away or
    // first7_home/away (added to the score object below) instead of the
    // full-game score_home/score_away. A tie through N innings is graded
    // push, the standard sportsbook convention for this bet type (unlike a
    // full-game Moneyline, which essentially never ties in baseball).
    function gradeMoneylineFirstN(score: any, isHome: boolean, n: 5 | 7): 'win' | 'loss' | 'push' | null {
      const homeVal = n === 5 ? score.first5_home : score.first7_home;
      const awayVal = n === 5 ? score.first5_away : score.first7_away;
      if (homeVal === null || awayVal === null) return null;
      const ownScore = isHome ? homeVal : awayVal;
      const oppScore = isHome ? awayVal : homeVal;
      if (ownScore > oppScore) return 'win';
      if (ownScore < oppScore) return 'loss';
      return 'push';
    }

    // Over/Under First 5/First 7 -- same math as full-game gradeTotal(),
    // just against the combined score through N innings instead of the
    // final combined score.
    function gradeTotalFirstN(score: any, n: 5 | 7, line: number): 'win' | 'loss' | 'push' | null {
      const homeVal = n === 5 ? score.first5_home : score.first7_home;
      const awayVal = n === 5 ? score.first5_away : score.first7_away;
      if (homeVal === null || awayVal === null) return null;
      const combined = homeVal + awayVal;
      const threshold = Math.abs(line);
      const isOver = line < 0;
      if (combined === threshold) return 'push';
      if (isOver) return combined > threshold ? 'win' : 'loss';
      return combined < threshold ? 'win' : 'loss';
    }

    // Moneyline/Spread 1st Inning (MLB) and 1st Quarter/1st Half (NBA) --
    // direct request 2026-08-20: "if it's a question of it can be resolved
    // the answer should always be yes." Confirmed directly against ESPN's
    // real NBA scoreboard data: each competitor's own linescores array is
    // exactly one entry per QUARTER (same shape as MLB's per-INNING array
    // already used for NRFI/First5/First7 above -- {value, displayValue,
    // period}), so this reuses the exact same sumFirstNInnings() helper
    // and the exact same first_inning_home/away field already computed
    // for NRFI/YRFI -- for MLB that field holds the 1st inning score, for
    // NBA it holds the 1st quarter score, same field, sport-dependent
    // meaning, no new fetch or parsing needed for either. 1st Half (NBA
    // only) uses the new first_half_home/away below (periods 1+2 summed).
    // A tie is graded push, same standard convention as First5/First7.
    function gradeMoneylinePeriod(homeVal: number | null, awayVal: number | null, isHome: boolean): 'win' | 'loss' | 'push' | null {
      if (homeVal === null || awayVal === null) return null;
      const ownScore = isHome ? homeVal : awayVal;
      const oppScore = isHome ? awayVal : homeVal;
      if (ownScore > oppScore) return 'win';
      if (ownScore < oppScore) return 'loss';
      return 'push';
    }
    function gradeSpreadPeriod(homeVal: number | null, awayVal: number | null, isHome: boolean, line: number): 'win' | 'loss' | 'push' | null {
      if (homeVal === null || awayVal === null) return null;
      const ownScore = isHome ? homeVal : awayVal;
      const oppScore = isHome ? awayVal : homeVal;
      const adjusted = (ownScore - oppScore) + line;
      if (adjusted > 0) return 'win';
      if (adjusted < 0) return 'loss';
      return 'push';
    }

    // ---- Player Prop grading (MLB, WNBA, NBA) ----
    // CONFIRMED REAL GAP, direct report 2026-08-20: NBA was the single
    // largest remaining category of "unsupported" picks after the WNBA/MLB
    // Player Prop work above (roughly 48 of ~60 in one real day's batch) --
    // not a data problem, NBA was simply never added to this list at all.
    // Confirmed directly against ESPN's own NBA box score data (a real
    // June 5 2026 Knicks @ Spurs game): identical schema to WNBA -- same
    // stat keys (points/rebounds/assists/steals/blocks/turnovers/3PM), one
    // single stat group with no pitching/batting-style split (same as
    // WNBA), so NBA_STAT_SPECS below is a straight copy of WNBA_STAT_SPECS
    // and needs no new matching logic at all.
    const PLAYER_PROP_SPORTS = ['mlb', 'wnba', 'nba'];

    // Which raw ESPN box-score stat group + key to read for each prop
    // stat, in the order to try them. "strikeouts" tries pitching first
    // (the dominant real betting market for this stat) and falls back to
    // batting only if the named player never shows up in the pitching box
    // score at all for that game. derive flags route to a computed value
    // for stats ESPN doesn't expose as their own column (Total Bases,
    // Outs); hrrbi and the WNBA combo stats (PRA/PR/PA/RA) are summed from
    // two or three already-available keys, handled specially below rather
    // than needing their own derive function.
    type StatSpec = { key: string; group: 'batting' | 'pitching'; derive?: 'outs' | 'attempted' };
    const MLB_STAT_SPECS: Record<string, StatSpec[]> = {
      hits: [{ key: 'hits', group: 'batting' }],
      homeruns: [{ key: 'homeRuns', group: 'batting' }],
      hr: [{ key: 'homeRuns', group: 'batting' }],
      rbi: [{ key: 'RBIs', group: 'batting' }],
      rbis: [{ key: 'RBIs', group: 'batting' }],
      hrrbi: [{ key: '', group: 'batting' }],
      // Direct report 2026-08-29: confirmed directly against a real ESPN
      // box score (2025-06-02, MIL @ CIN) that "walks" is a real key in
      // the BATTING stat group, not just pitching (where it was already
      // wired up as walksallowed) -- this was simply never added, not a
      // real data gap. FOLLOW-UP direct report, same session: a plain
      // "Walks" prop on Tomoyuki Sugano (a pitcher) came back "found the
      // player but couldn't read a value" -- his box score row that day
      // only had pitching stats (see fixed sample). Same ambiguity as
      // strikeouts just below (a named player could mean either side of
      // the ball) -- now tries PITCHING first (the dominant real market
      // for a pitcher prop, same reasoning strikeouts already uses), then
      // falls back to BATTING for a position player like the confirmed
      // 2025-06-02 case.
      walks: [{ key: 'walks', group: 'pitching' }, { key: 'walks', group: 'batting' }],
      // Same "sum two already-available keys" pattern as hrrbi just above
      // -- a real capper (Rhino) posts this combo prop regularly. The line
      // structure (Over/Under a .5 number) confirms it's a literal summed
      // count (hits + home runs, intentionally double-counting a HR at-bat
      // as both a hit and a homer -- the same convention PrizePicks/
      // Underdog use for this exact combo), not a boolean.
      hrhits: [{ key: '', group: 'batting' }],
      // Direct report 2026-08-29, same Rhino combo family as hrhits above
      // but a genuinely different shape -- confirmed with the user rather
      // than assumed: "1 HR & a hit so 2 hits with one being a HR." Unlike
      // hrhits (a literal sum), this is a yes/no condition -- did the
      // player BOTH hit a home run AND finish with 2+ total hits -- graded
      // as 1 (true) or 0 (false) against the same Over(-0.5) structure,
      // not a count. Confirmed this materially changes the grade vs. the
      // summed reading for a real June 3 2025 batch (a player with 2 hits
      // and 0 HR is a loss here, a win under the summed convention).
      hr2hits: [{ key: '', group: 'batting' }],
      // CONFIRMED REAL GAP, direct report 2026-08-29: failed to find Juan
      // Soto's "Hits Runs & RBI" combo (line -1.5) for 2025-06-04. Same
      // "sum of already-available keys" pattern as hrrbi/hrhits above --
      // a literal count of hits + runs + RBI, same PrizePicks/Underdog-
      // style combo convention (double-counting is expected, e.g. a solo
      // HR is 1 hit + 1 run + 1 RBI = 3 toward this total).
      // COLLISION RISK, worth remembering if this stat ever comes back
      // wrong: normalize() strips all non-alphanumeric characters, so if
      // a capper ever abbreviates this as "H+R+RBI" instead of writing it
      // out, that ALSO normalizes to "hrrbi" -- identical to the existing,
      // completely different HR+RBI combo just above. Only safe because
      // "Hits Runs & RBI" (this real case) normalizes to "hitsrunsrbi",
      // a distinct key -- if a future pick's prop_stat is the abbreviated
      // form, it will silently grade as Home Run + RBI instead of Hits +
      // Runs + RBI. Not fixed here (no real case of the abbreviated form
      // seen yet, and guessing which of two real, differently-shaped
      // markets an ambiguous abbreviation means would be worse than
      // leaving it -- same "don't guess on real-money grading" principle
      // as HR & Hits vs HR & 2 Hits earlier this project) -- if that
      // collision ever actually happens, it needs a real disambiguating
      // signal (e.g. the line's typical range differs a lot between the
      // two markets), not a coin flip.
      hitsrunsrbi: [{ key: '', group: 'batting' }],
      runs: [{ key: 'runs', group: 'batting' }],
      strikeouts: [{ key: 'strikeouts', group: 'pitching' }, { key: 'strikeouts', group: 'batting' }],
      earnedrunsallowed: [{ key: 'earnedRuns', group: 'pitching' }],
      earnedruns: [{ key: 'earnedRuns', group: 'pitching' }],
      hitsallowed: [{ key: 'hits', group: 'pitching' }],
      walksallowed: [{ key: 'walks', group: 'pitching' }],
      homerunsallowed: [{ key: 'homeRuns', group: 'pitching' }],
      outs: [{ key: '', group: 'pitching', derive: 'outs' }],
    };
    const WNBA_STAT_SPECS: Record<string, StatSpec[]> = {
      points: [{ key: 'points', group: 'batting' }],
      pts: [{ key: 'points', group: 'batting' }],
      assists: [{ key: 'assists', group: 'batting' }],
      ast: [{ key: 'assists', group: 'batting' }],
      rebounds: [{ key: 'rebounds', group: 'batting' }],
      reb: [{ key: 'rebounds', group: 'batting' }],
      rebs: [{ key: 'rebounds', group: 'batting' }],
      steals: [{ key: 'steals', group: 'batting' }],
      stl: [{ key: 'steals', group: 'batting' }],
      blocks: [{ key: 'blocks', group: 'batting' }],
      blk: [{ key: 'blocks', group: 'batting' }],
      turnovers: [{ key: 'turnovers', group: 'batting' }],
      threepointersmade: [{ key: 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', group: 'batting' }],
      threesmade: [{ key: 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', group: 'batting' }],
      // CONFIRMED REAL GAP, direct report 2026-08-20: "3pt made" (a real
      // transcribed prop_stat, distinct wording from "Threes made"/"3-
      // Pointers Made" above) normalizes to "3ptmade" and had no entry --
      // same stat, just a third phrasing nobody had typed yet.
      '3ptmade': [{ key: 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', group: 'batting' }],
      pointsreboundsassists: [{ key: '', group: 'batting' }],
      pointsrebounds: [{ key: '', group: 'batting' }],
      pointsassists: [{ key: '', group: 'batting' }],
      reboundsassists: [{ key: '', group: 'batting' }],
      // CONFIRMED REAL GAP, direct report 2026-08-20: "Pts/Assists" (a real
      // transcribed prop_stat) normalizes to "ptsassists" and had no entry
      // here at all, even though the single-stat abbreviations just above
      // (pts/ast/reb/stl/blk) already work fine -- the combo stats simply
      // never got the same abbreviated-form treatment. Same reasoning
      // extended to the other two/three-stat combos.
      ptsrebassists: [{ key: '', group: 'batting' }],
      ptsreb: [{ key: '', group: 'batting' }],
      ptsassists: [{ key: '', group: 'batting' }],
      rebassists: [{ key: '', group: 'batting' }],
      // CONFIRMED REAL GAP, direct report 2026-08-20: "Pts/Rebounds/Assists"
      // normalizes to "ptsreboundsassists" (mixed abbreviation -- "Pts" short,
      // "Rebounds"/"Assists" spelled out) -- yet ANOTHER phrasing distinct
      // from both "pointsreboundsassists" (all spelled out) and
      // "ptsrebassists" (all abbreviated) above. Same underlying stat.
      ptsreboundsassists: [{ key: '', group: 'batting' }],
      // ADDED 2026-08-23, direct request: "anything we can do to get this
      // done automatically." Confirmed directly against a real box score
      // (Spurs @ Knicks, 2026-06-08) that ESPN's stat keys are
      // 'fieldGoalsMade-fieldGoalsAttempted' and
      // 'freeThrowsMade-freeThrowsAttempted' -- same "made-attempted"
      // compound format already proven for 3-pointers above. Free throws
      // reuses espnStatToNumber's existing "take the first number" default
      // (made), matching the same convention 3-pointers already use.
      // Field Goal Attempts needs the SECOND number instead, hence the new
      // derive:'attempted' path below rather than reusing the plain key
      // lookup.
      freethrows: [{ key: 'freeThrowsMade-freeThrowsAttempted', group: 'batting' }],
      ft: [{ key: 'freeThrowsMade-freeThrowsAttempted', group: 'batting' }],
      freethrowsmade: [{ key: 'freeThrowsMade-freeThrowsAttempted', group: 'batting' }],
      fieldgoalattempts: [{ key: 'fieldGoalsMade-fieldGoalsAttempted', group: 'batting', derive: 'attempted' }],
      fga: [{ key: 'fieldGoalsMade-fieldGoalsAttempted', group: 'batting', derive: 'attempted' }],
    };
    // Identical box-score schema to WNBA (confirmed directly, see
    // PLAYER_PROP_SPORTS comment above) -- same spec, same keys.
    const NBA_STAT_SPECS: Record<string, StatSpec[]> = WNBA_STAT_SPECS;

    // Compound "made-attempted" fields (e.g. "3-8") -- caller wants the
    // made count, always the first number. Plain numeric fields pass
    // straight through.
    function espnStatToNumber(raw: any): number | null {
      if (raw === undefined || raw === null || raw === '--' || raw === '') return null;
      const s = String(raw);
      if (/^-?\d+-\d+$/.test(s)) return Number(s.split('-')[0]);
      const n = Number(s);
      return isNaN(n) ? null : n;
    }

    // Same "made-attempted" parsing as espnStatToNumber, but returns the
    // ATTEMPTED count (second number) instead of made -- added for Field
    // Goal Attempts. Deliberately returns null (not a misread) if the raw
    // value isn't in the expected "N-N" shape, rather than falling back to
    // treating a bare number as an attempt count.
    function espnStatToNumberAttempted(raw: any): number | null {
      if (raw === undefined || raw === null || raw === '--' || raw === '') return null;
      const s = String(raw);
      return /^-?\d+-\d+$/.test(s) ? Number(s.split('-')[1]) : null;
    }

    // CONFIRMED REAL FINDING, direct report ("one type failed which was
    // the total base prop"): Total Bases was originally derived here from
    // slugging% x at-bats, on the assumption that avg/onBasePct/slugAvg in
    // this box score were per-game values. Checked directly against a real
    // game (Pete Crow-Armstrong, 2026-06-04): avg/onBasePct/slugAvg here
    // are his SEASON rate stats, not this game's -- ESPN's site API box
    // score doesn't expose a per-game slugging percentage at all, and
    // doesn't break out doubles/triples anywhere either, so Total Bases
    // genuinely can't be computed from hits+HR alone (a non-HR hit could
    // be a single, double, or triple -- each worth a different number of
    // bases). The sanity check that used to guard this derivation was
    // doing its job correctly the whole time (season SLG never coincides
    // closely enough with a real game's AB/TB ratio to pass), which is why
    // every Total Bases pick came back "couldn't read a value" instead of
    // a wrong grade -- but since it could never actually succeed, direct
    // decision 2026-08-17: drop the derivation entirely and report Total
    // Bases as unsupported with a clear reason instead, rather than a
    // permanently-doomed "needs review." (There IS a deeper play-by-play
    // cross-reference that could recover this -- explicitly deferred.)

    // Outs isn't its own column either -- derived from innings pitched,
    // which ESPN already reports in real baseball notation (".1"/".2" = 1/2
    // outs, NOT true decimal tenths), so this parses it the same way
    // rather than naively multiplying by 10.
    function deriveOuts(pitchingKeys: string[], athleteStats: string[]): number | null {
      const ipIdx = pitchingKeys.indexOf('fullInnings.partInnings');
      if (ipIdx === -1) return null;
      const n = espnStatToNumber(athleteStats[ipIdx]);
      if (n === null) return null;
      const fullInnings = Math.floor(n);
      const partialOuts = Math.round((n - fullInnings) * 10);
      return fullInnings * 3 + partialOuts;
    }

    async function fetchBoxscore(espnPath: string, eventId: string, cache: Record<string, any>) {
      if (eventId in cache) return cache[eventId];
      await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const res = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/summary?event=${eventId}`);
        cache[eventId] = res.ok ? (await res.json()).boxscore || null : null;
      } catch {
        cache[eventId] = null;
      }
      return cache[eventId];
    }

    // Direct report 2026-08-29: "I see on their website it's listed on the
    // box score" -- confirmed the user was right. ESPN's site API box
    // score never exposes doubles/triples (see the long comment above
    // deriveOuts for the full story on that), but MLB's OWN official Stats
    // API -- already proven reliable elsewhere in this project (mlb-
    // schedule-sync, schedule-sync-backfill, validate-mlb-player-txt) --
    // carries doubles/triples/totalBases as real, direct per-player
    // fields. Confirmed directly against a real game (2025-06-02, MIL @
    // CIN, Elly De La Cruz): {"doubles":0,"triples":0,"totalBases":1,...}
    // right on the batting stat line. Fetched ONLY for Total Bases/Singles
    // (the two stats ESPN structurally can't provide) -- everything else
    // stays on the existing ESPN-based path, which already works fine.
    const mlbStatsApiGamesCache: Record<string, { gamePk: string; isFinal: boolean }[]> = {};
    async function fetchMlbStatsApiGames(targetDateStr: string) {
      if (targetDateStr in mlbStatsApiGamesCache) return mlbStatsApiGamesCache[targetDateStr];
      try {
        const res = await espnFetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${targetDateStr}`);
        const data = res.ok ? await res.json() : null;
        const rawGames = (data && data.dates && data.dates[0] && data.dates[0].games) || [];
        mlbStatsApiGamesCache[targetDateStr] = rawGames.map((g: any) => ({
          gamePk: String(g.gamePk), isFinal: !!(g.status && g.status.abstractGameState === 'Final')
        }));
      } catch {
        mlbStatsApiGamesCache[targetDateStr] = [];
      }
      return mlbStatsApiGamesCache[targetDateStr];
    }
    const mlbStatsApiBoxscoreCache: Record<string, any> = {};
    async function fetchMlbStatsApiBoxscore(gamePk: string) {
      if (gamePk in mlbStatsApiBoxscoreCache) return mlbStatsApiBoxscoreCache[gamePk];
      await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const res = await espnFetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`);
        mlbStatsApiBoxscoreCache[gamePk] = res.ok ? await res.json() : null;
      } catch {
        mlbStatsApiBoxscoreCache[gamePk] = null;
      }
      return mlbStatsApiBoxscoreCache[gamePk];
    }
    // Same "check everywhere, only accept a UNIQUE match" discipline as
    // the ESPN-based lookup elsewhere in this file -- a same-day name
    // collision across two different games must never be silently
    // guessed. Doubleheader disambiguation (see the ESPN path's own
    // handling) isn't ported here -- left as a known gap, since it's a
    // much rarer combination (two Total Bases/Singles props on the same
    // doubleheader player) than worth blocking this fix on.
    async function findMlbStatsApiBatting(playerNorm: string, targetDateStr: string): Promise<{ batting: any; status: 'ok' | 'not_found' | 'not_final' | 'ambiguous' }> {
      const games = await fetchMlbStatsApiGames(targetDateStr);
      const matches: any[] = [];
      let foundNotFinal = false;
      for (const g of games) {
        const box = await fetchMlbStatsApiBoxscore(g.gamePk);
        if (!box || !box.teams) continue;
        for (const side of ['home', 'away'] as const) {
          const team = box.teams[side];
          if (!team || !team.players) continue;
          for (const pid of Object.keys(team.players)) {
            const p = team.players[pid];
            const fullName: string = (p.person && p.person.fullName) || '';
            if (!fullName) continue;
            const nameTokens = fullName.trim().split(/\s+/);
            const surnameNorm = nameTokens.length ? normalize(nameTokens[nameTokens.length - 1]) : '';
            if (normalize(fullName) !== playerNorm && surnameNorm !== playerNorm) continue;
            const batting = p.stats && p.stats.batting;
            if (!batting || batting.plateAppearances === undefined) continue; // registered on roster, didn't actually play
            if (!g.isFinal) { foundNotFinal = true; continue; }
            matches.push(batting);
          }
        }
      }
      if (!matches.length) return { batting: null, status: foundNotFinal ? 'not_final' : 'not_found' };
      if (matches.length > 1) return { batting: null, status: 'ambiguous' };
      return { batting: matches[0], status: 'ok' };
    }

    async function gradePlayerProp(
      pick: any, sportNorm: 'mlb' | 'wnba' | 'nba', espnPath: string, games: any[], boxCache: Record<string, any>
    ): Promise<{ grade: 'win' | 'loss' | 'push' | null; note: string | null; notFinal?: boolean; unsupported?: boolean; matchedName?: string }> {
      const statNorm = normalize(pick.prop_stat || '');
      const playerNorm = normalize(pick.prop_player || '');
      if (!playerNorm) return { grade: null, note: 'No player name recorded on this pick -- needs manual grading.' };

      if ((statNorm === 'totalbases' || statNorm === 'singles') && sportNorm === 'mlb') {
        const result = await findMlbStatsApiBatting(playerNorm, targetDate);
        if (result.status === 'not_final') {
          return { grade: null, note: 'Matched to a game today via the MLB Stats API, but it has not been marked final yet -- check back later.', notFinal: true };
        }
        if (result.status === 'ambiguous') {
          return { grade: null, note: `"${pick.prop_player}" matched more than one MLB Stats API box score row on this date -- needs manual review.` };
        }
        if (result.status === 'ok' && result.batting) {
          const value = statNorm === 'totalbases'
            ? result.batting.totalBases
            : result.batting.hits - result.batting.doubles - result.batting.triples - result.batting.homeRuns;
          const line = Number(pick.line);
          const isOver = normalize(pick.selection) === 'over';
          const isUnder = normalize(pick.selection) === 'under';
          if (!isOver && !isUnder) {
            return { grade: null, note: `Selection "${pick.selection}" isn't a recognized Over/Under call -- needs manual review.` };
          }
          if (value === line) return { grade: 'push', note: null };
          const won = isOver ? value > line : value < line;
          return { grade: won ? 'win' : 'loss', note: null };
        }
        // result.status === 'not_found' -- returned directly here rather
        // than falling through to the STAT_SPECS lookup below, which would
        // incorrectly report "not supported" (totalbases/singles were
        // deliberately never added to MLB_STAT_SPECS, since they're
        // handled entirely through this separate MLB Stats API path) --
        // the real, more useful reason is a name/spelling mismatch, same
        // as the ESPN path's own "No player found" message below.
        return { grade: null, note: `No player named "${pick.prop_player}" found in any MLB Stats API box score on this date -- check spelling, or needs manual grading.` };
      }

      const STAT_SPECS_BY_SPORT: Record<'mlb' | 'wnba' | 'nba', Record<string, StatSpec[]>> = {
        mlb: MLB_STAT_SPECS, wnba: WNBA_STAT_SPECS, nba: NBA_STAT_SPECS
      };
      const specs = STAT_SPECS_BY_SPORT[sportNorm][statNorm];
      if (!specs) return { grade: null, unsupported: true, note: `Stat "${pick.prop_stat}" is not supported by this grader yet -- needs manual grading.` };

      // Check every one of the day's games for this sport -- same "check
      // everywhere, only accept a UNIQUE match" discipline as team
      // matching, since a same-day name collision across two different
      // games (rare, but real) must never be silently guessed.
      let foundInAnyGame = false;
      let foundInNotFinalGame = false;
      let foundInVoidedGame = false;
      const allMatches: { stats: string[]; keys: string[]; group: 'batting' | 'pitching'; displayName: string; gameId: string; startTime: string }[] = [];
      for (const g of games) {
        const completed = !!(g.status && g.status.type && g.status.type.completed);
        // Same postponed/canceled distinction as the team-game grading
        // path above -- see isVoidGameStatus's own comment.
        const gStatusName: string | null = (g.status && g.status.type && g.status.type.name) || null;
        const box = await fetchBoxscore(espnPath, g.id, boxCache);
        if (!box || !box.players) continue;
        box.players.forEach((teamBlock: any) => {
          (teamBlock.statistics || []).forEach((sg: any, sgIdx: number) => {
            (sg.athletes || []).forEach((a: any) => {
              const rawDisplayName = (a.athlete && a.athlete.displayName) || '';
              const displayNorm = normalize(rawDisplayName);
              const shortNorm = normalize((a.athlete && a.athlete.shortName) || '');
              // CONFIRMED REAL GAP, direct report 2026-08-21: a capper who
              // writes just the surname ("Ohtani", no first name/initial)
              // never matched displayName ("Shohei Ohtani") or ESPN's own
              // shortName ("S. Ohtani") -- both are exact-string compares,
              // and neither equals a bare surname. Extracted from the RAW
              // display name (normalize() strips spaces, so a surname can
              // only be split out BEFORE normalizing, not after). Same
              // "check everywhere, only accept a UNIQUE match" discipline
              // already used for team matching elsewhere in this file --
              // the existing "matched more than one box score row" guard
              // below already catches a same-day collision between two
              // different players sharing a surname (e.g. two Garcias),
              // this only adds the extra way IN to that same safety net.
              const nameTokens = rawDisplayName.trim().split(/\s+/);
              const surnameNorm = nameTokens.length ? normalize(nameTokens[nameTokens.length - 1]) : '';
              if (displayNorm === playerNorm || (shortNorm && shortNorm === playerNorm) || (surnameNorm && surnameNorm === playerNorm)) {
                foundInAnyGame = true;
                if (!completed) {
                  if (isVoidGameStatus(gStatusName)) foundInVoidedGame = true;
                  else foundInNotFinalGame = true;
                  return;
                }
                allMatches.push({
                  stats: a.stats, keys: sg.keys, displayName: rawDisplayName,
                  group: (sportNorm === 'mlb' && sgIdx === 1) ? 'pitching' : 'batting',
                  gameId: g.id, startTime: g.date
                });
              }
            });
          });
        });
      }

      if (!foundInAnyGame) {
        return { grade: null, note: `No player named "${pick.prop_player}" found in any ${sportNorm.toUpperCase()} box score on this date -- check spelling, or needs manual grading.` };
      }
      // Same postponed/canceled push as the team-game grading path above
      // -- see isVoidGameStatus's own comment. Checked before the plain
      // not-final case since a voided game will never reach "final."
      if (allMatches.length === 0 && foundInVoidedGame) {
        return { grade: 'push', note: null };
      }
      if (allMatches.length === 0 && foundInNotFinalGame) {
        return { grade: null, note: 'Matched to a game today, but ESPN has not marked it final yet -- check back later.', notFinal: true };
      }

      let value: number | null = null;
      for (const spec of specs) {
        let rowsInGroup = allMatches.filter(m => m.group === spec.group);
        if (!rowsInGroup.length) continue;
        if (rowsInGroup.length > 1) {
          // Direct request 2026-08-28: a position player who plays BOTH
          // ends of a doubleheader (unlike a starting pitcher, who only
          // ever starts one) legitimately has 2 real box score rows here.
          // Only auto-resolves when every matched row is confirmed the
          // SAME real person (identical full displayName -- two different
          // people who happen to share a surname, the exact case this
          // whole guard exists for, will have different displayNames and
          // correctly keep falling through to manual review below) AND
          // the pick is tagged with which game it means.
          const sameIdentity = rowsInGroup.every(r => r.displayName === rowsInGroup[0].displayName);
          if (sameIdentity && rowsInGroup.length === 2 && (pick.doubleheader_game === 1 || pick.doubleheader_game === 2)) {
            const sorted = [...rowsInGroup].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
            rowsInGroup = [sorted[pick.doubleheader_game - 1]];
          } else {
            return { grade: null, note: `"${pick.prop_player}" matched more than one ${spec.group} box score row on this date -- needs manual review.` };
          }
        }
        const row = rowsInGroup[0];
        if (spec.derive === 'outs') value = deriveOuts(row.keys, row.stats);
        else if (spec.derive === 'attempted') {
          const idx = row.keys.indexOf(spec.key);
          value = idx >= 0 ? espnStatToNumberAttempted(row.stats[idx]) : null;
        }
        else if (statNorm === 'hrrbi') {
          const hrIdx = row.keys.indexOf('homeRuns'), rbiIdx = row.keys.indexOf('RBIs');
          const hr = hrIdx >= 0 ? espnStatToNumber(row.stats[hrIdx]) : null;
          const rbi = rbiIdx >= 0 ? espnStatToNumber(row.stats[rbiIdx]) : null;
          value = (hr !== null && rbi !== null) ? hr + rbi : null;
        } else if (statNorm === 'hrhits') {
          const hrIdx = row.keys.indexOf('homeRuns'), hitsIdx = row.keys.indexOf('hits');
          const hr = hrIdx >= 0 ? espnStatToNumber(row.stats[hrIdx]) : null;
          const hits = hitsIdx >= 0 ? espnStatToNumber(row.stats[hitsIdx]) : null;
          value = (hr !== null && hits !== null) ? hr + hits : null;
        } else if (statNorm === 'hr2hits') {
          const hrIdx = row.keys.indexOf('homeRuns'), hitsIdx = row.keys.indexOf('hits');
          const hr = hrIdx >= 0 ? espnStatToNumber(row.stats[hrIdx]) : null;
          const hits = hitsIdx >= 0 ? espnStatToNumber(row.stats[hitsIdx]) : null;
          value = (hr !== null && hits !== null) ? ((hr >= 1 && hits >= 2) ? 1 : 0) : null;
        } else if (statNorm === 'hitsrunsrbi') {
          const hitsIdx = row.keys.indexOf('hits'), runsIdx = row.keys.indexOf('runs'), rbiIdx = row.keys.indexOf('RBIs');
          const hits = hitsIdx >= 0 ? espnStatToNumber(row.stats[hitsIdx]) : null;
          const runsVal = runsIdx >= 0 ? espnStatToNumber(row.stats[runsIdx]) : null;
          const rbi = rbiIdx >= 0 ? espnStatToNumber(row.stats[rbiIdx]) : null;
          value = (hits !== null && runsVal !== null && rbi !== null) ? hits + runsVal + rbi : null;
        } else if (statNorm === 'pointsreboundsassists' || statNorm === 'pointsrebounds' || statNorm === 'pointsassists' || statNorm === 'reboundsassists'
          || statNorm === 'ptsrebassists' || statNorm === 'ptsreb' || statNorm === 'ptsassists' || statNorm === 'rebassists'
          || statNorm === 'ptsreboundsassists') {
          const pIdx = row.keys.indexOf('points'), rIdx = row.keys.indexOf('rebounds'), aIdx = row.keys.indexOf('assists');
          const p = pIdx >= 0 ? espnStatToNumber(row.stats[pIdx]) : null;
          const r = rIdx >= 0 ? espnStatToNumber(row.stats[rIdx]) : null;
          const a = aIdx >= 0 ? espnStatToNumber(row.stats[aIdx]) : null;
          if (statNorm === 'pointsreboundsassists' || statNorm === 'ptsrebassists' || statNorm === 'ptsreboundsassists') value = (p !== null && r !== null && a !== null) ? p + r + a : null;
          else if (statNorm === 'pointsrebounds' || statNorm === 'ptsreb') value = (p !== null && r !== null) ? p + r : null;
          else if (statNorm === 'pointsassists' || statNorm === 'ptsassists') value = (p !== null && a !== null) ? p + a : null;
          else value = (r !== null && a !== null) ? r + a : null;
        } else {
          const idx = row.keys.indexOf(spec.key);
          value = idx >= 0 ? espnStatToNumber(row.stats[idx]) : null;
        }
        if (value !== null) break;
      }

      if (value === null) {
        return { grade: null, note: `Found "${pick.prop_player}" but couldn't read a real value for "${pick.prop_stat}" from the box score -- needs manual review.` };
      }

      const line = Number(pick.line);
      const isOver = normalize(pick.selection) === 'over';
      const isUnder = normalize(pick.selection) === 'under';
      if (!isOver && !isUnder) {
        return { grade: null, note: `Selection "${pick.selection}" isn't a recognized Over/Under call -- needs manual review.` };
      }
      // allMatches[0] rather than the loop-scoped `row` above -- every
      // entry in allMatches represents the SAME confirmed player (that's
      // the whole point of the unique-match check above), so the first
      // one's displayName is a safe, simple way to get ESPN's own
      // canonical spelling back to the caller for known_players
      // registration, regardless of which spec/group actually supplied
      // the graded value.
      const matchedName = allMatches[0] ? allMatches[0].displayName : pick.prop_player;
      if (value === line) return { grade: 'push', note: null, matchedName };
      const won = isOver ? value > line : value < line;
      return { grade: won ? 'win' : 'loss', note: null, matchedName };
    }

    const overall = {
      date: targetDate,
      sports_processed: [] as any[],
      sports_skipped: [] as any[]
    };

    function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

    // ESPN wants YYYYMMDD, no dashes.
    const espnDate = targetDate.replace(/-/g, '');

    for (const ourSport of ourSports) {
      const sportNormName = normalize(ourSport.name);

      // ---- Tennis grading (Moneyline, Spread, Total) -- direct report
      // 2026-08-29: "Djokovic played on Jun 4" (a real, clear French Open
      // QF result) sat pending forever, because this whole function's
      // header explicitly documented Tennis as "not a team-vs-team sport
      // this function's logic could ever grade anyway" -- a genuine,
      // permanent gap, not a matching failure. Tennis has no flat
      // scoreboard endpoint the way every other sport here does (ESPN
      // splits it across separate ATP/WTA feeds, nested tournament ->
      // grouping -> match, with no single sport/league URL segment to add
      // to ESPN_SPORT_MAP), so it needs its own fetch and its own matching
      // entirely, same reasoning MMA already established for individual-
      // vs-individual sports. Started as Moneyline-only (ESPN's own per-
      // competitor `winner` boolean, no score math needed), then extended
      // same-day, direct follow-up ("will this only catch moneyline bets
      // or can it catch Spreads and over/under bets") once each
      // competitor's own linescores[] (one entry per set, .value = games
      // won that set) was CONFIRMED directly against the real Djokovic/
      // Zverev match -- summed, this gives a real total-games count for
      // Total grading and a real per-player games count for Spread, not a
      // guess. Scoped to SINGLES only across all three bet types, same
      // "don't guess on real-money grading" principle as everywhere else
      // in this project -- a doubles pick is explicitly flagged
      // unsupported rather than guessed at, since determining which
      // specific pairing a bare "A/B" text means and whether that maps
      // cleanly to one specific real doubles match is a materially harder
      // problem than singles, not yet built. Runs a single day's completed
      // matches only (targetDate, no widened window) -- by the time a pick
      // reaches grading, schedule-sync's own work is what's responsible
      // for event_date already being correct; this only needs to find
      // what ACTUALLY happened that day, not
      // resolve a date ambiguity.
      if (sportNormName === 'tennis') {
        try {
          await sleep(500);
          const TENNIS_TOURS = ['atp', 'wta'];
          type TennisMatchEntry = {
            matchId: string; matchup: string; completed: boolean; voided: boolean;
            playerNames: string[]; winnerByName: Map<string, boolean>; gamesByName: Map<string, number>;
          };
          const tennisMatches: TennisMatchEntry[] = [];
          const seenMatchIds = new Set<string>();
          const tourResults = await Promise.allSettled(
            TENNIS_TOURS.map(tour =>
              espnFetch(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${espnDate}`).then(r => r.ok ? r.json() : null)
            )
          );
          for (const result of tourResults) {
            if (result.status !== 'fulfilled' || !result.value) continue;
            for (const tournament of (result.value.events || [])) {
              for (const grouping of (tournament.groupings || [])) {
                for (const comp of (grouping.competitions || [])) {
                  const matchId = `${tournament.id}-${comp.id}`;
                  if (seenMatchIds.has(matchId)) continue;
                  seenMatchIds.add(matchId);
                  const completed = !!(comp.status && comp.status.type && comp.status.type.completed);
                  const statusName: string | null = (comp.status && comp.status.type && comp.status.type.name) || null;
                  const names: string[] = [];
                  const winnerByName = new Map<string, boolean>();
                  const gamesByName = new Map<string, number>();
                  for (const competitor of (comp.competitors || [])) {
                    // Singles only -- a doubles competitor's names live
                    // under competitor.roster.athletes[] instead of a
                    // single competitor.athlete, deliberately not handled
                    // here (see this branch's own top comment on scope).
                    if (competitor.athlete && competitor.athlete.displayName) {
                      const name = competitor.athlete.displayName;
                      names.push(name);
                      if (typeof competitor.winner === 'boolean') winnerByName.set(name, competitor.winner);
                      // CONFIRMED directly against a real match (Djokovic
                      // bt Zverev 4-6 6-3 6-2 6-4, 2025-06-04): each
                      // competitor's own linescores[] has one entry per SET
                      // PLAYED with a real .value = games THAT competitor
                      // won in that set (Djokovic's own linescores were
                      // exactly [4,6,6,6], matching the real final score
                      // digit for digit) -- summing them is a genuine total
                      // games count for Total(games)/Spread(games)
                      // grading, not a guess. Missing/non-numeric entries
                      // are skipped rather than treated as 0, so a data gap
                      // makes the sum null (never a silently-wrong number)
                      // rather than undercounting.
                      const setValues = Array.isArray(competitor.linescores) ? competitor.linescores : [];
                      let gamesSum = 0;
                      let sawBadEntry = false;
                      for (const set of setValues) {
                        if (set && typeof set.value === 'number' && Number.isFinite(set.value)) gamesSum += set.value;
                        else sawBadEntry = true;
                      }
                      if (!sawBadEntry) gamesByName.set(name, gamesSum);
                    }
                  }
                  if (names.length !== 2) continue; // not a real singles match (retirement w/o replacement, bad data, etc.)
                  tennisMatches.push({
                    matchId, matchup: names.join(' / '), completed,
                    voided: isVoidGameStatus(statusName), playerNames: names, winnerByName, gamesByName
                  });
                }
              }
            }
          }

          // Same safety pattern as schedule-sync-backfill's own tennis
          // matching: a bare surname is only a safe lookup key when it's
          // unique across everyone who actually played that day -- the
          // real Andreeva-sisters case (two different real players
          // sharing a surname) must stay ambiguous, never silently
          // resolved to whichever one registered first.
          const surnameToPlayers = new Map<string, Set<string>>();
          for (const m of tennisMatches) {
            for (const n of m.playerNames) {
              const words = n.trim().split(/\s+/);
              if (words.length > 1) {
                const surname = normalize(words[words.length - 1]);
                if (!surnameToPlayers.has(surname)) surnameToPlayers.set(surname, new Set());
                surnameToPlayers.get(surname)!.add(normalize(n));
              }
            }
          }
          const tennisPlayerLookup = new Map<string, TennisMatchEntry>();
          const tennisAmbiguousKeys = new Set<string>();
          const registerTennisKey = (key: string, match: TennisMatchEntry, ownName: string) => {
            const existing = tennisPlayerLookup.get(key);
            if (existing && existing.matchId !== match.matchId) { tennisAmbiguousKeys.add(key); return; }
            tennisPlayerLookup.set(key, match);
          };
          for (const m of tennisMatches) {
            for (const n of m.playerNames) {
              registerTennisKey(normalize(n), m, n);
              const words = n.trim().split(/\s+/);
              if (words.length > 1) {
                const surname = normalize(words[words.length - 1]);
                if ((surnameToPlayers.get(surname)?.size || 0) === 1) registerTennisKey(surname, m, n);
              }
            }
          }

          const tennisPicks = await db(
            `picks?select=id,selection,bet_type_id,bet_types!inner(name,is_futures)&sport_id=eq.${ourSport.id}&event_date=eq.${targetDate}&result=eq.pending&bet_types.is_futures=eq.false`
          );
          const tennisSportResult = {
            sport: ourSport.name, matches_found: tennisMatches.length,
            graded: [] as any[], ambiguous: [] as any[], not_final_yet: [] as any[], unsupported_bet_type: [] as any[]
          };
          // Resolves free-typed selection text to a real match, for
          // Moneyline/Spread (single player name, e.g. "Djokovic") AND
          // Total (a "PlayerA/PlayerB" identifying pair, since a Total
          // isn't "about" either side, just needs to name the match) --
          // returns the match plus, when resolved via one specific name,
          // that name (needed for Moneyline/Spread's own-side math).
          // Ambiguous/not-found cases return a human-readable reason
          // instead of throwing, so the caller always has something to
          // write to grading_note.
          function resolveTennisSelection(selectionText: string): { match: TennisMatchEntry | null; ownName: string | null; reason: string | null } {
            if (!selectionText.includes('/')) {
              const key = normalize(selectionText);
              if (tennisAmbiguousKeys.has(key)) {
                return { match: null, ownName: null, reason: `"${selectionText}" matches more than one real player's match today -- needs manual review to confirm which match this pick actually means.` };
              }
              const match = tennisPlayerLookup.get(key);
              if (!match) {
                return { match: null, ownName: null, reason: `Could not find "${selectionText}" on today's ATP/WTA schedule -- may be a name spelling issue, a Challenger/lower-tier event this data source doesn't cover, or the wrong event_date.` };
              }
              const ownName = match.playerNames.find(n => normalize(n) === key || normalize(n.trim().split(/\s+/).pop() || '') === key) || null;
              return { match, ownName, reason: null };
            }
            // Two-name form: only trusted as "these are the two real
            // opponents in one singles match" when BOTH names resolve to
            // the exact SAME match -- otherwise this is either a genuine
            // doubles pairing (two partners, not opponents) or two
            // unrelated players, and guessing which is worse than asking
            // for manual review.
            const [nameA, nameB] = selectionText.split('/').map(s => s.trim());
            const keyA = normalize(nameA), keyB = normalize(nameB);
            if (tennisAmbiguousKeys.has(keyA) || tennisAmbiguousKeys.has(keyB)) {
              return { match: null, ownName: null, reason: `"${selectionText}" -- one of these names matches more than one real match today, needs manual review.` };
            }
            const matchA = tennisPlayerLookup.get(keyA);
            const matchB = tennisPlayerLookup.get(keyB);
            if (matchA && matchB && matchA.matchId === matchB.matchId) {
              return { match: matchA, ownName: null, reason: null };
            }
            return { match: null, ownName: null, reason: `"${selectionText}" doesn't resolve to two opponents in the same real singles match today -- may be a doubles pairing (not yet supported for grading) or two unrelated players.` };
          }

          for (const pick of (tennisPicks || [])) {
            const betTypeName = pick.bet_types ? pick.bet_types.name : '';
            const betTypeNorm = normalize(betTypeName);
            if (betTypeNorm === 'parlay') continue;
            const isMoneyline = betTypeNorm === 'moneyline';
            const isSpread = betTypeNorm === 'spread';
            const isTotalType = betTypeNorm === 'total' || betTypeNorm.startsWith('overunder');
            if (!isMoneyline && !isSpread && !isTotalType) {
              const note = `Bet type "${betTypeName}" is not supported for Tennis grading yet -- needs manual grading.`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'unsupported', grading_note: note }) });
              tennisSportResult.unsupported_bet_type.push({ id: pick.id, selection: pick.selection, bet_type: betTypeName, reason: note });
              continue;
            }
            if ((isMoneyline || isSpread) && pick.selection.includes('/')) {
              const note = `"${pick.selection}" -- can't tell which side this ${betTypeName} pick actually backs from a two-name selection alone (or this is a doubles pairing, not yet supported). Needs manual grading.`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'unsupported', grading_note: note }) });
              tennisSportResult.unsupported_bet_type.push({ id: pick.id, selection: pick.selection, bet_type: betTypeName, reason: note });
              continue;
            }
            const resolved = resolveTennisSelection(pick.selection);
            if (!resolved.match) {
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'ambiguous', grading_note: resolved.reason }) });
              tennisSportResult.ambiguous.push({ id: pick.id, selection: pick.selection, reason: resolved.reason });
              continue;
            }
            const match = resolved.match;
            if (!match.completed) {
              if (match.voided) {
                await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ result: 'push', grading_status: 'graded', grading_note: null }) });
                tennisSportResult.graded.push({ id: pick.id, selection: pick.selection, result: 'push', matchup: match.matchup });
                continue;
              }
              tennisSportResult.not_final_yet.push({ id: pick.id, selection: pick.selection, matchup: match.matchup, reason: `Matched to ${match.matchup}, but ESPN has not marked this match final yet -- not a name-matching issue, check back later.` });
              continue;
            }

            if (isTotalType) {
              const [nameA, nameB] = match.playerNames;
              const gamesA = match.gamesByName.get(nameA);
              const gamesB = match.gamesByName.get(nameB);
              if (typeof gamesA !== 'number' || typeof gamesB !== 'number' || pick.line === null || pick.line === undefined) {
                const note = `${match.matchup} finished, but a real total-games count or this pick's own line wasn't available -- needs manual grading.`;
                await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'ambiguous', grading_note: note }) });
                tennisSportResult.ambiguous.push({ id: pick.id, selection: pick.selection, reason: note });
                continue;
              }
              const combined = gamesA + gamesB;
              const line = Number(pick.line);
              const threshold = Math.abs(line);
              const isOver = line < 0; // project-wide convention: negative line = Over
              const grade = combined === threshold ? 'push' : (isOver ? (combined > threshold ? 'win' : 'loss') : (combined < threshold ? 'win' : 'loss'));
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ result: grade, grading_status: 'graded', grading_note: null }) });
              tennisSportResult.graded.push({ id: pick.id, selection: pick.selection, result: grade, matchup: match.matchup, total_games: combined });
              continue;
            }

            if (isSpread) {
              const ownName = resolved.ownName;
              const oppName = ownName ? match.playerNames.find(n => n !== ownName) : null;
              const ownGames = ownName ? match.gamesByName.get(ownName) : undefined;
              const oppGames = oppName ? match.gamesByName.get(oppName) : undefined;
              if (typeof ownGames !== 'number' || typeof oppGames !== 'number' || pick.line === null || pick.line === undefined) {
                const note = `${match.matchup} finished, but a real per-player games count or this pick's own line wasn't available -- needs manual grading.`;
                await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'ambiguous', grading_note: note }) });
                tennisSportResult.ambiguous.push({ id: pick.id, selection: pick.selection, reason: note });
                continue;
              }
              const grade = gradeSpreadPeriod(ownGames, oppGames, true, Number(pick.line));
              if (!grade) {
                const note = `${match.matchup} finished, but the games spread couldn't be confidently graded -- needs manual review.`;
                await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'ambiguous', grading_note: note }) });
                tennisSportResult.ambiguous.push({ id: pick.id, selection: pick.selection, reason: note });
                continue;
              }
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ result: grade, grading_status: 'graded', grading_note: null }) });
              tennisSportResult.graded.push({ id: pick.id, selection: pick.selection, result: grade, matchup: match.matchup, own_games: ownGames, opp_games: oppGames });
              continue;
            }

            // Moneyline
            const ownName = resolved.ownName;
            const won = ownName ? match.winnerByName.get(ownName) : undefined;
            if (typeof won !== 'boolean') {
              const note = `${match.matchup} finished with no clear winner recorded (retirement, walkover, or a data gap) -- needs manual grading.`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'ambiguous', grading_note: note }) });
              tennisSportResult.ambiguous.push({ id: pick.id, selection: pick.selection, reason: note });
              continue;
            }
            const grade = won ? 'win' : 'loss';
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ result: grade, grading_status: 'graded', grading_note: null }) });
            tennisSportResult.graded.push({ id: pick.id, selection: pick.selection, result: grade, matchup: match.matchup });
          }
          overall.sports_processed.push(tennisSportResult);
        } catch (tennisErr) {
          overall.sports_processed.push({ sport: ourSport.name, error: String(tennisErr) });
        }
        continue;
      }

      const espnPath = ESPN_SPORT_MAP[sportNormName];
      if (!espnPath) {
        overall.sports_skipped.push({ sport: ourSport.name, reason: 'No ESPN scoreboard mapping for this sport.' });
        continue;
      }

      try {
        // No published rate limit on this endpoint (it's unofficial), but
        // a modest pause between sports is just good citizenship.
        await sleep(500);
        const eventsRes = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${espnDate}`);
        if (!eventsRes.ok) {
          overall.sports_processed.push({ sport: ourSport.name, error: `ESPN request failed (${eventsRes.status})` });
          continue;
        }
        const eventsData = await eventsRes.json();
        const games = eventsData.events || [];
        // Per-sport, per-run cache -- Player Prop grading below fetches
        // each game's box score at most once no matter how many prop
        // picks reference players from it.
        const boxscoreCache: Record<string, any> = {};

        // CONFIRMED REAL BUG, direct report 2026-08-20: "Chicago Cubs" and
        // "Chicago White Sox" both play MLB the same day, and both share
        // location "Chicago" -- searching "Chicago Cubs" matched the Cubs'
        // own game via displayName AND the White Sox's game via the shared
        // "Chicago" location substring (since "chicagocubs".includes
        // ("chicago")), so BOTH came back as candidateGames, even though
        // the search text was completely unambiguous. Same root pattern
        // hit "New York Mets" vs "New York Yankees". This is the SAME
        // fix already shipped in schedule-sync-backfill.ts's own
        // bareNameIsUnique gate (never ported here) -- only trust a bare
        // location as a matchable variant when no OTHER team playing this
        // sport today shares that same city; a capper who really did
        // write just a bare city name on a two-team-city day still
        // correctly falls through to "possible games matched" for manual
        // review, since neither team's bare location gets trusted then.
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
            // CONFIRMED REAL BUG, direct report: "Philadelphia Phillies"
            // and "Los Angeles Dodgers" both matched the SAME wrong second
            // game (Dodgers @ Diamondbacks) on top of their real one.
            // Root cause: short abbreviations matched as loose substrings
            // just like the full name did -- "LAD" (Dodgers) is literally
            // embedded inside "phil-AD-elphia", and "SD" (Padres) is
            // embedded inside "los angele-SD-odgers". Same exact class of
            // bug already fixed once before in schedule-sync-backfill.ts
            // ("ARI inside Mariners"), just never carried over to this
            // separate file. Fixed the same way: only the full location
            // and full displayName (safely long, substring-matching is
            // fine) are checked loosely; shortDisplayName/name/abbreviation
            // (short enough to collide by coincidence) now require an
            // EXACT match only, never substring inclusion.
            const bareNameIsUnique = t.location && (bareNameCounts.get(normalize(t.location)) || 0) <= 1;
            const substringSafeNames = [bareNameIsUnique ? t.location : null, t.displayName].filter(Boolean).map(normalize);
            const exactOnlyNames = [t.shortDisplayName, t.name, t.abbreviation].filter(Boolean).map(normalize);
            // First linescore entry is the 1st inning/period -- only
            // trusted when it's a real number; a missing/null entry means
            // "don't know," never guessed as 0.
            const firstPeriod = (c.linescores && c.linescores[0] && c.linescores[0].displayValue !== undefined
              && c.linescores[0].displayValue !== null && c.linescores[0].displayValue !== '')
              ? Number(c.linescores[0].displayValue) : null;
            // Same defensive pattern extended through innings 5 and 7, for
            // Moneyline/Total First 5/First 7 grading below.
            const first5 = sumFirstNInnings(c.linescores, 5);
            const first7 = sumFirstNInnings(c.linescores, 7);
            // NBA 1st Half -- periods 1+2 summed, same reasoning/helper as
            // first5/first7 above. Meaningless for MLB (a baseball game has
            // no "half"), but harmless to compute either way since nothing
            // reads it unless the pick's own bet type asks for it.
            const first2 = sumFirstNInnings(c.linescores, 2);
            return {
              is_home: c.homeAway === 'home', substringSafeNames, exactOnlyNames,
              score: c.score !== undefined ? Number(c.score) : null,
              firstPeriod, first5, first7, first2
            };
          }

          const homeV = variantsFor(home);
          const awayV = variantsFor(away);
          const completed = !!(e.status && e.status.type && e.status.type.completed);
          // Raw ESPN status name (e.g. STATUS_POSTPONED, STATUS_CANCELED),
          // kept separate from the synthesized STATUS_FINAL/NOT_FINAL
          // event_status below -- that synthesized value only ever
          // distinguishes done-vs-not-done, which collapses "genuinely
          // in progress" and "postponed, will never finish on this date"
          // into the same bucket. See isVoidGameStatus's own comment.
          const rawStatusName: string | null = (e.status && e.status.type && e.status.type.name) || null;
          const matchup = (home && away) ? `${away.team.displayName} @ ${home.team.displayName}` : 'unknown matchup';

          // Reshaped to match grade_picks's own score object exactly
          // (score_home/score_away/winner_home/winner_away/event_status)
          // so the same gradeMoneyline/gradeSpread/gradeTotal functions
          // above work completely unchanged. winner_home/winner_away are
          // derived directly from the raw scores rather than trusting
          // ESPN's own per-competitor "winner" flag, so a tie or missing
          // flag falls through to null (ambiguous) the same safe way an
          // incomplete TheRundown score already does. first_inning_home/
          // away added for No Run/Yes Run First Inning grading.
          const score = (homeV && awayV && homeV.score !== null && awayV.score !== null) ? {
            score_home: homeV.score, score_away: awayV.score,
            winner_home: homeV.score > awayV.score ? 1 : 0,
            winner_away: awayV.score > homeV.score ? 1 : 0,
            event_status: completed ? 'STATUS_FINAL' : 'NOT_FINAL',
            first_inning_home: homeV.firstPeriod, first_inning_away: awayV.firstPeriod,
            first5_home: homeV.first5, first5_away: awayV.first5,
            first7_home: homeV.first7, first7_away: awayV.first7,
            first_half_home: homeV.first2, first_half_away: awayV.first2
          } : null;

          return {
            event_id: e.id,
            variants: [homeV, awayV].filter(Boolean),
            matchup,
            score,
            statusName: rawStatusName
          };
        });

        function findMatchingGames(teamStr: string) {
          const norm = normalize(teamStr);
          const matches: { game: typeof gameEntries[0]; isHome: boolean }[] = [];
          for (const game of gameEntries) {
            for (const variant of game.variants) {
              const substringMatch = variant.substringSafeNames.some((n: string) => n === norm || n.includes(norm) || norm.includes(n));
              const exactMatch = variant.exactOnlyNames.some((n: string) => n === norm);
              if (substringMatch || exactMatch) {
                matches.push({ game, isHome: variant.is_home });
                break;
              }
            }
          }
          return matches;
        }

        // ---- MMA (UFC) fighter matching -- completely separate from the
        // team-vs-team machinery above. A bout has two athletes, not a
        // home/away team pair, and ESPN's own per-competitor `winner`
        // boolean makes this simpler than every other sport here (no
        // score math needed at all) -- but it means fighters need their
        // own lookup keyed by NAME instead of reusing gameEntries/
        // findMatchingGames, which are built entirely around c.team.
        // Cappers write MMA picks as a bare surname (confirmed directly,
        // real examples: "Nolan", "Chaves", "Chairez") far more often
        // than a full name, so this registers BOTH the full display name
        // AND the surname (last whitespace-separated token) as lookup
        // keys -- each pointing at the same fighter entry. A genuine
        // surname collision between two DIFFERENT fighters on the same
        // card (rare, but real in a sport with many Brazilian/Portuguese
        // surnames) is detected and flagged as ambiguous rather than
        // silently resolved to whichever fighter registered first.
        const isMma = normalize(ourSport.name) === 'mma';
        type FighterEntry = { displayName: string; opponentName: string; matchup: string; completed: boolean; voided: boolean; winner: boolean | null; ambiguous?: boolean };
        const fighterLookup = new Map<string, FighterEntry>();
        const fighterDisplayNames: string[] = [];
        if (isMma) {
          const registerKey = (key: string, entry: FighterEntry) => {
            const existing = fighterLookup.get(key);
            if (existing && existing.displayName !== entry.displayName) {
              fighterLookup.set(key, { ...existing, ambiguous: true });
              return;
            }
            fighterLookup.set(key, entry);
          };
          for (const e of games) {
            // CONFIRMED REAL BUG, direct investigation 2026-08-22: ESPN's
            // UFC scoreboard nests EVERY bout on the card under ONE
            // top-level "event" (the whole fight night) as
            // e.competitions[] -- unlike every other sport here, where
            // each event IS one single game. Reading only
            // e.competitions[0] (the first bout listed) meant every other
            // fighter on a multi-bout card was never registered at all --
            // confirmed directly against a real card (UFC Fight Night:
            // Muhammad vs. Bonfim, 2026-06-06, 12 bouts): only the
            // first-listed bout (Ketlen Souza) graded, the other 11
            // bouts' fighters were silently invisible to this lookup and
            // stayed pending with no error or note.
            for (const comp of (e.competitions || [])) {
              const competitors = comp.competitors || [];
              if (competitors.length !== 2) continue; // safety: a real bout is exactly 2 fighters
              const completed = !!(comp.status && comp.status.type && comp.status.type.completed);
              // Same postponed/canceled push as the team-game grading
              // path above -- see isVoidGameStatus's own comment. A
              // pulled-out fighter/canceled bout is the MMA equivalent of
              // a rained-out baseball game.
              const compStatusName: string | null = (comp.status && comp.status.type && comp.status.type.name) || null;
              const [a, b] = competitors;
              const nameA = a.athlete && a.athlete.displayName;
              const nameB = b.athlete && b.athlete.displayName;
              if (!nameA || !nameB) continue;
              const matchup = `${nameA} vs ${nameB}`;
              const registerFighter = (name: string, opponent: string, winnerVal: any) => {
                const entry: FighterEntry = {
                  displayName: name, opponentName: opponent, matchup, completed,
                  voided: isVoidGameStatus(compStatusName),
                  winner: typeof winnerVal === 'boolean' ? winnerVal : null
                };
                registerKey(normalize(name), entry);
                const surname = name.trim().split(/\s+/).pop();
                if (surname && normalize(surname) !== normalize(name)) registerKey(normalize(surname), entry);
                fighterDisplayNames.push(name);
              };
              registerFighter(nameA, nameB, a.winner);
              registerFighter(nameB, nameA, b.winner);
            }
          }
        }

        // Direct report 2026-08-29: "I was not expecting it to try and
        // resolve the open ended future bets." A long-term futures pick
        // (Series/Award/Season Win Total) isn't tied to a single game on
        // a single date, so it can never be "supported" by this per-date
        // grader -- same is_futures exclusion already applied to schedule
        // sync (schedule-sync-note) and Missing Data's own checks. It's
        // handled separately by Grading Exceptions' blank-date sweep, not
        // by running it through a date-scoped grading pass at all.
        const picks = await db(
          `picks?select=id,selection,line,bet_type_id,prop_player,prop_stat,doubleheader_game,bet_types!inner(name,is_futures)&sport_id=eq.${ourSport.id}&event_date=eq.${targetDate}&result=eq.pending&bet_types.is_futures=eq.false`
        );

        const sportResult = {
          sport: ourSport.name, games_found: games.length,
          graded: [] as any[], ambiguous: [] as any[], not_final_yet: [] as any[], unsupported_bet_type: [] as any[]
        };

        for (const pick of picks) {
          const betTypeName = pick.bet_types ? pick.bet_types.name : '';
          const betTypeNorm = normalize(betTypeName);
          // Direct report 2026-08-22: "why is this coming up as a failure
          // I didn't do anything to this pick." A Parlay parent isn't a
          // single game with a score, so it can never be "supported" by
          // this per-pick grader -- it's ALREADY handled correctly by the
          // separate ?parlaysOnly=true rollup pass admin.html always runs
          // right after this one. Silently skipping here (not even
          // writing grading_status='unsupported') means it never shows up
          // as a failure at all -- previously it fell through to the
          // unsupported_bet_type bucket below on EVERY run, which is real
          // but permanently uninformative noise: it always fires (nothing
          // was ever wrong), and often self-resolves moments later within
          // the SAME click once the rollup pass catches up, so a person
          // opening the results would see a "failure" for something
          // that's already correctly graded by the time they look at it.
          if (betTypeNorm === 'parlay') continue;
          const hasSlash = pick.selection.includes('/');

          // Bet-type detection is now entirely name-based -- never
          // inferred from whether the selection happens to contain "/".
          // normalize() strips slashes/spaces, so "Over/Under" and its
          // period variants ("Over/Under 1st Half", etc.) all normalize
          // to something starting with "overunder".
          const isMoneyline = betTypeNorm === 'moneyline';
          const isSpread = betTypeNorm === 'spread';
          // CONFIRMED real gap, direct request: "anything we can build to
          // catch as much of these without having to stop to find results
          // is what we want." Team Total, Moneyline First5, and Over/Under
          // First5/First7 were all previously routed straight to
          // unsupported_bet_type even though the same final-score fetch
          // already has (or, for the First5/First7 ones, can easily
          // derive) everything needed to grade them.
          const isTeamTotal = betTypeNorm === 'teamtotal';
          // Direct report 2026-08-29: "Bet type 'Team Total First 5' is
          // not supported by this grader." Same idea as Team Total above,
          // just scoped to the first 5 innings the same way Total First 5
          // already is -- everything it needs (first5_home/away, the
          // single-team matching Team Total already uses) already exists,
          // it just never got its own flag wired up.
          const isTeamTotalFirst5 = betTypeNorm === 'teamtotalfirst5';
          const isMoneylineFirst5 = betTypeNorm === 'moneylinefirst5';
          const isTotalFirst5 = betTypeNorm === 'overunderfirst5';
          const isTotalFirst7 = betTypeNorm === 'overunderfirst7';
          // Full-game Total/Over-Under only -- explicitly EXCLUDES the
          // First5/First7 variants above. CONFIRMED this was a real latent
          // bug before this fix: normalize() strips spaces, so "Over/Under
          // First 5" also starts with "overunder" and was silently falling
          // into this same full-game bucket, getting graded with the FULL
          // GAME combined score instead of just the first 5 innings --
          // same class of wrong-silent-grade risk already caught and fixed
          // once for No Run First Inning.
          const isTotalType = (betTypeNorm === 'total' || betTypeNorm.startsWith('overunder'))
            && !isTotalFirst5 && !isTotalFirst7;
          const isNRFI = betTypeNorm === 'norunfirstinning';
          const isYRFI = betTypeNorm === 'yesrunfirstinning';
          // Direct request 2026-08-20: "if it's a question of it can be
          // resolved the answer should always be yes." MLB Moneyline 1st
          // Inning reuses first_inning_home/away, already fetched for
          // NRFI/YRFI above. NBA Spread 1st Quarter reuses the SAME field
          // (same array shape, different sport -- see gradeMoneylinePeriod/
          // gradeSpreadPeriod's own comment). Spread/Moneyline 1st Half
          // (NBA) use the new first_half_home/away above.
          const isMoneyline1stInning = betTypeNorm === 'moneyline1stinning';
          const isSpread1stQuarter = betTypeNorm === 'spread1stquarter';
          const isSpread1stHalf = betTypeNorm === 'spread1sthalf';
          const isMoneyline1stHalf = betTypeNorm === 'moneyline1sthalf';
          // ADDED 2026-08-23, direct request: "anything we can do to get
          // this done automatically." Reuses the exact same
          // first_inning_home/away field as Spread 1st Quarter (see that
          // flag's own comment -- "period 1" already means 1st quarter for
          // NBA/WNBA), just graded as a straight win/loss via
          // gradeMoneylinePeriod instead of gradeSpreadPeriod's line math.
          const isMoneyline1stQuarter = betTypeNorm === 'moneyline1stquarter';
          // Direct request 2026-08-17: "that's extra work to have to run 2
          // buttons and wait for results as well as it's possible someone
          // forgets or the button itself breaks and no one notices" --
          // folded directly in here rather than a separate tool/button,
          // scoped to MLB + WNBA first (real daily volume right now).
          const isPlayerProp = betTypeNorm === 'playerprop';
          const sportNormForProps = normalize(ourSport.name);
          const propsSupportedForThisSport = PLAYER_PROP_SPORTS.includes(sportNormForProps);
          const supported = isMoneyline || isSpread || isTotalType || isNRFI || isYRFI
            || isTeamTotal || isTeamTotalFirst5 || isMoneylineFirst5 || isTotalFirst5 || isTotalFirst7
            || isMoneyline1stInning || isSpread1stQuarter || isSpread1stHalf || isMoneyline1stHalf
            || isMoneyline1stQuarter
            || (isPlayerProp && propsSupportedForThisSport);

          if (!supported) {
            // CONFIRMED REAL GAP, direct report 2026-08-22: "the vast
            // majority of the others seem to be parlays... nothing to
            // explain why." Parlay picks land here EVERY run (a parlay
            // isn't itself a single game with a score, so it can never be
            // "supported" by this per-pick grader) -- that's expected, not
            // a failure. This note was already computed and already
            // written to grading_note in the DB, it just never made it
            // into the returned JSON for admin.html's summary to show --
            // reason: note fixes that without changing any grading logic.
            const note = `Bet type "${betTypeName}" is not supported by this grader -- needs manual grading.`;
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'unsupported', grading_note: note }) });
            sportResult.unsupported_bet_type.push({ id: pick.id, selection: pick.selection, bet_type: betTypeName, reason: note });
            continue;
          }

          if (isPlayerProp) {
            const propLabel = `${pick.prop_player || '?'} ${pick.prop_stat || '?'}`;
            const result = await gradePlayerProp(pick, sportNormForProps as 'mlb' | 'wnba' | 'nba', espnPath, games, boxscoreCache);
            if (result.notFinal) {
              sportResult.not_final_yet.push({ id: pick.id, selection: propLabel, reason: result.note });
              continue;
            }
            if (result.unsupported) {
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'unsupported', grading_note: result.note }) });
              sportResult.unsupported_bet_type.push({ id: pick.id, selection: propLabel, bet_type: `Player Prop (${pick.prop_stat})`, reason: result.note });
              continue;
            }
            if (!result.grade) {
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'ambiguous', grading_note: result.note }) });
              sportResult.ambiguous.push({ id: pick.id, selection: propLabel, reason: result.note });
              continue;
            }
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ result: result.grade, grading_status: 'graded', grading_note: null }) });
            sportResult.graded.push({ id: pick.id, selection: propLabel, result: result.grade });
            await registerKnownPlayer(ourSport.id, result.matchedName || pick.prop_player);
            continue;
          }

          if (isMma && isMoneyline) {
            const key = normalize(pick.selection);
            const entry = fighterLookup.get(key);
            if (!entry) {
              const cardList = fighterDisplayNames.length ? ` Today's card: ${fighterDisplayNames.join(', ')}.` : '';
              const note = `Could not find "${pick.selection}" on today's UFC card -- may be a name spelling issue, or this event isn't the one this pick means.${cardList}`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'ambiguous', grading_note: note }) });
              sportResult.ambiguous.push({ id: pick.id, selection: pick.selection, reason: note });
              continue;
            }
            if (entry.ambiguous) {
              const note = `"${pick.selection}" matches more than one fighter's surname on today's card -- needs manual review to confirm which bout this pick actually means.`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'ambiguous', grading_note: note }) });
              sportResult.ambiguous.push({ id: pick.id, selection: pick.selection, reason: note });
              continue;
            }
            if (!entry.completed) {
              if (entry.voided) {
                await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ result: 'push', grading_status: 'graded', grading_note: null }) });
                sportResult.graded.push({ id: pick.id, selection: pick.selection, result: 'push', matchup: entry.matchup });
                continue;
              }
              sportResult.not_final_yet.push({ id: pick.id, selection: pick.selection, matchup: entry.matchup, reason: `Matched to ${entry.matchup}, but ESPN has not marked this fight final yet -- not a name-matching issue, check back later.` });
              continue;
            }
            if (entry.winner === null) {
              const note = `${entry.matchup} finished with no clear winner recorded (draw, no contest, or a data gap) -- needs manual grading.`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'ambiguous', grading_note: note }) });
              sportResult.ambiguous.push({ id: pick.id, selection: pick.selection, reason: note });
              continue;
            }
            const grade = entry.winner ? 'win' : 'loss';
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ result: grade, grading_status: 'graded', grading_note: null }) });
            sportResult.graded.push({ id: pick.id, selection: pick.selection, result: grade });
            // Both fighters in this bout are now confirmed real (this
            // exact fight just resolved on ESPN's own card) -- register
            // the opponent too, not just whichever side this one pick
            // happened to name, so a resolved bout seeds both names at once.
            await registerKnownPlayer(ourSport.id, entry.displayName);
            await registerKnownPlayer(ourSport.id, entry.opponentName);
            continue;
          }

          let candidateGames: typeof gameEntries;
          let matchedIsHome: boolean | null = null;

          // Game-level bet types (Total/Over-Under family incl. First5/
          // First7, NRFI, YRFI) use combined team matching when both teams
          // were named ("/"), same as before -- but this branch is now
          // chosen by bet type, not by the presence of "/" alone. A
          // single-team selection on one of these (Team 2 was optional,
          // per v260) still resolves fine via the same single-team path
          // Moneyline/Spread already use. Team Total and Moneyline First5
          // are single-team bet types (per admin.html's uses_matchup_fields
          // list) and always fall through to the single-team path below.
          if (hasSlash && (isTotalType || isNRFI || isYRFI || isTotalFirst5 || isTotalFirst7)) {
            const [teamA, teamB] = pick.selection.split('/').map((s: string) => s.trim());
            const matchesA = findMatchingGames(teamA);
            const matchesB = findMatchingGames(teamB);
            candidateGames = matchesA.filter(a => matchesB.some(b => b.game.event_id === a.game.event_id)).map(a => a.game);
          } else {
            const matches = findMatchingGames(pick.selection);
            candidateGames = matches.map(m => m.game);
            if (matches.length === 1) matchedIsHome = matches[0].isHome;
          }

          // Direct request 2026-08-28: "we need to catch this upstream... I
          // need a way to identify it in uploads." admin.html's entry
          // template/Bulk Import/Add Pick form now capture doubleheader_game
          // (1 or 2) at data-entry time. When exactly 2 real games matched
          // the same matchup on the same date (a genuine doubleheader, not a
          // data error) and the pick is tagged, sort by start time and grade
          // against whichever one the tag names instead of flagging
          // ambiguous. Requires EXACTLY 2 candidates -- 3+ still needs a
          // human look, same reasoning as the "2 possible games" mystery
          // handled just below.
          if (candidateGames.length === 2 && (pick.doubleheader_game === 1 || pick.doubleheader_game === 2)) {
            const sorted = [...candidateGames].sort(
              (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
            );
            candidateGames = [sorted[pick.doubleheader_game - 1]];
          }

          if (candidateGames.length !== 1) {
            // CONFIRMED real, reproducible mystery -- direct report: "2
            // possible games matched" for Philadelphia Phillies and Los
            // Angeles Dodgers persisted across 2 separate runs, but a
            // direct check of ESPN's own real scoreboard for this date
            // shows only ONE game for each team -- no way to reproduce
            // from outside. Rather than guess further, the note itself now
            // lists exactly which event_ids/matchups it actually matched,
            // so the next occurrence is self-diagnosing instead of just a
            // bare count -- specifically distinguishes "the same real game
            // matched twice" (a dedup bug in candidateGames) from
            // "genuinely two different games matched" (a real substring
            // collision in findMatchingGames).
            const note = candidateGames.length === 0
              ? `No matching ${ourSport.name} game found for "${pick.selection}" on ${targetDate}.`
              : `${candidateGames.length} possible games matched "${pick.selection}" -- needs manual review. Matched: ${candidateGames.map(g => `[${g.event_id}] ${g.matchup}`).join(' | ')}`;
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'ambiguous', grading_note: note }) });
            sportResult.ambiguous.push({ id: pick.id, selection: pick.selection, reason: note });
            continue;
          }

          const game = candidateGames[0];
          if (!game.score || game.score.event_status !== 'STATUS_FINAL') {
            // Direct report 2026-08-22 (real case: New York Yankees @
            // Boston Red Sox, 2026-06-06, confirmed postponed via ESPN's
            // own scoreboard): a postponed/canceled game will never
            // become final on this event_date, so "check back later"
            // (the ordinary not-final message below) is actively wrong
            // here -- push it now, standard no-action sportsbook
            // convention, instead of leaving it stuck pending forever or
            // requiring someone to dig into ESPN by hand to notice.
            // Applies uniformly here (before the bet-type-specific grade
            // branches below) since a void game voids every bet type on
            // it, not just Moneyline.
            if (isVoidGameStatus(game.statusName)) {
              const voidNote = `ESPN marked this game ${game.statusName === 'STATUS_POSTPONED' ? 'postponed' : 'canceled'} (${game.matchup}) -- graded push, no action, since it never completed on ${targetDate}.`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ result: 'push', grading_status: 'graded', grading_note: null }) });
              sportResult.graded.push({ id: pick.id, selection: pick.selection, result: 'push', matchup: game.matchup, note: voidNote });
              continue;
            }
            // CONFIRMED REAL GAP, direct report 2026-08-22: "did it have an
            // issue with the team name?" -- this branch only runs AFTER a
            // real, unique game match already succeeded (candidateGames.length
            // === 1, checked just above); it is never a name/matching
            // problem, it means ESPN itself just isn't reporting this
            // specific game's status as final yet. Spelling that out
            // directly in the reason, instead of leaving it unexplained,
            // is exactly the distinction a person can't otherwise tell
            // apart from a real matching failure.
            sportResult.not_final_yet.push({ id: pick.id, selection: pick.selection, matchup: game.matchup, reason: `Matched to ${game.matchup}, but ESPN has not marked this game final yet -- not a name-matching issue, check back later or verify directly on ESPN.` });
            continue;
          }

          let grade: 'win' | 'loss' | 'push' | null = null;
          if (isMoneyline) grade = gradeMoneyline(game.score, matchedIsHome!);
          else if (isSpread) grade = gradeSpread(game.score, matchedIsHome!, Number(pick.line));
          else if (isTotalType) grade = gradeTotal(game.score, Number(pick.line));
          else if (isNRFI) grade = gradeNoRunFirstInning(game.score);
          else if (isYRFI) grade = gradeYesRunFirstInning(game.score);
          else if (isTeamTotal) {
            const ownScore = matchedIsHome ? game.score.score_home : game.score.score_away;
            grade = gradeTeamTotal(ownScore, Number(pick.line));
          }
          else if (isTeamTotalFirst5) {
            const ownVal = matchedIsHome ? game.score.first5_home : game.score.first5_away;
            grade = ownVal !== null ? gradeTeamTotal(ownVal, Number(pick.line)) : null;
          }
          else if (isMoneylineFirst5) grade = gradeMoneylineFirstN(game.score, matchedIsHome!, 5);
          else if (isTotalFirst5) grade = gradeTotalFirstN(game.score, 5, Number(pick.line));
          else if (isTotalFirst7) grade = gradeTotalFirstN(game.score, 7, Number(pick.line));
          else if (isMoneyline1stInning || isSpread1stQuarter || isMoneyline1stQuarter) {
            // Same field for all three -- see gradeMoneylinePeriod/gradeSpreadPeriod's
            // own comment: first_inning_home/away holds "period 1" of
            // whatever this sport's linescores represent (1 inning for MLB,
            // 1 quarter for NBA/WNBA).
            grade = isSpread1stQuarter
              ? gradeSpreadPeriod(game.score.first_inning_home, game.score.first_inning_away, matchedIsHome!, Number(pick.line))
              : gradeMoneylinePeriod(game.score.first_inning_home, game.score.first_inning_away, matchedIsHome!);
          }
          else if (isSpread1stHalf) grade = gradeSpreadPeriod(game.score.first_half_home, game.score.first_half_away, matchedIsHome!, Number(pick.line));
          else if (isMoneyline1stHalf) grade = gradeMoneylinePeriod(game.score.first_half_home, game.score.first_half_away, matchedIsHome!);

          if (!grade) {
            const note = (isNRFI || isYRFI)
              ? '1st-inning score data looked incomplete or unclear -- needs manual review.'
              : (isMoneylineFirst5 || isTotalFirst5 || isTotalFirst7 || isTeamTotalFirst5)
              ? 'First 5/7 innings score data looked incomplete or unclear -- needs manual review.'
              : (isMoneyline1stInning || isSpread1stQuarter || isMoneyline1stQuarter)
              ? '1st period score data looked incomplete or unclear -- needs manual review.'
              : (isSpread1stHalf || isMoneyline1stHalf)
              ? '1st half score data looked incomplete or unclear -- needs manual review.'
              : 'Final score data looked incomplete or unclear -- needs manual review.';
            await db(`picks?id=eq.${pick.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ grading_status: 'ambiguous', grading_note: note })
            });
            sportResult.ambiguous.push({ id: pick.id, selection: pick.selection, reason: note });
            continue;
          }

          await db(`picks?id=eq.${pick.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ result: grade, grading_status: 'graded', grading_note: null })
          });
          sportResult.graded.push({ id: pick.id, selection: pick.selection, result: grade, matchup: game.matchup });
        }

        overall.sports_processed.push(sportResult);
      } catch (sportErr) {
        overall.sports_processed.push({ sport: ourSport.name, error: String(sportErr) });
      }
    }

    // Parlay rollup is handled by a dedicated ?parlaysOnly=true call (see
    // above) instead of running here on every per-sport call.

    return new Response(JSON.stringify(overall, null, 2), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
