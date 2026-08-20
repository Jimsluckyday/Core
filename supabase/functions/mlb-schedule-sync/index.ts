// schedule-sync (generalized, any sport, with closing odds for Moneyline/Spread/Totals)
// Displayed as "schedule-sync" in the Supabase dashboard, but its actual
// invokable URL/slug is "mlb-schedule-sync" (Supabase only lets you rename
// the display label, not the real URL) -- called by admin.html's
// "Sync Schedule & Odds" button (Old Tools) only. NOT the same function as
// schedule-sync-backfill (a separate file), and NOT used by "Find & Update
// Teams / Tournaments" (that uses validate-mlb-player-txt/
// validate-nba-player-txt/validate-wnba-player-txt/validate-nhl-player-txt
// instead for prop team lookups).
//
// Fetches TheRundown's schedule for a given sport + date, matches each game
// against your pending picks for that sport/date, and updates
// game_start_time, home_away (single-team picks), rundown_event_id, and
// closing_odds (from FanDuel, book id 23 -- Moneyline, Spread, and full-game
// Totals bet types).
// Doubleheaders/ambiguous matches get flagged with the actual matchups
// involved, not just a count, so it's obvious whether it's a real
// doubleheader or a matching issue. Sports TheRundown doesn't cover (e.g.
// KBO, CBA) fail SAFELY with a clear message.
//
// PLAYER PROPS: TheRundown's data is team-level only, so it can never match
// a prop pick to a game by itself. For MLB (via MLB's free, official Stats
// API) and NBA (via BALLDONTLIE, requires a BALLDONTLIE_API_KEY secret),
// this now separately builds a real player-name -> {team, game start time}
// lookup from each sport's own roster data, and uses it to fill in
// game_start_time and prop_team (only if prop_team is currently blank) for
// prop picks. Every other sport's props still fall back to being left
// completely untouched, exactly as before -- not a regression, just not yet
// extended to those sports.
//
// Call with: POST /schedule-sync?date=2026-07-17&sport=MLB

const FANDUEL_BOOK_ID = '23';

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
    const targetDate = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
    const sportParam = url.searchParams.get('sport');
    if (!sportParam) {
      return new Response(JSON.stringify({ error: 'Missing required "sport" query parameter, e.g. ?sport=MLB' }), {
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

    const ourSports = await db(`sports?select=id,name&name=ilike.${encodeURIComponent(sportParam)}`);
    if (!ourSports || !ourSports.length) {
      return new Response(JSON.stringify({ status: 'skipped', reason: `No sport named "${sportParam}" exists in your sports table.` }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const ourSportId = ourSports[0].id;

    const sportsRes = await fetch(`https://therundown.io/api/v2/sports?key=${rundownKey}`);
    if (!sportsRes.ok) {
      return new Response(JSON.stringify({ error: 'Could not reach TheRundown /sports list', status: sportsRes.status }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const sportsData = await sportsRes.json();
    const rundownSport = (sportsData.sports || []).find((s: any) => normalize(s.sport_name) === normalize(sportParam));
    if (!rundownSport) {
      return new Response(JSON.stringify({ status: 'skipped', reason: `TheRundown does not appear to cover "${sportParam}". No picks were touched.` }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const rundownSportId = rundownSport.sport_id;

    // offset=300 (5 hours) aligns the date boundary to US Central Time --
    // without it, games starting late at night can appear under the wrong
    // date and cause false "duplicate" matches.
    const eventsRes = await fetch(
      `https://therundown.io/api/v2/sports/${rundownSportId}/events/${targetDate}?key=${rundownKey}&market_ids=1,2,3&offset=300`
    );
    if (!eventsRes.ok) {
      return new Response(JSON.stringify({ error: 'TheRundown events request failed', status: eventsRes.status, body: await eventsRes.text() }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const eventsData = await eventsRes.json();
    const games = eventsData.events || [];

    // BUGFIX: previously, a team's bare city/market name (t.name, e.g.
    // "New York" or "Chicago") was always included as a matchable variant
    // on its own. That's fine until two different teams share a city --
    // confirmed directly from a real run, "New York Yankees" was matching
    // BOTH the Yankees game AND the unrelated Mets game, since both teams'
    // variant list included the bare "New York" string. Same thing hit
    // "Chicago Cubs" against the White Sox game. Fix: first count how many
    // times each normalized bare name appears across every team playing
    // this specific day, then only include it as a variant when it's
    // unique for that day -- ambiguous city names fall back to requiring
    // the mascot or full "City Mascot" match instead, which is always
    // still included regardless.
    const allTeamsToday: any[] = [];
    for (const g of games) {
      const teams = g.teams_normalized || g.teams || [];
      for (const t of teams) allTeamsToday.push(t);
    }
    const bareNameCounts = new Map<string, number>();
    for (const t of allTeamsToday) {
      if (!t.name) continue;
      const n = normalize(t.name);
      bareNameCounts.set(n, (bareNameCounts.get(n) || 0) + 1);
    }

    // matchup is carried purely for diagnostics -- so an ambiguous-match
    // note can show WHICH games matched, not just how many.
    const gameEntries = games.map((g: any) => {
      const teams = g.teams_normalized || g.teams || [];
      const variants = teams.map((t: any) => {
        const bareNameIsUnique = t.name && (bareNameCounts.get(normalize(t.name)) || 0) <= 1;
        return {
          team_id: t.team_id,
          is_home: !!t.is_home,
          names: [bareNameIsUnique ? t.name : null, t.mascot, t.name && t.mascot ? `${t.name} ${t.mascot}` : null]
            .filter(Boolean).map(normalize)
        };
      });
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
    function findTeamMarketOdds(game: typeof gameEntries[0], betTypeName: string, teamStr: string, pickLine: number | null) {
      const betTypeNorm = normalize(betTypeName);
      let marketId: number | null = null;
      if (betTypeNorm === 'moneyline') marketId = 1;
      else if (betTypeNorm === 'spread') marketId = 2;
      else return null;

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

    // Looks up FanDuel's closing price for a full-game Totals (Over/Under)
    // bet on a two-team selection. Totals markets are structured differently
    // from Moneyline/Spread: instead of one participant per team, there are
    // two sides -- "over" and "under" -- each carrying its own price for a
    // given total value. Our own convention stores this as a signed line on
    // the pick (negative = Over, positive = Under), so the actual market
    // total is always the absolute value of the pick's line.
    function findTotalsOdds(game: typeof gameEntries[0], betTypeName: string, pickLine: number | null) {
      const betTypeNorm = normalize(betTypeName);
      if (!betTypeNorm.includes('overunder') && !betTypeNorm.includes('over/under')) return null;
      if (betTypeNorm.includes('first5') || betTypeNorm.includes('first 5')) return null;
      if (pickLine === null || pickLine === undefined) return null;

      const market = game.markets.find((m: any) => m.market_id === 3 && (m.period_id === 0 || m.period_id === undefined));
      if (!market) return null;

      const isOverPick = Number(pickLine) < 0;
      const totalValue = Math.abs(Number(pickLine));
      const sideNorm = isOverPick ? 'over' : 'under';
      const participant = market.participants.find((p: any) => normalize(p.name) === sideNorm || normalize(p.name).includes(sideNorm));
      if (!participant) return null;

      const line = (participant.lines || []).find((l: any) => Number(l.value) === totalValue);
      if (!line) return null;
      if (!line.prices || !line.prices[FANDUEL_BOOK_ID]) return null;
      return line.prices[FANDUEL_BOOK_ID].price;
    }

    // ---------------------------------------------------------------
    // PLAYER PROP SUPPORT (MLB via MLB Stats API, NBA via BALLDONTLIE)
    // ---------------------------------------------------------------
    // TheRundown's schedule/odds data (fetched above) is TEAM-level only --
    // it has no player roster information, so it can never match a prop to
    // a game on its own. For MLB and NBA specifically, we now separately
    // pull real roster data from each sport's own API (the same ones
    // already proven in validate-mlb-player / validate-nba-player) and
    // build a normalized player-name -> {team, game start time} lookup
    // ONCE per run, before looping over picks. Every other sport still
    // has no prop support here and continues to skip props exactly as
    // before -- this isn't a regression, just not yet extended.
    const sportNorm = normalize(sportParam);
    const propLookup = new Map<string, { team: string; startTime: string }>();
    // Tracked and returned in the response so a failure is always visible
    // in the output rather than silently leaving props unmatched with no
    // explanation -- confirmed necessary after a real run showed zero
    // props of any kind (matched or unmatched) with no indication why.
    let propLookupStatus = 'not_applicable';

    if (sportNorm === 'mlb') {
      try {
        const mlbScheduleRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${targetDate}`);
        if (mlbScheduleRes.ok) {
          const mlbScheduleData = await mlbScheduleRes.json();
          const mlbGames = (mlbScheduleData.dates && mlbScheduleData.dates[0] && mlbScheduleData.dates[0].games) || [];

          // Build one flat list of every team playing today (both sides of
          // every game), then fetch ALL rosters in a single Promise.all --
          // previously this looped one game at a time (await inside a for
          // loop), which for a 15-game day meant ~30 sequential-ish
          // round trips to MLB's API and could hit the function execution
          // time limit partway through, failing silently.
          const teamGamePairs: { teamId: number; teamName: string; startTime: string }[] = [];
          for (const g of mlbGames) {
            const away = g.teams && g.teams.away && g.teams.away.team;
            const home = g.teams && g.teams.home && g.teams.home.team;
            const startTime = g.gameDate;
            if (!startTime) continue;
            if (away) teamGamePairs.push({ teamId: away.id, teamName: away.name, startTime });
            if (home) teamGamePairs.push({ teamId: home.id, teamName: home.name, startTime });
          }

          const rosterResults = await Promise.allSettled(
            teamGamePairs.map(t => fetch(`https://statsapi.mlb.com/api/v1/teams/${t.teamId}/roster?rosterType=active`).then(r => r.ok ? r.json() : null))
          );

          let rostersOk = 0, rostersFailed = 0;
          for (let i = 0; i < teamGamePairs.length; i++) {
            const result = rosterResults[i];
            const t = teamGamePairs[i];
            if (result.status !== 'fulfilled' || !result.value) { rostersFailed++; continue; }
            rostersOk++;
            const roster = result.value.roster || [];
            for (const r of roster) {
              const name = r.person && r.person.fullName;
              if (name) propLookup.set(normalize(name), { team: t.teamName, startTime: t.startTime });
            }
          }
          propLookupStatus = propLookup.size > 0 ? 'built' : 'built_but_empty';
          console.log(`[PROP SYNC] MLB prop lookup built with ${propLookup.size} players across ${mlbGames.length} games (rosters ok: ${rostersOk}, failed: ${rostersFailed})`);
        } else {
          propLookupStatus = `schedule_fetch_failed (status ${mlbScheduleRes.status})`;
        }
      } catch (e) {
        propLookupStatus = `build_threw_error: ${String(e)}`;
      }
    } else if (sportNorm === 'nba') {
      const ballDontLieKey = Deno.env.get('BALLDONTLIE_API_KEY');
      if (!ballDontLieKey) {
        propLookupStatus = 'missing_api_key';
      } else {
        try {
          const bdlHeaders = { Authorization: ballDontLieKey };
          const nbaGamesRes = await fetch(`https://api.balldontlie.io/nba/v1/games?dates[]=${targetDate}`, { headers: bdlHeaders });
          if (nbaGamesRes.ok) {
            const nbaGamesData = await nbaGamesRes.json();
            const nbaGames = nbaGamesData.data || [];
            // BALLDONTLIE's free-tier games response has historically been
            // inconsistent about whether it includes a precise tip-off time
            // vs. date-only. Falls back to date-only (midnight) if no time
            // component is present, which is still far better than nothing.
            const teamGamePairs: { teamId: number; teamName: string; startTime: string }[] = [];
            for (const g of nbaGames) {
              const startTime = g.datetime || g.date;
              const home = g.home_team;
              const away = g.visitor_team;
              if (!home || !away || !startTime) continue;
              teamGamePairs.push({ teamId: away.id, teamName: away.full_name || away.name, startTime });
              teamGamePairs.push({ teamId: home.id, teamName: home.full_name || home.name, startTime });
            }

            const playerResults = await Promise.allSettled(
              teamGamePairs.map(t => fetch(`https://api.balldontlie.io/nba/v1/players?team_ids[]=${t.teamId}&per_page=100`, { headers: bdlHeaders }).then(r => r.ok ? r.json() : null))
            );

            let playersOk = 0, playersFailed = 0;
            for (let i = 0; i < teamGamePairs.length; i++) {
              const result = playerResults[i];
              const t = teamGamePairs[i];
              if (result.status !== 'fulfilled' || !result.value) { playersFailed++; continue; }
              playersOk++;
              const players = result.value.data || [];
              for (const p of players) {
                const name = `${p.first_name} ${p.last_name}`.trim();
                if (name) propLookup.set(normalize(name), { team: t.teamName, startTime: t.startTime });
              }
            }
            propLookupStatus = propLookup.size > 0 ? 'built' : 'built_but_empty';
            console.log(`[PROP SYNC] NBA prop lookup built with ${propLookup.size} players across ${nbaGames.length} games (team player-fetches ok: ${playersOk}, failed: ${playersFailed})`);
          } else {
            propLookupStatus = `games_fetch_failed (status ${nbaGamesRes.status})`;
          }
        } catch (e) {
          propLookupStatus = `build_threw_error: ${String(e)}`;
        }
      }
    }

    const picks = await db(
      `picks?select=id,selection,line,prop_player,prop_team,bet_type_id,bet_types(name,uses_prop_fields)&sport_id=eq.${ourSportId}&event_date=eq.${targetDate}&result=eq.pending&or=(schedule_sync_status.is.null,schedule_sync_status.neq.matched)`
    );

    const results = {
      sport: sportParam, date: targetDate, games_found: games.length,
      prop_lookup_status: propLookupStatus, prop_lookup_players_found: propLookup.size,
      matched: [] as any[], unmatched: [] as any[]
    };

    for (const pick of picks) {
      const isProp = pick.bet_types && pick.bet_types.uses_prop_fields;

      if (isProp) {
        // MLB and NBA now have real roster-based matching via propLookup
        // (built above). Every other sport still has no way to determine
        // which game a named player is in from TheRundown's team-only
        // data, so it continues to skip entirely, exactly as before.
        //
        // NOTE: props do NOT get rundown_event_id -- this path resolves
        // through MLB Stats API / BALLDONTLIE, which have no TheRundown
        // event id to store. Team picks populate it; props stay null until
        // this path also resolves a Rundown game.
        if (propLookup.size && pick.prop_player) {
          const propMatch = propLookup.get(normalize(pick.prop_player));
          if (propMatch) {
            const updatePayload: Record<string, unknown> = {
              game_start_time: propMatch.startTime,
              schedule_sync_status: 'matched',
              schedule_sync_note: null
            };
            // Only fills prop_team if it's currently blank -- never
            // overwrites a value someone already set or confirmed by hand.
            if (!pick.prop_team) updatePayload.prop_team = propMatch.team;
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify(updatePayload) });
            results.matched.push({
              id: pick.id, selection: `${pick.prop_player} (prop)`, start_time: propMatch.startTime,
              prop_team: propMatch.team
            });
            continue;
          }
          // Player name didn't match any active roster in today's games --
          // mark unmatched (not silently skipped) so it surfaces in Start
          // Time Exceptions / Odds Exceptions rather than disappearing.
          const note = `"${pick.prop_player}" was not found on any MLB/NBA active roster playing on ${targetDate} -- may be a name spelling issue, or the player may not be active/on this team.`;
          await db(`picks?id=eq.${pick.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note })
          });
          results.unmatched.push({ id: pick.id, selection: pick.prop_player, reason: note });
          continue;
        }
        continue;
      }

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
          // TheRundown's own id for the matched game. Stored so picks can be
          // grouped by the GAME rather than by the selection string -- the
          // transcriber records teams exactly as the image writes them, so
          // "Yankees", "New York Yankees" and "NYY" can all be the same game.
          // Grouping on the string would treat them as three different teams
          // and break both capper-vs-team stats and cross-capper consensus.
          rundown_event_id: matchedGame.event_id,
          schedule_sync_status: 'matched',
          schedule_sync_note: null
        };
        if (matchedIsHome !== null) updatePayload.home_away = matchedIsHome ? 'home' : 'away';

        // Odds lookup runs for BOTH single-team picks (Moneyline/Spread)
        // AND two-team Totals picks -- previously, Totals picks were
        // skipped from odds lookup entirely, which was the single biggest
        // reason full-game Over/Under bets kept showing up as missing odds
        // despite the API call already including Totals data.
        const betTypeName = pick.bet_types ? pick.bet_types.name : '';
        let closingOdds: number | null = null;
        if (!isOverUnder) {
          closingOdds = findTeamMarketOdds(matchedGame, betTypeName, pick.selection, pick.line);
        } else {
          closingOdds = findTotalsOdds(matchedGame, betTypeName, pick.line);
        }
        if (closingOdds !== null) updatePayload.closing_odds = closingOdds;

        await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify(updatePayload) });
        results.matched.push({
          id: pick.id, selection: pick.selection, start_time: matchedGame.start_time,
          rundown_event_id: matchedGame.event_id,
          home_away: matchedIsHome !== null ? (matchedIsHome ? 'home' : 'away') : null,
          closing_odds: updatePayload.closing_odds ?? null
        });
      } else {
        // Includes the actual matchups involved now, so a "duplicate" flag
        // can be checked at a glance -- a real doubleheader shows the SAME
        // two teams twice; anything else means the matching logic itself
        // needs a look. Shows what was ACTUALLY searched for (the player
        // name for props, not the bare Under/Over), so it's unambiguous
        // from the message alone whether prop matching is really running.
        const searchedFor = isProp ? (pick.prop_player || '(no player name set)') : pick.selection;
        const note = candidateGames.length === 0
          ? `No matching ${sportParam} game found for "${searchedFor}" on ${targetDate}.`
          : `${candidateGames.length} possible games matched "${searchedFor}" on ${targetDate}: [${candidateGames.map(g => g.matchup).join(' | ')}] -- needs manual review.`;
        await db(`picks?id=eq.${pick.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note })
        });
        results.unmatched.push({ id: pick.id, selection: searchedFor, reason: note });
      }
    }

    return new Response(JSON.stringify(results, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
