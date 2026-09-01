// check-player-team-drift
// Direct request 2026-08-31: "I don't think we need to get full rosters
// from sports as I think that's too large an ask... My idea was as we
// enter a player name and it fails we update it. Once it passes both the
// player name check and team check we store it... Then we have a button
// that we can run to check that those players still play for those
// teams." grade_picks_espn_backfill/grade-golf-picks now capture a
// player's real, box-score-confirmed team into known_players.team_id
// whenever a Player Prop pick successfully grades (see that file's own
// registerKnownPlayer comment) -- deliberately NOT the whole league's
// roster, just the handful of players who've actually been picked. This
// function is the other half: for every player already on file WITH a
// team, re-check whether they're still on that team's CURRENT real
// roster, and report anyone who no longer shows up (a trade, release, or
// signing elsewhere) for manual review. Read-only -- never writes
// team_id back itself, since a roster API miss (IL stint, a data gap, a
// name-matching edge case) is not proof positive of a move, only a
// reason to look. MLB gets built out first and most thoroughly per
// direct request ("MLB will have the largest variance and the most
// need"), NBA/WNBA alongside it since the same underlying pattern covers
// both cheaply.
//
// MLB team-id resolution: statsapi.mlb.com/api/v1/teams?sportId=1 lists
// all 30 teams with real names and MLB's own numeric ids in one call --
// confirmed directly working, no scanning needed.
//
// NBA/WNBA team-id resolution: CONFIRMED, same reasoning already proven
// in schedule-sync-backfill and validate-nba/wnba-player-txt -- there is
// no reliable "list every team" endpoint in active use anywhere else in
// this project; every existing NBA/WNBA/NHL roster lookup instead derives
// team ids from a real day's SCOREBOARD (each game's home/away competitor
// carries ESPN's own team id + name). Scans the last SCAN_WINDOW_DAYS of
// scoreboards to collect as many real team ids as possible -- in-season,
// every team plays at least every 1-3 days, so this window should surface
// nearly every team; a team that hasn't played at all in that window
// (all-star break, very early/late season gaps) simply can't be checked
// this run and is reported as such, not guessed at.
//
// HONEST CAVEAT, not independently verified end-to-end this session:
// each individual piece here (MLB Stats API teams list, ESPN scoreboard
// scanning, ESPN .../teams/{id}/roster) is separately proven elsewhere in
// this project, but this exact combination is new. Run it once on a
// small known_players set first and read the actual report before
// trusting it at scale.
//
// Call with: GET /check-player-team-drift  (all 3 sports)
//        or: GET /check-player-team-drift?sport=MLB  (one sport only)

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

function initialSurname(fullName: string): string | null {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return normalize(parts[0][0] + parts[parts.length - 1]);
}

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

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

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

    const url = new URL(req.url);
    const sportFilter = url.searchParams.get('sport');

    let ourSports = await db('sports?select=id,name');
    if (sportFilter) ourSports = (ourSports || []).filter((s: any) => normalize(s.name) === normalize(sportFilter));
    const SUPPORTED = ['mlb', 'nba', 'wnba'];
    ourSports = (ourSports || []).filter((s: any) => SUPPORTED.includes(normalize(s.name)));
    if (!ourSports.length) {
      return new Response(JSON.stringify({ error: sportFilter ? `"${sportFilter}" isn't one of the sports this covers (MLB, NBA, WNBA).` : 'No matching sports found.' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const overall: any = { checked_at: new Date().toISOString(), sports: [] as any[] };

    for (const sport of ourSports) {
      const sportNorm = normalize(sport.name);
      const sportResult: any = {
        sport: sport.name, still_on_team: [] as any[], possibly_moved: [] as any[],
        teams_could_not_check: [] as any[], players_no_team_on_file: 0
      };

      // Only players who already have a confirmed team -- see this
      // file's own header for why the pool is small on purpose.
      const players = await db(`known_players?select=id,name,team_id&sport_id=eq.${sport.id}&team_id=not.is.null`);
      if (!players || !players.length) {
        sportResult.note = 'No players on file with a confirmed team for this sport yet.';
        overall.sports.push(sportResult);
        continue;
      }
      const teamIds = [...new Set(players.map((p: any) => p.team_id))];
      const ourTeams = await db(`teams?select=id,name&id=in.(${teamIds.join(',')})`);
      const ourTeamById = new Map<string, string>();
      (ourTeams || []).forEach((t: any) => ourTeamById.set(t.id, t.name));

      const playersByTeamId = new Map<string, any[]>();
      players.forEach((p: any) => {
        if (!playersByTeamId.has(p.team_id)) playersByTeamId.set(p.team_id, []);
        playersByTeamId.get(p.team_id)!.push(p);
      });

      // ---- Resolve each of OUR teams to that sport's real roster-API id ----
      const rosterIdByOurTeamId = new Map<string, string>();

      if (sportNorm === 'mlb') {
        try {
          const mlbTeamsRes = await espnFetch('https://statsapi.mlb.com/api/v1/teams?sportId=1');
          const mlbTeamsData = mlbTeamsRes.ok ? await mlbTeamsRes.json() : null;
          const mlbTeams: { id: number; name: string }[] = (mlbTeamsData && mlbTeamsData.teams) || [];
          for (const [ourTeamId, ourTeamName] of ourTeamById) {
            const norm = normalize(ourTeamName);
            const match = mlbTeams.find(t => normalize(t.name) === norm)
              || mlbTeams.filter(t => normalize(t.name).includes(norm) || norm.includes(normalize(t.name)));
            const resolved = Array.isArray(match) ? (match.length === 1 ? match[0] : null) : match;
            if (resolved) rosterIdByOurTeamId.set(ourTeamId, String(resolved.id));
          }
        } catch (e) {
          sportResult.mlb_team_list_error = String(e);
        }
      } else {
        // NBA / WNBA -- scan recent scoreboards for real team id+name
        // pairs, same proven technique as schedule-sync-backfill/
        // validate-nba-player-txt/validate-wnba-player-txt.
        const espnPath = sportNorm === 'wnba' ? 'basketball/wnba' : 'basketball/nba';
        const SCAN_WINDOW_DAYS = 10;
        const foundTeams = new Map<string, string>(); // espn id -> displayName
        for (let d = 0; d < SCAN_WINDOW_DAYS; d++) {
          const date = new Date();
          date.setUTCDate(date.getUTCDate() - d);
          const espnDate = date.toISOString().slice(0, 10).replace(/-/g, '');
          try {
            const res = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${espnDate}`);
            if (res.ok) {
              const data = await res.json();
              for (const g of (data.events || [])) {
                const competitors = (g.competitions && g.competitions[0] && g.competitions[0].competitors) || [];
                for (const c of competitors) {
                  if (c.team && c.team.id && !foundTeams.has(c.team.id)) {
                    foundTeams.set(c.team.id, c.team.displayName || c.team.name);
                  }
                }
              }
            }
          } catch { /* one bad date shouldn't abort the whole scan */ }
          await sleep(200);
        }
        for (const [ourTeamId, ourTeamName] of ourTeamById) {
          const norm = normalize(ourTeamName);
          for (const [espnId, espnName] of foundTeams) {
            if (normalize(espnName) === norm) { rosterIdByOurTeamId.set(ourTeamId, espnId); break; }
          }
        }
      }

      // ---- Fetch each resolvable team's CURRENT roster and check names ----
      for (const [ourTeamId, players2] of playersByTeamId) {
        const ourTeamName = ourTeamById.get(ourTeamId) || 'Unknown team';
        const rosterId = rosterIdByOurTeamId.get(ourTeamId);
        if (!rosterId) {
          sportResult.teams_could_not_check.push({
            team: ourTeamName,
            reason: sportNorm === 'mlb'
              ? 'Could not match this team against the MLB Stats API teams list.'
              : `Not found in the last 10 days of ${sport.name} scoreboards -- may not have played recently, or the name doesn't match closely enough.`
          });
          continue;
        }
        let rosterNames: string[] = [];
        try {
          if (sportNorm === 'mlb') {
            const res = await espnFetch(`https://statsapi.mlb.com/api/v1/teams/${rosterId}/roster`);
            if (res.ok) {
              const data = await res.json();
              rosterNames = (data.roster || []).map((r: any) => (r.person && r.person.fullName) || '').filter(Boolean);
            }
          } else {
            const espnPath = sportNorm === 'wnba' ? 'basketball/wnba' : 'basketball/nba';
            const res = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/teams/${rosterId}/roster`);
            if (res.ok) {
              const data = await res.json();
              rosterNames = (data.athletes || []).map((a: any) => a.fullName || a.displayName || '').filter(Boolean);
            }
          }
        } catch (e) {
          sportResult.teams_could_not_check.push({ team: ourTeamName, reason: `Roster fetch failed: ${String(e)}` });
          continue;
        }
        if (!rosterNames.length) {
          sportResult.teams_could_not_check.push({ team: ourTeamName, reason: 'Roster fetch returned no players -- treated as unable to check, not as everyone having left.' });
          continue;
        }
        const rosterNormSet = new Set<string>();
        rosterNames.forEach(n => {
          rosterNormSet.add(normalize(n));
          const alias = initialSurname(n);
          if (alias) rosterNormSet.add(alias);
        });
        await sleep(150);

        for (const p of players2) {
          const norm = normalize(p.name);
          const nameTokens = p.name.trim().split(/\s+/);
          const surnameNorm = nameTokens.length ? normalize(nameTokens[nameTokens.length - 1]) : '';
          const onRoster = rosterNormSet.has(norm) || (surnameNorm && rosterNormSet.has(surnameNorm));
          if (onRoster) {
            sportResult.still_on_team.push({ id: p.id, name: p.name, team: ourTeamName });
          } else {
            sportResult.possibly_moved.push({
              id: p.id, name: p.name, last_known_team: ourTeamName,
              reason: `Not found on ${ourTeamName}'s current roster -- may have been traded, released, signed elsewhere, or this is a name-matching gap. Verify before updating.`
            });
          }
        }
      }

      overall.sports.push(sportResult);
    }

    return new Response(JSON.stringify(overall, null, 2), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
