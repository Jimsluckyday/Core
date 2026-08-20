// grade_picks (all sports, single day)
// Fetches TheRundown's final scores for EVERY sport you have set up, for
// one date, and grades any pending pick it can confidently match AND that's
// fully final. Games not finished yet are simply left alone (not an error,
// just not ready). Player Props and period-specific bet types (e.g.
// "First 5") are deliberately NOT graded here -- they need different data
// than a final score alone provides. Sports TheRundown doesn't cover (e.g.
// KBO, CBA) are safely skipped, not treated as errors.
//
// After every sport is graded, a separate pass rolls up parlay results from
// their linked legs (via the parlay_legs join table) -- a parlay is never
// checked against a score directly, its own bet_type_id is "Parlay". A leg
// row (is_parlay_leg = true) is otherwise just a normal pick as far as this
// function is concerned, and gets graded by the exact same logic above as
// long as its own bet_type is Moneyline/Spread/Total -- a period-scoped or
// Player Prop leg still won't grade here, same limitation as any other pick
// of that bet type, which means a parlay containing one can't fully roll up
// until that leg is resolved some other way.
//
// Call with: POST /grade_picks?date=2026-06-04

// Required so the browser's CORS preflight (an automatic OPTIONS request)
// and every actual response both tell the browser it's OK for
// core-beteasy.vercel.app (or any origin) to read the result. Without this,
// the browser blocks the response entirely before your own JS ever sees
// it, regardless of whether the function itself ran successfully.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

Deno.serve(async (req) => {
  // The browser sends a CORS preflight OPTIONS request before the real
  // POST -- it must get a quick, successful response with the CORS headers
  // on it, or the real request never even gets sent.
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

    const url = new URL(req.url);
    const targetDate = url.searchParams.get('date');
    const sportFilter = url.searchParams.get('sport'); // optional -- if given, only this one sport runs
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

    // Every sport YOU have set up -- not hardcoded to any one of them.
    // Narrowed to just one sport if ?sport= was given, which is also a
    // practical way to retry just the sport that failed on rate limits
    // without re-running (and re-risking) all the others.
    let ourSports = await db(`sports?select=id,name`);
    if (sportFilter) ourSports = (ourSports || []).filter((s: any) => normalize(s.name) === normalize(sportFilter));
    if (!ourSports || !ourSports.length) {
      return new Response(JSON.stringify({ error: sportFilter ? `No sport named "${sportFilter}" found.` : 'No sports found in your sports table at all.' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const sportsRes = await fetch(`https://therundown.io/api/v2/sports?key=${rundownKey}`);
    if (!sportsRes.ok) {
      return new Response(JSON.stringify({ error: 'Could not reach TheRundown /sports list', status: sportsRes.status }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const rundownSportsData = await sportsRes.json();
    const rundownSportsList = rundownSportsData.sports || [];

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

    const overall = {
      date: targetDate,
      sports_processed: [] as any[],
      sports_skipped: [] as any[] // TheRundown doesn't cover these, e.g. KBO/CBA
    };

    // Small helper: sleep for a given number of milliseconds.
    function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

    for (const ourSport of ourSports) {
      const rundownSport = rundownSportsList.find((s: any) => normalize(s.sport_name) === normalize(ourSport.name));
      if (!rundownSport) {
        overall.sports_skipped.push({ sport: ourSport.name, reason: 'Not covered by TheRundown.' });
        continue;
      }

      try {
        // Pacing + retry for TheRundown's rate limit (429). Kept modest
        // deliberately -- this function is meant to be called once per
        // sport now (the client loops through sports itself, the same
        // way Sync Schedule & Odds already does), so this only ever needs
        // to survive ONE sport's worth of retries within Supabase's
        // 150-second hard execution ceiling, not all 18 sports' worth
        // stacked into a single call. If TheRundown sends a Retry-After
        // header, that exact value is honored instead of guessing.
        // Bumped from 300ms to 1100ms -- the free plan's rate limit is a
        // flat 1 request/second, and back-to-back sports were landing
        // under a second apart with the shorter pause, which is exactly
        // what tripped a real 429 on NHL during a live run.
        // No market_ids requested -- this function only ever reads
        // g.score for grading, never any odds/markets data at all, so
        // asking for market data (even narrowed to one market) was pure
        // waste, and the free TheRundown plan doesn't include markets
        // access at all -- that combination was producing a flat 403 on
        // every single sport, confirmed directly from real request logs.
        // Score data comes back on every event regardless of whether any
        // markets are requested, so dropping this entirely costs nothing.
        await sleep(1100);
        const t0 = Date.now();
        console.log(`[GRADE TIMING] ${ourSport.name} -- starting TheRundown fetch at t=0ms`);
        let eventsRes = await fetch(`https://therundown.io/api/v2/sports/${rundownSport.sport_id}/events/${targetDate}?key=${rundownKey}&offset=300`);
        let attempt = 0;
        while (eventsRes.status === 429 && attempt < 2) {
          attempt++;
          console.log(`[GRADE TIMING] ${ourSport.name} -- got 429, retry ${attempt} at t=${Date.now() - t0}ms`);
          const retryAfterHeader = eventsRes.headers.get('Retry-After');
          const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
          const waitMs = retryAfterMs && !isNaN(retryAfterMs) ? retryAfterMs : 2000 * attempt;
          await sleep(waitMs);
          eventsRes = await fetch(`https://therundown.io/api/v2/sports/${rundownSport.sport_id}/events/${targetDate}?key=${rundownKey}&offset=300`);
        }
        console.log(`[GRADE TIMING] ${ourSport.name} -- TheRundown fetch done at t=${Date.now() - t0}ms, status=${eventsRes.status}`);
        if (!eventsRes.ok) {
          overall.sports_processed.push({ sport: ourSport.name, error: `TheRundown request failed (${eventsRes.status})` });
          continue;
        }
        const eventsData = await eventsRes.json();
        const games = eventsData.events || [];
        console.log(`[GRADE TIMING] ${ourSport.name} -- parsed ${games.length} games at t=${Date.now() - t0}ms, raw payload size=${JSON.stringify(eventsData).length} chars`);

        const gameEntries = games.map((g: any) => {
          const teams = g.teams_normalized || g.teams || [];
          const variants = teams.map((t: any) => ({
            team_id: t.team_id, is_home: !!t.is_home,
            names: [t.name, t.mascot, t.name && t.mascot ? `${t.name} ${t.mascot}` : null].filter(Boolean).map(normalize)
          }));
          const away = teams.find((t: any) => !t.is_home);
          const home = teams.find((t: any) => t.is_home);
          const matchup = away && home ? `${away.name} ${away.mascot} @ ${home.name} ${home.mascot}` : 'unknown matchup';
          return { event_id: g.event_id, variants, matchup, score: g.score || null };
        });

        function findMatchingGames(teamStr: string) {
          const norm = normalize(teamStr);
          const matches: { game: typeof gameEntries[0]; isHome: boolean }[] = [];
          for (const game of gameEntries) {
            for (const variant of game.variants) {
              if (variant.names.some((n: string) => n === norm || n.includes(norm) || norm.includes(n))) {
                matches.push({ game, isHome: variant.is_home });
                break;
              }
            }
          }
          return matches;
        }

        const picks = await db(
          `picks?select=id,selection,line,bet_type_id,bet_types(name)&sport_id=eq.${ourSport.id}&event_date=eq.${targetDate}&result=eq.pending`
        );
        console.log(`[GRADE TIMING] ${ourSport.name} -- fetched ${picks.length} pending picks at t=${Date.now() - t0}ms`);

        const sportResult = {
          sport: ourSport.name, games_found: games.length,
          graded: [] as any[], ambiguous: [] as any[], not_final_yet: [] as any[], unsupported_bet_type: [] as any[]
        };

        let pickIndex = 0;
        for (const pick of picks) {
          pickIndex++;
          const pickStart = Date.now();
          if (pickIndex === 1 || pickIndex % 5 === 0) {
            console.log(`[GRADE TIMING] ${ourSport.name} -- starting pick ${pickIndex} of ${picks.length} at t=${Date.now() - t0}ms`);
          }
          const betTypeName = pick.bet_types ? pick.bet_types.name : '';
          const betTypeNorm = normalize(betTypeName);
          const isTotal = pick.selection.includes('/');
          const isMoneyline = !isTotal && betTypeNorm === 'moneyline';
          const isSpread = !isTotal && betTypeNorm === 'spread';

          if (!isTotal && !isMoneyline && !isSpread) {
            sportResult.unsupported_bet_type.push({ id: pick.id, selection: pick.selection, bet_type: betTypeName });
            continue;
          }

          let candidateGames: typeof gameEntries;
          let matchedIsHome: boolean | null = null;

          if (isTotal) {
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
            const note = candidateGames.length === 0
              ? `No matching ${ourSport.name} game found for "${pick.selection}" on ${targetDate}.`
              : `${candidateGames.length} possible games matched "${pick.selection}" -- needs manual review.`;
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ grading_status: 'ambiguous', grading_note: note }) });
            sportResult.ambiguous.push({ id: pick.id, selection: pick.selection, reason: note });
            continue;
          }

          const game = candidateGames[0];
          if (!game.score || game.score.event_status !== 'STATUS_FINAL') {
            sportResult.not_final_yet.push({ id: pick.id, selection: pick.selection, matchup: game.matchup });
            continue;
          }

          let grade: 'win' | 'loss' | 'push' | null = null;
          if (isMoneyline) grade = gradeMoneyline(game.score, matchedIsHome!);
          else if (isSpread) grade = gradeSpread(game.score, matchedIsHome!, Number(pick.line));
          else if (isTotal) grade = gradeTotal(game.score, Number(pick.line));

          if (!grade) {
            await db(`picks?id=eq.${pick.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ grading_status: 'ambiguous', grading_note: 'Final score data looked incomplete or unclear -- needs manual review.' })
            });
            sportResult.ambiguous.push({ id: pick.id, selection: pick.selection, reason: 'Incomplete score data' });
            continue;
          }

          await db(`picks?id=eq.${pick.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ result: grade, grading_status: 'graded', grading_note: null })
          });
          sportResult.graded.push({ id: pick.id, selection: pick.selection, result: grade, matchup: game.matchup });
        }
        console.log(`[GRADE TIMING] ${ourSport.name} -- finished all ${picks.length} picks at t=${Date.now() - t0}ms`);

        overall.sports_processed.push(sportResult);
      } catch (sportErr) {
        overall.sports_processed.push({ sport: ourSport.name, error: String(sportErr) });
      }
    }

    // ---- Parlay auto-grading rollup ----
    // A parlay's own row is never checked against a score directly -- its
    // result is entirely determined by its linked legs via parlay_legs.
    // Run as one final pass AFTER every sport above has been graded, so as
    // many of a parlay's legs as possible already have a real result by
    // now, regardless of which sport(s) the legs themselves belong to (a
    // parlay's own sport_id reflects only its most prominent leg, not
    // necessarily every leg's sport).
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
            if (!legIds.length) continue; // no legs linked yet -- nothing to roll up

            const legs = await db(`picks?select=id,result,grading_status&id=in.(${legIds.join(',')})`);
            const anyLoss = legs.some((l: any) => l.result === 'loss');
            const anyAmbiguous = legs.some((l: any) => l.grading_status === 'ambiguous');
            const allDecided = legs.every((l: any) => l.result === 'win' || l.result === 'loss' || l.result === 'push');
            const allWinOrPush = legs.every((l: any) => l.result === 'win' || l.result === 'push');
            const anyWin = legs.some((l: any) => l.result === 'win');

            if (anyLoss) {
              // Dead the moment any leg loses -- doesn't matter if other
              // legs are still pending.
              await db(`picks?id=eq.${parlay.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ result: 'loss', grading_status: 'graded', grading_note: null })
              });
              parlayRollup.graded.push({ id: parlay.id, selection: parlay.selection, result: 'loss' });
            } else if (allDecided && allWinOrPush) {
              // Every leg is win or push and none are still undetermined.
              // A push leg never causes a loss. All-push with zero real
              // wins is graded as a push here too, rather than guessing a
              // win with nothing that actually won.
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
            parlayRollup.errors.push({ id: parlay.id, selection: parlay.selection, error: String(legErr) });
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
