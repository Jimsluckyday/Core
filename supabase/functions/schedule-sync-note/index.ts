// schedule-sync (generalized, any sport, with closing odds for Moneyline/Spread)
// Fetches TheRundown's schedule for a given sport + date, matches each game
// against your pending picks for that sport/date, and updates
// game_start_time, home_away (single-team picks), and closing_odds (from
// FanDuel, book id 23 -- Moneyline and Spread bet types only, for now).
// Doubleheaders/ambiguous matches get flagged with the actual matchups
// involved, not just a count, so it's obvious whether it's a real
// doubleheader or a matching issue. Sports TheRundown doesn't cover (e.g.
// KBO, CBA) fail SAFELY with a clear message.
//
// Call with: POST /schedule-sync?date=2026-07-17&sport=MLB

const FANDUEL_BOOK_ID = '23';

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

Deno.serve(async (req) => {
  try {
    const rundownKey = Deno.env.get('RUNDOWN_API_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!rundownKey || !supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'Missing required secret(s).' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(req.url);
    const targetDate = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
    const sportParam = url.searchParams.get('sport');
    if (!sportParam) {
      return new Response(JSON.stringify({ error: 'Missing required "sport" query parameter, e.g. ?sport=MLB' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
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

    const ourSports = await db(`sports?select=id,name&name=ilike.${encodeURIComponent(sportParam)}`);
    if (!ourSports || !ourSports.length) {
      return new Response(JSON.stringify({ status: 'skipped', reason: `No sport named "${sportParam}" exists in your sports table.` }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    const ourSportId = ourSports[0].id;

    const sportsRes = await fetch(`https://therundown.io/api/v2/sports?key=${rundownKey}`);
    if (!sportsRes.ok) {
      return new Response(JSON.stringify({ error: 'Could not reach TheRundown /sports list', status: sportsRes.status }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }
    const sportsData = await sportsRes.json();
    const rundownSport = (sportsData.sports || []).find((s: any) => normalize(s.sport_name) === normalize(sportParam));
    if (!rundownSport) {
      return new Response(JSON.stringify({ status: 'skipped', reason: `TheRundown does not appear to cover "${sportParam}". No picks were touched.` }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    const rundownSportId = rundownSport.sport_id;

    const eventsRes = await fetch(
      `https://therundown.io/api/v2/sports/${rundownSportId}/events/${targetDate}?key=${rundownKey}&market_ids=1,2,3`
    );
    if (!eventsRes.ok) {
      return new Response(JSON.stringify({ error: 'TheRundown events request failed', status: eventsRes.status, body: await eventsRes.text() }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }
    const eventsData = await eventsRes.json();
    const games = eventsData.events || [];

    // matchup is carried purely for diagnostics -- so an ambiguous-match
    // note can show WHICH games matched, not just how many.
    const gameEntries = games.map((g: any) => {
      const teams = g.teams_normalized || g.teams || [];
      const variants = teams.map((t: any) => ({
        team_id: t.team_id,
        is_home: !!t.is_home,
        names: [t.name, t.mascot, t.name && t.mascot ? `${t.name} ${t.mascot}` : null]
          .filter(Boolean).map(normalize)
      }));
      const away = teams.find((t: any) => !t.is_home);
      const home = teams.find((t: any) => t.is_home);
      const matchup = away && home ? `${away.name} ${away.mascot} @ ${home.name} ${home.mascot}` : 'unknown matchup';
      return { event_id: g.event_id, start_time: g.event_date, markets: g.markets || [], variants, matchup };
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

    // Looks up FanDuel's closing price for a Moneyline or Spread bet.
    // Returns null (not an error) for anything it can't confidently find --
    // odds filling is a bonus on top of start-time matching, never a reason
    // to fail the whole pick.
    function findClosingOdds(game: typeof gameEntries[0], betTypeName: string, teamStr: string, pickLine: number | null) {
      const betTypeNorm = normalize(betTypeName);
      let marketId: number | null = null;
      if (betTypeNorm === 'moneyline') marketId = 1;
      else if (betTypeNorm === 'spread') marketId = 2;
      else return null; // Totals, Player Prop, First5 variants, etc. -- not handled yet

      const market = game.markets.find((m: any) => m.market_id === marketId && (m.period_id === 0 || m.period_id === undefined));
      if (!market) return null;

      const teamNorm = normalize(teamStr);
      const participant = market.participants.find((p: any) => normalize(p.name).includes(teamNorm) || teamNorm.includes(normalize(p.name)));
      if (!participant) return null;

      let line;
      if (marketId === 1) {
        line = participant.lines && participant.lines[0];
      } else {
        if (pickLine === null) return null;
        line = (participant.lines || []).find((l: any) => Number(l.value) === Number(pickLine));
      }
      if (!line || !line.prices || !line.prices[FANDUEL_BOOK_ID]) return null;
      return line.prices[FANDUEL_BOOK_ID].price;
    }

    const picks = await db(
      `picks?select=id,selection,line,bet_type_id,bet_types(name)&sport_id=eq.${ourSportId}&event_date=eq.${targetDate}&result=eq.pending&or=(schedule_sync_status.is.null,schedule_sync_status.neq.matched)`
    );

    const results = {
      sport: sportParam, date: targetDate, games_found: games.length,
      matched: [] as any[], unmatched: [] as any[]
    };

    for (const pick of picks) {
      const isOverUnder = pick.selection.includes('/');
      let candidateGames: typeof gameEntries;
      let matchedIsHome: boolean | null = null;

      if (isOverUnder) {
        const [teamA, teamB] = pick.selection.split('/').map((s: string) => s.trim());
        const matchesA = findMatchingGames(teamA);
        const matchesB = findMatchingGames(teamB);
        candidateGames = matchesA
          .filter(a => matchesB.some(b => b.game.event_id === a.game.event_id))
          .map(a => a.game);
      } else {
        const matches = findMatchingGames(pick.selection);
        candidateGames = matches.map(m => m.game);
        if (matches.length === 1) matchedIsHome = matches[0].isHome;
      }

      if (candidateGames.length === 1) {
        const matchedGame = candidateGames[0];
        const updatePayload: Record<string, unknown> = {
          game_start_time: matchedGame.start_time,
          schedule_sync_status: 'matched',
          schedule_sync_note: null
        };
        if (matchedIsHome !== null) updatePayload.home_away = matchedIsHome ? 'home' : 'away';

        if (!isOverUnder) {
          const betTypeName = pick.bet_types ? pick.bet_types.name : '';
          const closingOdds = findClosingOdds(matchedGame, betTypeName, pick.selection, pick.line);
          if (closingOdds !== null) updatePayload.closing_odds = closingOdds;
        }

        await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify(updatePayload) });
        results.matched.push({
          id: pick.id, selection: pick.selection, start_time: matchedGame.start_time,
          home_away: matchedIsHome !== null ? (matchedIsHome ? 'home' : 'away') : null,
          closing_odds: updatePayload.closing_odds ?? null
        });
      } else {
        // Includes the actual matchups involved now, so a "duplicate" flag
        // can be checked at a glance -- a real doubleheader shows the SAME
        // two teams twice; anything else means the matching logic itself
        // needs a look.
        const note = candidateGames.length === 0
          ? `No matching ${sportParam} game found for "${pick.selection}" on ${targetDate}.`
          : `${candidateGames.length} possible games matched "${pick.selection}" on ${targetDate}: [${candidateGames.map(g => g.matchup).join(' | ')}] -- needs manual review.`;
        await db(`picks?id=eq.${pick.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note })
        });
        results.unmatched.push({ id: pick.id, selection: pick.selection, reason: note });
      }
    }

    return new Response(JSON.stringify(results, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
});
