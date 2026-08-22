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
// anything else (Golf, Tennis, MMA, Cricket, KBO, CBA, Euro Basketball,
// Soccer, etc.) is safely skipped, same "not covered" pattern as
// grade_picks already uses for TheRundown-uncovered sports -- either
// because ESPN has no matching generic scoreboard endpoint, or because
// it's not a team-vs-team sport this function's Moneyline/Spread/Total
// logic could ever grade anyway.
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
    type StatSpec = { key: string; group: 'batting' | 'pitching'; derive?: 'outs' };
    const MLB_STAT_SPECS: Record<string, StatSpec[]> = {
      hits: [{ key: 'hits', group: 'batting' }],
      homeruns: [{ key: 'homeRuns', group: 'batting' }],
      hr: [{ key: 'homeRuns', group: 'batting' }],
      rbi: [{ key: 'RBIs', group: 'batting' }],
      rbis: [{ key: 'RBIs', group: 'batting' }],
      hrrbi: [{ key: '', group: 'batting' }],
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

    async function gradePlayerProp(
      pick: any, sportNorm: 'mlb' | 'wnba' | 'nba', espnPath: string, games: any[], boxCache: Record<string, any>
    ): Promise<{ grade: 'win' | 'loss' | 'push' | null; note: string | null; notFinal?: boolean; unsupported?: boolean }> {
      const statNorm = normalize(pick.prop_stat || '');
      // Confirmed real finding (direct report): Total Bases can't be
      // computed from this box score at all -- see the long comment above
      // deriveOuts for the full story. Called out explicitly here with its
      // own reason rather than falling into the generic "not supported"
      // message below, since this one's worth explaining, not just noting.
      if (statNorm === 'totalbases' && sportNorm === 'mlb') {
        return { grade: null, unsupported: true, note: "Total Bases can't be computed from ESPN's box score data -- it doesn't break out doubles/triples, and the only rate stats available here (AVG/OBP/SLG) are season totals, not this game's -- needs manual grading." };
      }
      const STAT_SPECS_BY_SPORT: Record<'mlb' | 'wnba' | 'nba', Record<string, StatSpec[]>> = {
        mlb: MLB_STAT_SPECS, wnba: WNBA_STAT_SPECS, nba: NBA_STAT_SPECS
      };
      const specs = STAT_SPECS_BY_SPORT[sportNorm][statNorm];
      if (!specs) return { grade: null, unsupported: true, note: `Stat "${pick.prop_stat}" is not supported by this grader yet -- needs manual grading.` };

      const playerNorm = normalize(pick.prop_player || '');
      if (!playerNorm) return { grade: null, note: 'No player name recorded on this pick -- needs manual grading.' };

      // Check every one of the day's games for this sport -- same "check
      // everywhere, only accept a UNIQUE match" discipline as team
      // matching, since a same-day name collision across two different
      // games (rare, but real) must never be silently guessed.
      let foundInAnyGame = false;
      let foundInNotFinalGame = false;
      const allMatches: { stats: string[]; keys: string[]; group: 'batting' | 'pitching' }[] = [];
      for (const g of games) {
        const completed = !!(g.status && g.status.type && g.status.type.completed);
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
                if (!completed) { foundInNotFinalGame = true; return; }
                allMatches.push({
                  stats: a.stats, keys: sg.keys,
                  group: (sportNorm === 'mlb' && sgIdx === 1) ? 'pitching' : 'batting'
                });
              }
            });
          });
        });
      }

      if (!foundInAnyGame) {
        return { grade: null, note: `No player named "${pick.prop_player}" found in any ${sportNorm.toUpperCase()} box score on this date -- check spelling, or needs manual grading.` };
      }
      if (allMatches.length === 0 && foundInNotFinalGame) {
        return { grade: null, note: 'Matched to a game today, but ESPN has not marked it final yet -- check back later.', notFinal: true };
      }

      let value: number | null = null;
      for (const spec of specs) {
        const rowsInGroup = allMatches.filter(m => m.group === spec.group);
        if (!rowsInGroup.length) continue;
        if (rowsInGroup.length > 1) {
          return { grade: null, note: `"${pick.prop_player}" matched more than one ${spec.group} box score row on this date -- needs manual review.` };
        }
        const row = rowsInGroup[0];
        if (spec.derive === 'outs') value = deriveOuts(row.keys, row.stats);
        else if (statNorm === 'hrrbi') {
          const hrIdx = row.keys.indexOf('homeRuns'), rbiIdx = row.keys.indexOf('RBIs');
          const hr = hrIdx >= 0 ? espnStatToNumber(row.stats[hrIdx]) : null;
          const rbi = rbiIdx >= 0 ? espnStatToNumber(row.stats[rbiIdx]) : null;
          value = (hr !== null && rbi !== null) ? hr + rbi : null;
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
      if (value === line) return { grade: 'push', note: null };
      const won = isOver ? value > line : value < line;
      return { grade: won ? 'win' : 'loss', note: null };
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
      const espnPath = ESPN_SPORT_MAP[normalize(ourSport.name)];
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
            score
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

        const picks = await db(
          `picks?select=id,selection,line,bet_type_id,prop_player,prop_stat,bet_types(name)&sport_id=eq.${ourSport.id}&event_date=eq.${targetDate}&result=eq.pending`
        );

        const sportResult = {
          sport: ourSport.name, games_found: games.length,
          graded: [] as any[], ambiguous: [] as any[], not_final_yet: [] as any[], unsupported_bet_type: [] as any[]
        };

        for (const pick of picks) {
          const betTypeName = pick.bet_types ? pick.bet_types.name : '';
          const betTypeNorm = normalize(betTypeName);
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
          // Direct request 2026-08-17: "that's extra work to have to run 2
          // buttons and wait for results as well as it's possible someone
          // forgets or the button itself breaks and no one notices" --
          // folded directly in here rather than a separate tool/button,
          // scoped to MLB + WNBA first (real daily volume right now).
          const isPlayerProp = betTypeNorm === 'playerprop';
          const sportNormForProps = normalize(ourSport.name);
          const propsSupportedForThisSport = PLAYER_PROP_SPORTS.includes(sportNormForProps);
          const supported = isMoneyline || isSpread || isTotalType || isNRFI || isYRFI
            || isTeamTotal || isMoneylineFirst5 || isTotalFirst5 || isTotalFirst7
            || isMoneyline1stInning || isSpread1stQuarter || isSpread1stHalf || isMoneyline1stHalf
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
          else if (isMoneylineFirst5) grade = gradeMoneylineFirstN(game.score, matchedIsHome!, 5);
          else if (isTotalFirst5) grade = gradeTotalFirstN(game.score, 5, Number(pick.line));
          else if (isTotalFirst7) grade = gradeTotalFirstN(game.score, 7, Number(pick.line));
          else if (isMoneyline1stInning || isSpread1stQuarter) {
            // Same field for both -- see gradeMoneylinePeriod/gradeSpreadPeriod's
            // own comment: first_inning_home/away holds "period 1" of
            // whatever this sport's linescores represent (1 inning for MLB,
            // 1 quarter for NBA).
            grade = isMoneyline1stInning
              ? gradeMoneylinePeriod(game.score.first_inning_home, game.score.first_inning_away, matchedIsHome!)
              : gradeSpreadPeriod(game.score.first_inning_home, game.score.first_inning_away, matchedIsHome!, Number(pick.line));
          }
          else if (isSpread1stHalf) grade = gradeSpreadPeriod(game.score.first_half_home, game.score.first_half_away, matchedIsHome!, Number(pick.line));
          else if (isMoneyline1stHalf) grade = gradeMoneylinePeriod(game.score.first_half_home, game.score.first_half_away, matchedIsHome!);

          if (!grade) {
            const note = (isNRFI || isYRFI)
              ? '1st-inning score data looked incomplete or unclear -- needs manual review.'
              : (isMoneylineFirst5 || isTotalFirst5 || isTotalFirst7)
              ? 'First 5/7 innings score data looked incomplete or unclear -- needs manual review.'
              : (isMoneyline1stInning || isSpread1stQuarter)
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

    // ---- Parlay auto-grading rollup (identical to grade_picks) ----
    const parlayRollup = {
      graded: [] as any[], still_pending: [] as any[], errors: [] as any[]
    };
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

            const legs = await db(`picks?select=id,result,grading_status&id=in.(${legIds.join(',')})`);
            const anyLoss = legs.some((l: any) => l.result === 'loss');
            const anyAmbiguous = legs.some((l: any) => l.grading_status === 'ambiguous');
            const allDecided = legs.every((l: any) => l.result === 'win' || l.result === 'loss' || l.result === 'push');
            const allWinOrPush = legs.every((l: any) => l.result === 'win' || l.result === 'push');
            const anyWin = legs.some((l: any) => l.result === 'win');

            if (anyLoss) {
              await db(`picks?id=eq.${parlay.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ result: 'loss', grading_status: 'graded', grading_note: null })
              });
              parlayRollup.graded.push({ id: parlay.id, selection: parlay.selection, result: 'loss' });
            } else if (allDecided && allWinOrPush) {
              const grade = anyWin ? 'win' : 'push';
              await db(`picks?id=eq.${parlay.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ result: grade, grading_status: 'graded', grading_note: null })
              });
              parlayRollup.graded.push({ id: parlay.id, selection: parlay.selection, result: grade });
            } else if (anyAmbiguous) {
              await db(`picks?id=eq.${parlay.id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  grading_status: 'ambiguous',
                  grading_note: 'At least one linked leg could not be confidently graded -- resolve that leg first.'
                })
              });
              parlayRollup.still_pending.push({ id: parlay.id, selection: parlay.selection, reason: 'a leg is ambiguous' });
            } else {
              parlayRollup.still_pending.push({ id: parlay.id, selection: parlay.selection, reason: 'one or more legs not final yet' });
            }
          } catch (legErr) {
            parlayRollup.errors.push({ id: parlay.id, selection: parlay.selection, reason: String(legErr) });
          }
        }
      }
    } catch (rollupErr) {
      parlayRollup.errors.push({ error: String(rollupErr) });
    }
    (overall as any).parlay_rollup = parlayRollup;

    return new Response(JSON.stringify(overall, null, 2), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
