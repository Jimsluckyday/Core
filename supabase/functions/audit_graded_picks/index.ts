// audit_graded_picks
// Direct request 2026-09-06: "I wanted a tool we can run behind the
// scenes to validate that we have scored everything correctly... catch
// those ones where it confidently gives us the wrong score... saw all our
// over player props grade out as a win when they may not have been."
// This is NOT a grader -- it never writes a `result`, ever. For every
// pick that's ALREADY graded (result != pending), it independently
// re-derives what the correct result should be from real, freshly-
// fetched source data, and reports any MISMATCH against what's actually
// stored, for a human to review.
//
// DELIBERATE DESIGN CHOICE: this does NOT call or reuse
// grade_picks_espn_backfill's own comparison logic. An audit whose check
// shares the same code as the thing it's checking can never catch a bug
// in that code -- it would just recompute the identical wrong answer and
// report "matches, all good." Every win/loss/push decision below is
// written fresh, independently, directly against real box scores/final
// scores, even though the underlying sign conventions (negative line =
// Over, a spread's own margin math) are the same real, confirmed-correct
// conventions already established project-wide -- reusing a CONVENTION is
// fine; reusing the CODE that applies it is what defeats the point.
// Team-id/game-matching (a "which real game is this" question, not a
// scoring-logic question) does reuse the same proven exact-then-unique-
// substring technique used throughout this project, since getting that
// part wrong just means "couldn't verify," never a wrong comparison.
//
// SCOPE, direct decision 2026-09-06 given the size of "audit everything":
// covers the highest-volume, highest-risk categories first --
// Moneyline/Spread/Total/Team Total for MLB/NBA/WNBA/NHL/NFL, and Player
// Props (the common single-stat markets only: MLB hits/home runs/RBIs/
// runs/strikeouts/walks, NBA+WNBA points/rebounds/assists/steals/blocks)
// for MLB/NBA/WNBA. Everything outside that -- other sports, combo props,
// quarter-lines, First5/First7, period-scoped bets, MMA, Golf, Tennis,
// Parlays -- is explicitly reported as NOT independently verified by this
// pass, grouped and counted, never silently skipped or assumed correct.
// Direct acknowledgment from the same conversation: a bet type with no
// automated grading at all (manually graded) can't be caught here either
// way, by design -- "if we miss the manual ones we will have to live with
// that."
//
// Call with: GET /audit_graded_picks?date=2026-06-04
//        or: GET /audit_graded_picks?date=2026-06-04&sport=MLB

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

// Sports this audit can independently verify Moneyline/Spread/Total/Team
// Total for -- the standard "one final score per side" team-sport shape.
// Deliberately a smaller list than ESPN_SPORT_MAP's full set (that one
// also covers MMA/MLS/CFL/NCAA variants with their own quirks not
// re-verified here yet).
const ESPN_SPORT_MAP: Record<string, string> = {
  mlb: 'baseball/mlb',
  nba: 'basketball/nba',
  wnba: 'basketball/wnba',
  nhl: 'hockey/nhl',
  nfl: 'football/nfl',
};

// Independent, freshly-written margin math -- same real, already-
// confirmed-correct conventions used project-wide (negative line = Over/
// favorite, per project_prop_line_sign_convention), deliberately NOT
// copy-pasted from grade_picks_espn_backfill's own gradeSpread/gradeTotal.
// Does not attempt quarter-line (.25/.75) half-stake handling -- flagged
// separately below as not independently verified when encountered.
function marginResult(margin: number): 'win' | 'loss' | 'push' {
  if (margin > 0) return 'win';
  if (margin < 0) return 'loss';
  return 'push';
}

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

    async function db(path: string) {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' }
      });
      if (!res.ok) throw new Error(`DB request failed (${res.status}): ${await res.text()}`);
      return res.json();
    }

    const url = new URL(req.url);
    const targetDate = url.searchParams.get('date');
    const sportFilter = url.searchParams.get('sport');
    if (!targetDate) {
      return new Response(JSON.stringify({ error: 'Provide ?date=YYYY-MM-DD.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    let ourSports = await db('sports?select=id,name');
    if (sportFilter) ourSports = (ourSports || []).filter((s: any) => normalize(s.name) === normalize(sportFilter));

    const report: any = {
      audited_at: new Date().toISOString(), date: targetDate,
      mismatches: [] as any[], matches_confirmed: 0,
      not_independently_verified: {} as Record<string, number>
    };

    function flagUnverified(reason: string) {
      report.not_independently_verified[reason] = (report.not_independently_verified[reason] || 0) + 1;
    }

    for (const sport of ourSports) {
      const sportNorm = normalize(sport.name);
      const espnPath = ESPN_SPORT_MAP[sportNorm];

      const picks = await db(
        `picks?select=id,capper_id,selection,line,result,bet_type_id,prop_player,prop_stat,is_parlay_leg,` +
        `bet_types(name,uses_prop_fields),cappers(name)` +
        `&sport_id=eq.${sport.id}&event_date=eq.${targetDate}&result=neq.pending`
      );
      if (!picks || !picks.length) continue;

      if (!espnPath) {
        picks.forEach(() => flagUnverified(`${sport.name}: no ESPN source wired into this audit yet`));
        continue;
      }

      // ---- Fetch every game for this sport/date once, real final scores only ----
      const espnDate = targetDate.replace(/-/g, '');
      const scoreboardRes = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${espnDate}`);
      const scoreboardData = scoreboardRes.ok ? await scoreboardRes.json() : { events: [] };
      const games = (scoreboardData.events || []).map((e: any) => {
        const comp = e.competitions && e.competitions[0];
        const competitors = (comp && comp.competitors) || [];
        const home = competitors.find((c: any) => c.homeAway === 'home');
        const away = competitors.find((c: any) => c.homeAway === 'away');
        const completed = !!(e.status && e.status.type && e.status.type.completed);
        return {
          id: e.id, completed, home, away,
          homeScore: home ? Number(home.score) : null,
          awayScore: away ? Number(away.score) : null
        };
      });

      function findTeamSide(teamStr: string) {
        const norm = normalize(teamStr);
        const hits: { game: typeof games[0]; isHome: boolean }[] = [];
        for (const g of games) {
          for (const [side, comp] of [['home', g.home], ['away', g.away]] as const) {
            if (!comp || !comp.team) continue;
            const names = [comp.team.displayName, comp.team.name, comp.team.shortDisplayName, comp.team.location].filter(Boolean).map(normalize);
            const exact = names.some(n => n === norm);
            const substring = names.some(n => n.includes(norm) || norm.includes(n));
            if (exact || substring) { hits.push({ game: g, isHome: side === 'home' }); break; }
          }
        }
        return hits;
      }

      // ---- Box scores, fetched lazily per event only when a Player Prop needs one ----
      const boxscoreCache = new Map<string, any>();
      async function fetchBox(eventId: string) {
        if (boxscoreCache.has(eventId)) return boxscoreCache.get(eventId);
        const res = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/summary?event=${eventId}`);
        const json = res.ok ? await res.json() : null;
        boxscoreCache.set(eventId, json);
        return json;
      }
      const mlbBoxCache = new Map<string, any>();
      async function fetchMlbBox(gamePk: string) {
        if (mlbBoxCache.has(gamePk)) return mlbBoxCache.get(gamePk);
        const res = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`);
        const json = res.ok ? await res.json() : null;
        mlbBoxCache.set(gamePk, json);
        return json;
      }
      let mlbScheduleGames: any[] | null = null;

      // Independent single-field stat readers -- deliberately only the
      // common, unambiguous counting stats (see file header for what's
      // excluded on purpose). Values are ESPN's own exact `keys` field
      // (confirmed directly against a real box score: statistics[0].keys
      // = ["minutes","points","fieldGoalsMade-...","rebounds","assists",
      // "turnovers","steals","blocks",...], parallel to each athlete's own
      // `stats` array at the same index) -- exact-match against this,
      // never the abbreviated `names`/`labels` ("PTS","REB"), which would
      // need fuzzy matching for no reason when an exact key already exists.
      const NBA_WNBA_STAT_KEYS: Record<string, string> = {
        points: 'points', pts: 'points',
        rebounds: 'rebounds', reb: 'rebounds', rebs: 'rebounds',
        assists: 'assists', ast: 'assists',
        steals: 'steals', stl: 'steals',
        blocks: 'blocks', blk: 'blocks'
      };
      const MLB_BATTING_STATS: Record<string, string> = {
        hits: 'hits', homeruns: 'homeRuns', rbi: 'rbi', rbis: 'rbi', runs: 'runs'
      };
      // Strikeouts/walks exist in BOTH groups (a pitcher's own Ks, or a
      // batter's own strikeouts-against) -- checks pitching first (the far
      // more common real market), falls back to batting only if the
      // player has no pitching line at all that game, same precedence
      // grade_picks_espn_backfill's own STAT_SPECS already establishes.
      const MLB_DUAL_STATS: Record<string, string> = { strikeouts: 'strikeOuts', walks: 'baseOnBalls' };

      for (const pick of picks) {
        const betTypeName = (pick.bet_types && pick.bet_types.name) || '';
        const betTypeNorm = normalize(betTypeName);
        const isProp = pick.bet_types && pick.bet_types.uses_prop_fields;
        const pickLabel = { id: pick.id, capper: pick.cappers ? pick.cappers.name : '?', bet_type: betTypeName, selection: pick.selection, stored_result: pick.result };

        // ---- Player Props (MLB/NBA/WNBA, common single-field stats only) ----
        if (isProp) {
          if (!['mlb', 'nba', 'wnba'].includes(sportNorm)) { flagUnverified(`${sport.name} Player Props: not covered by this audit yet`); continue; }
          const statNorm = normalize(pick.prop_stat || '');
          if (!pick.prop_player || pick.line === null || pick.line === undefined) { flagUnverified(`${sport.name} Player Prop: missing player/line, can't independently check`); continue; }

          let value: number | null = null;
          if (sportNorm === 'mlb') {
            if (!mlbScheduleGames) {
              const schedRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${targetDate}`);
              const schedData = schedRes.ok ? await schedRes.json() : null;
              mlbScheduleGames = (schedData && schedData.dates && schedData.dates[0] && schedData.dates[0].games) || [];
            }
            const battingKey = MLB_BATTING_STATS[statNorm];
            const dualKey = MLB_DUAL_STATS[statNorm];
            if (!battingKey && !dualKey) { flagUnverified(`MLB Player Prop stat "${pick.prop_stat}": not one of the common stats this audit checks`); continue; }
            const playerNorm = normalize(pick.prop_player);
            let found = false;
            for (const g of mlbScheduleGames) {
              const box = await fetchMlbBox(String(g.gamePk));
              if (!box || !box.teams) continue;
              for (const side of ['home', 'away'] as const) {
                const team = box.teams[side];
                if (!team || !team.players) continue;
                for (const pid of Object.keys(team.players)) {
                  const p = team.players[pid];
                  const fullName = (p.person && p.person.fullName) || '';
                  if (normalize(fullName) !== playerNorm) continue;
                  if (battingKey) {
                    const stats = p.stats && p.stats.batting;
                    if (stats && stats[battingKey] !== undefined && stats[battingKey] !== null) {
                      value = Number(stats[battingKey]); found = true;
                    }
                  } else {
                    const pitchingStats = p.stats && p.stats.pitching;
                    const battingStats = p.stats && p.stats.batting;
                    if (pitchingStats && pitchingStats[dualKey!] !== undefined && pitchingStats[dualKey!] !== null) {
                      value = Number(pitchingStats[dualKey!]); found = true;
                    } else if (battingStats && battingStats[dualKey!] !== undefined && battingStats[dualKey!] !== null) {
                      value = Number(battingStats[dualKey!]); found = true;
                    }
                  }
                }
              }
              if (found) break;
            }
            if (!found) { flagUnverified(`MLB Player Prop: "${pick.prop_player}" not found in any real box score for independent check`); continue; }
          } else {
            const statKey = NBA_WNBA_STAT_KEYS[statNorm];
            if (!statKey) { flagUnverified(`${sport.name} Player Prop stat "${pick.prop_stat}": not one of the common stats this audit checks`); continue; }
            const playerNorm = normalize(pick.prop_player);
            let found = false;
            for (const g of games) {
              const box = await fetchBox(g.id);
              const players = box && box.boxscore && box.boxscore.players;
              if (!Array.isArray(players)) continue;
              for (const teamBlock of players) {
                const statGroup = teamBlock.statistics && teamBlock.statistics[0];
                if (!statGroup) continue;
                const statIndex = (statGroup.keys || []).indexOf(statKey);
                const athletes = statGroup.athletes || [];
                for (const a of athletes) {
                  const displayName = (a.athlete && a.athlete.displayName) || '';
                  if (normalize(displayName) !== playerNorm) continue;
                  if (statIndex >= 0 && Array.isArray(a.stats) && a.stats[statIndex] !== undefined) {
                    const parsed = Number(a.stats[statIndex]);
                    if (!Number.isNaN(parsed)) { value = parsed; found = true; }
                  }
                }
              }
              if (found) break;
            }
            if (!found) { flagUnverified(`${sport.name} Player Prop: "${pick.prop_player}" not found in any real box score for independent check`); continue; }
          }

          if (value === null) { flagUnverified(`${sport.name} Player Prop: found the player but not a readable "${pick.prop_stat}" value`); continue; }
          const threshold = Math.abs(Number(pick.line));
          const isOver = normalize(pick.selection) === 'over';
          const isUnder = normalize(pick.selection) === 'under';
          if (!isOver && !isUnder) { flagUnverified(`${sport.name} Player Prop: selection "${pick.selection}" isn't Over/Under, can't independently check`); continue; }
          const computed = value === threshold ? 'push' : (isOver ? (value > threshold ? 'win' : 'loss') : (value < threshold ? 'win' : 'loss'));
          if (computed !== pick.result) {
            report.mismatches.push({ ...pickLabel, computed_result: computed, detail: `${pick.prop_player} ${pick.prop_stat}: real value ${value}, line ${pick.line}` });
          } else {
            report.matches_confirmed++;
          }
          continue;
        }

        // ---- Moneyline / Spread / Total / Team Total, big-5 team sports only ----
        const isMoneyline = betTypeNorm === 'moneyline';
        const isSpread = betTypeNorm === 'spread';
        const isTeamTotal = betTypeNorm === 'teamtotal';
        const isTotal = betTypeNorm === 'total' || (betTypeNorm.startsWith('overunder') && !betTypeNorm.includes('first'));
        if (!isMoneyline && !isSpread && !isTeamTotal && !isTotal) {
          flagUnverified(`Bet type "${betTypeName}": not covered by this audit yet`);
          continue;
        }
        if (pick.line !== null && pick.line !== undefined && Math.abs(Number(pick.line) % 1) !== 0 && Math.abs(Number(pick.line) % 1) !== 0.5) {
          flagUnverified(`${betTypeName}: quarter-line (${pick.line}) not independently checked yet`);
          continue;
        }

        if (isTotal && pick.selection.includes('/')) {
          const [teamA, teamB] = pick.selection.split('/').map((s: string) => s.trim());
          const hitsA = findTeamSide(teamA);
          const hitsB = findTeamSide(teamB);
          const candidates = hitsA.filter(a => hitsB.some(b => b.game.id === a.game.id)).map(a => a.game);
          if (candidates.length !== 1) { flagUnverified(`Total: could not uniquely match "${pick.selection}" to one real game`); continue; }
          const g = candidates[0];
          if (!g.completed || g.homeScore === null || g.awayScore === null) { flagUnverified(`${sport.name}: game not final yet, skipped`); continue; }
          const combined = g.homeScore + g.awayScore;
          const threshold = Math.abs(Number(pick.line));
          const isOver = Number(pick.line) < 0;
          const margin = isOver ? (combined - threshold) : (threshold - combined);
          const computed = marginResult(margin);
          if (computed !== pick.result) {
            report.mismatches.push({ ...pickLabel, computed_result: computed, detail: `Real combined score ${combined}, line ${pick.line}` });
          } else {
            report.matches_confirmed++;
          }
          continue;
        }

        const hits = findTeamSide(pick.selection);
        if (hits.length !== 1) { flagUnverified(`${betTypeName}: could not uniquely match "${pick.selection}" to one real team playing that day`); continue; }
        const { game: g, isHome } = hits[0];
        if (!g.completed || g.homeScore === null || g.awayScore === null) { flagUnverified(`${sport.name}: game not final yet, skipped`); continue; }
        const ownScore = isHome ? g.homeScore : g.awayScore;
        const oppScore = isHome ? g.awayScore : g.homeScore;

        let computed: 'win' | 'loss' | 'push';
        let detail: string;
        if (isMoneyline) {
          computed = ownScore > oppScore ? 'win' : ownScore < oppScore ? 'loss' : 'push';
          detail = `Real final score: ${ownScore}-${oppScore}`;
        } else if (isSpread) {
          const margin = (ownScore - oppScore) + Number(pick.line);
          computed = marginResult(margin);
          detail = `Real final score: ${ownScore}-${oppScore}, line ${pick.line}`;
        } else {
          const threshold = Math.abs(Number(pick.line));
          const isOver = Number(pick.line) < 0;
          const margin = isOver ? (ownScore - threshold) : (threshold - ownScore);
          computed = marginResult(margin);
          detail = `Real own-team score: ${ownScore}, line ${pick.line}`;
        }
        if (computed !== pick.result) {
          report.mismatches.push({ ...pickLabel, computed_result: computed, detail });
        } else {
          report.matches_confirmed++;
        }
      }
    }

    return new Response(JSON.stringify(report, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
