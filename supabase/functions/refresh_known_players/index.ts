// refresh_known_players
// Direct request 2026-09-06: "even something like Corbin Carroll where I
// put one L... transcription errors on manual entry are far too common."
// known_players (the table powering Add Pick's player-name autocomplete
// and its "did you mean" typo hint) only ever grows from a pick that's
// actually finished GRADING successfully (see grade_picks_espn_backfill's
// own registerKnownPlayer comment) -- a deliberate, previously-confirmed
// decision (see check-player-team-drift's own header: pulling full
// rosters was "too large an ask") to avoid ever wrongly flagging a
// genuinely new player as a typo. That leaves a real cold-start gap: a
// star player's FIRST pick in this system gets zero typo protection,
// since nothing has graded for them yet to seed the entry -- confirmed as
// the likely explanation for real Shai Gilgeous-Alexander/Corbin Carroll
// misspellings slipping through untouched.
//
// This revisits that "too large an ask" tradeoff now that the roster-
// fetching groundwork already exists (built fixing validate-mlb/nba/
// wnba-player-txt and schedule-sync-backfill the same day, plus check-
// player-team-drift's own team-id-resolution technique): pulls every
// CURRENT active roster across every sport this project has a working
// roster source for (MLB/NBA/WNBA/NHL), and upserts each player into
// known_players via the same merge-duplicates pattern registerKnownPlayer
// already uses -- so a full league's worth of real, currently-active
// names is available for autocomplete/typo-catching immediately, instead
// of only organically over time as picks happen to grade.
//
// Direct request: intended to run WEEKLY on a schedule once wired up
// (rosters don't meaningfully change hour to hour, so this doesn't need
// to be frequent) -- explicitly NOT scheduled anywhere yet as of this
// build, by direct request ("build them but not turn them on yet"). Call
// manually to test until a cron job is set up and turned on; see the
// bottom of this file's own repo history / chat for the exact pg_cron SQL
// to run whenever ready to actually turn it on.
//
// Team-id resolution mirrors check-player-team-drift exactly: MLB via
// statsapi.mlb.com's own teams list (proven direct, one call), NBA/WNBA/
// NHL via scanning recent scoreboards for real team id+name pairs (no
// reliable "list every team" endpoint proven working for those in this
// project).
//
// Call with: GET /refresh_known_players            (all 4 sports)
//        or: GET /refresh_known_players?sport=MLB   (one sport only)

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

function splitName(name: string): { first: string | null; last: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { first: null, last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
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

const SCAN_WINDOW_DAYS = 10;

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
    const SUPPORTED = ['mlb', 'nba', 'wnba', 'nhl'];
    ourSports = (ourSports || []).filter((s: any) => SUPPORTED.includes(normalize(s.name)));
    if (!ourSports.length) {
      return new Response(JSON.stringify({ error: sportFilter ? `"${sportFilter}" isn't one of the sports this covers (MLB, NBA, WNBA, NHL).` : 'No matching sports found.' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const overall: any = { refreshed_at: new Date().toISOString(), sports: [] as any[] };

    for (const sport of ourSports) {
      const sportNorm = normalize(sport.name);
      const sportResult: any = { sport: sport.name, teams_checked: 0, teams_could_not_resolve: [] as any[], players_upserted: 0 };

      const ourTeams = await db(`teams?select=id,name&sport_id=eq.${sport.id}`);
      if (!ourTeams || !ourTeams.length) {
        sportResult.note = 'No teams on file for this sport yet.';
        overall.sports.push(sportResult);
        continue;
      }

      // ---- Resolve each of OUR teams to that sport's real roster-API id ----
      // Same proven technique as check-player-team-drift/schedule-sync-
      // backfill/validate-*-player-txt.
      const rosterIdByOurTeamId = new Map<string, string>();

      if (sportNorm === 'mlb') {
        try {
          const mlbTeamsRes = await espnFetch('https://statsapi.mlb.com/api/v1/teams?sportId=1');
          const mlbTeamsData = mlbTeamsRes.ok ? await mlbTeamsRes.json() : null;
          const mlbTeams: { id: number; name: string }[] = (mlbTeamsData && mlbTeamsData.teams) || [];
          for (const t of ourTeams) {
            const norm = normalize(t.name);
            const exact = mlbTeams.find(mt => normalize(mt.name) === norm);
            const substringMatches = !exact ? mlbTeams.filter(mt => normalize(mt.name).includes(norm) || norm.includes(normalize(mt.name))) : [];
            const resolved = exact || (substringMatches.length === 1 ? substringMatches[0] : null);
            if (resolved) rosterIdByOurTeamId.set(t.id, String(resolved.id));
          }
        } catch (e) {
          sportResult.mlb_team_list_error = String(e);
        }
      } else {
        const espnPath = sportNorm === 'wnba' ? 'basketball/wnba' : sportNorm === 'nhl' ? 'hockey/nhl' : 'basketball/nba';
        const foundTeams = new Map<string, string>();
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
        for (const t of ourTeams) {
          const norm = normalize(t.name);
          for (const [espnId, espnName] of foundTeams) {
            if (normalize(espnName) === norm) { rosterIdByOurTeamId.set(t.id, espnId); break; }
          }
        }
      }

      // ---- Fetch each resolvable team's CURRENT roster and upsert every player ----
      for (const t of ourTeams) {
        const rosterId = rosterIdByOurTeamId.get(t.id);
        if (!rosterId) {
          sportResult.teams_could_not_resolve.push({
            team: t.name,
            reason: sportNorm === 'mlb'
              ? 'Could not match this team against the MLB Stats API teams list.'
              : `Not found in the last ${SCAN_WINDOW_DAYS} days of ${sport.name} scoreboards -- may not have played recently, or the name doesn't match closely enough.`
          });
          continue;
        }
        let rosterNames: string[] = [];
        try {
          if (sportNorm === 'mlb') {
            const res = await espnFetch(`https://statsapi.mlb.com/api/v1/teams/${rosterId}/roster?rosterType=active`);
            if (res.ok) {
              const data = await res.json();
              rosterNames = (data.roster || []).map((r: any) => (r.person && r.person.fullName) || '').filter(Boolean);
            }
          } else {
            const espnPath = sportNorm === 'wnba' ? 'basketball/wnba' : sportNorm === 'nhl' ? 'hockey/nhl' : 'basketball/nba';
            const res = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/teams/${rosterId}/roster`);
            if (res.ok) {
              const data = await res.json();
              // Same "flatten position groups" fix as schedule-sync-
              // backfill -- NHL/football-style rosters nest real players
              // inside each group's own `items` array; basketball never
              // has `items`, so this is a no-op there.
              const rawAthletes = data.athletes || [];
              const athletes = rawAthletes.flatMap((a: any) => Array.isArray(a.items) ? a.items : [a]);
              rosterNames = athletes.map((a: any) => a.fullName || a.displayName || '').filter(Boolean);
            }
          }
        } catch (e) {
          sportResult.teams_could_not_resolve.push({ team: t.name, reason: `Roster fetch failed: ${String(e)}` });
          continue;
        }
        sportResult.teams_checked++;
        for (const name of rosterNames) {
          const { first, last } = splitName(name);
          try {
            // Same merge-duplicates upsert shape registerKnownPlayer
            // already uses -- a name already on file (e.g. from a real
            // graded pick) picks up/refreshes its confirmed team here too,
            // exactly like a trade or signing being caught.
            await db('known_players', {
              method: 'POST',
              headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
              body: JSON.stringify({
                sport_id: sport.id, name, first_name: first, last_name: last,
                team_id: t.id, team_confirmed_at: new Date().toISOString()
              })
            });
            sportResult.players_upserted++;
          } catch (_e) {
            // One bad row (rare) shouldn't abort the whole team.
          }
        }
        await sleep(150);
      }
      overall.sports.push(sportResult);
    }

    return new Response(JSON.stringify(overall), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
