// schedule-sync-backfill
// Historical catch-up: takes ONE date and loops through every sport you
// have set up, matching and filling in game_start_time + home_away for
// that day only (plus prop_team for player props). Touches picks
// regardless of result (pending, win, loss, push) -- meant for occasional
// bulk backfill, not routine daily use.
//
// Sources games from ESPN's public scoreboard endpoint instead of
// TheRundown -- TheRundown's Free plan has a 7-day history limit, which
// makes it structurally unable to serve THIS function's entire purpose
// (every date this function is ever called for is, by definition, old).
// No API key needed: this is ESPN's unofficial, undocumented scoreboard
// API, but it has genuine historical coverage with no rolling window
// observed.
//
// Reuses the EXACT same ESPN_SPORT_MAP as grade_picks_espn_backfill on
// purpose -- one single source of truth for "which sports ESPN can
// cover," not two slightly different lists drifting apart over time.
//
// PLAYER PROPS: ESPN's scoreboard is team-level only, so it can never
// match a prop pick to a game by itself. For MLB (via MLB's free,
// official Stats API) and NBA (via BALLDONTLIE, requires a
// BALLDONTLIE_API_KEY secret), this builds a real player-name ->
// {team, game start time} lookup from each sport's own roster data --
// same technique already proven in the live schedule-sync, ported here
// so backfilled dates get the same coverage. Every other sport still has
// no way to resolve a named player to a game and continues to skip props
// entirely, exactly as the live version does -- not a regression, just
// not yet extended.
//
// CONFIRMED FIXES (found backfilling real June 2026 data before shipping
// this version):
// 1. Bare city/location names (e.g. "Los Angeles") are only used as a
//    matchable variant when unique across every team playing that sport
//    that day -- otherwise two teams from the same city (LA Angels vs LA
//    Dodgers) would ambiguously match each other's picks. Same fix the
//    live schedule-sync already made once for "New York Yankees" vs Mets;
//    it just hadn't been ported to this ESPN-based ancestor function yet.
// 2. Short abbreviations (e.g. Arizona's "ARI") are now matched on EXACT
//    equality only, never substring containment -- a real, confirmed
//    case had "ARI" incorrectly matching inside "Mariners" (m-ARI-ners).
// 3. Parlay picks are excluded from matching entirely -- a parlay has no
//    single game or side to match against (its legs do, and are matched
//    normally since their own bet type isn't "Parlay"), so searching for
//    "2-Leg Parlay" as if it were a team name was pure wasted noise.
// 4. CONFIRMED, found in a real backfill run: the MLB roster lookup below
//    used to fetch each team's CURRENT (as-of-today) active roster, not a
//    historical snapshot for the actual backfill date -- a player traded,
//    optioned down, or released between the pick's date and whenever this
//    function is later run would silently vanish from matching even
//    though they were genuinely on the team that day. MLB's Stats API
//    turns out to accept a date= parameter on the roster endpoint that
//    fixes this completely; confirmed directly (Joe Ryan, missing from
//    the Twins' current roster, correctly appears with date=2026-06-01).
//    NBA/BALLDONTLIE doesn't have a known equivalent fix -- not something
//    this run surfaced evidence for either way, so left as-is for now.
// 5. CONFIRMED, direct report: a sport with no ESPN scoreboard mapping
//    (Soccer, KBO, CBA, Cricket, Euro Basketball, and any miscategorized
//    sport-table entry like "Needs Review") used to be skipped entirely
//    at the SPORT level -- the whole sport just never appeared again,
//    with zero trace left on any individual pick. From a pick's own
//    perspective this was indistinguishable from "the tool hasn't run
//    yet," so a genuinely-blank Soccer Home/Away looked identical to a
//    real code failure. Now writes an honest schedule_sync_status/note
//    directly onto each applicable pick ("No automated schedule source
//    available for {sport} -- needs manual entry.") instead of silence.
//    Deliberately excludes Tennis/Golf/MMA/Boxing from this -- those also
//    have no ESPN mapping, but structurally never need home_away at all
//    (same NO_HOME_AWAY_SPORTS list admin.html's own sportUsesHomeAway()
//    uses client-side), so flagging them here would be actively wrong,
//    not just unhelpful. Also excludes Parlay wrapper rows and Player
//    Props for the same reason they're excluded everywhere else in this
//    file -- neither one has a home/away side to fill in.
// 6. CONFIRMED useful, direct request: a bare "not found" note leaves the
//    reader to go research the correct spelling themselves, every time --
//    unhelpful for anyone unfamiliar with the sport (or just not a
//    confident speller) who won't necessarily recognize their own typo.
//    Both the team-matching and player-prop-matching failure paths now
//    run a Levenshtein-distance check against the real names actually in
//    play that day (every team ESPN listed, or every player on a roster
//    the prop lookup already fetched) and append a "did you mean X?"
//    suggestion to the note when something's genuinely close. Same
//    technique, same distance threshold, as the "did you mean" suggestion
//    admin.html's own Bulk Import already uses for team names client-side
//    (checkTeamName/levenshtein) -- ported here rather than reinvented, so
//    the two stay consistent. Deliberately does NOT touch Tennis/Golf/MMA
//    (no roster or player-name data source exists for them in this
//    system at all, so there's nothing to compare a typo against) -- a
//    real gap, tracked separately, not solved by this fix.
// 7. CONFIRMED REAL BUG, found in a real production run of fix #6 above:
//    the player-prop "did you mean" suggestion reused the SAME word-split
//    + proportional-distance comparison as team names, and suggested
//    "Michael Wacha" for "Michael Busch" -- a completely different,
//    unrelated pitcher who only happens to share the first name. A shared
//    first name alone was enough to "subsidize" an unrelated last name
//    into looking close enough. Player names now use a separate, STRICTER
//    comparison (suggestClosestPlayer) -- full-string only, no per-word
//    partial credit, flat distance cap instead of one that grows with
//    name length. See that function's own comment for the full story.
// 8. CONFIRMED REAL BUG, found the same day checking real June 1 results:
//    several MLB Spread/Moneyline/"No Run First Inning" picks were
//    silently marked schedule_sync_status='matched' with home_away left
//    completely blank, and stayed that way through every later fix,
//    because their selection text happened to contain a "/" (e.g. "San
//    Francisco/Milwaukee", "Detroit/Tampa Bay") -- the exact same shape
//    as a genuine two-team Total selection, which correctly has no single
//    side to assign. The code couldn't tell those apart: ANY "/" was
//    treated as "no home_away needed," regardless of whether the bet type
//    actually required one. Fixed by checking the pick's own bet type
//    (new betTypeUsesHomeAway(), same logic as admin.html's client-side
//    version) before deciding a "/" selection is exempt -- a Spread or
//    Moneyline pick with a "/" now correctly still tries to match the
//    game (so game_start_time gets filled in, since the GAME itself isn't
//    ambiguous) but writes an honest note explaining that the SIDE can't
//    be determined from "TeamA/TeamB" text alone, instead of silently
//    marking it done. Once a pick was wrongly marked 'matched' this way,
//    this function's own query (which skips anything already 'matched')
//    would never revisit it again on its own -- a one-time SQL reset of
//    the affected rows' schedule_sync_status/note is required alongside
//    this code fix so the next run actually reprocesses them.
// 9. Soccer now has real ESPN coverage -- direct concern that this is a
//    North American-focused business, but nothing stops a capper from
//    calling a European club game, a Champions League tie, or an
//    international friendly, and the 2026 World Cup (June 11 - July 19,
//    hosted in North America) lands right in this system's active window.
//    Soccer isn't one competition the way MLB/NBA are, so it never fit
//    the single-endpoint ESPN_SPORT_MAP structure -- ESPN instead exposes
//    dozens of separate competition endpoints (leagues, continental cups,
//    international tournaments). Now fetches a curated list of 23 of
//    them (SOCCER_COMPETITION_SLUGS below) in parallel and merges their
//    games into one combined pool for the day, then runs the exact same
//    matching logic already proven for every other sport. Every slug on
//    the list was confirmed directly against ESPN's real API before
//    shipping (all resolve to the correct competition). Confirmed
//    end-to-end against real production data: the merged pool for June 1
//    2026 correctly resolves the real "Sweden/Norway" pick to exactly one
//    game via soccer/fifa.friendly. Not exhaustive -- a competition not
//    on the list still gets a clear "no matching game found" note rather
//    than silence, and the list can grow as real gaps show up, same as
//    every other fix in this file.
// 10. CONFIRMED FIX, direct request: "We could very well pick up a source
//     that calls Cricket or Chinese Basketball or European sports so we
//     should resolve those as there must be an API or source out there
//     to pick these up." Real Cricket schedule coverage added via
//     CricketData.org (api.cricapi.com, free tier, 100 hits/day, real
//     key confirmed directly). Chinese Basketball (CBA) explicitly
//     parked -- real data exists via TheSportsDB (confirmed directly
//     against real match data), but reliable production use needs a
//     $9/month Patreon key, not worth it yet for the single real pick
//     seen so far. Structured as its own top-level branch (see the
//     isCricket branch's own comment for the full architecture --
//     why it can't reuse the generic MLB/NBA/KBO/ESPN pipeline, the
//     series-search query strategy that stays within the tight rate
//     limit, and the same-day-or-later tiebreak it needed, same
//     reasoning as Fix #24). Verified directly against the real key and
//     real data behind this session's own two Cricket picks: "Pakistan"
//     and "Austrailia" (a typo for "Australia") both correctly resolve
//     to the real June 2, 2026 Pakistan vs Australia ODI (the closest
//     same-day-or-later match in the real 3-match series spanning May
//     30-June 4, none of which fall exactly on the picks' June 1
//     event_date) -- including the typo resolving via the same cross-
//     confirmed spelling-correction approach as Fix #26 (the correctly-
//     spelled "Pakistan" pick's own series search surfaces the real
//     Australia matches too, so "Austrailia" -> "Australia" only gets
//     trusted once it's confirmed against that real shared match pool,
//     not a blind guess), and both correctly get home_away set (Pakistan
//     "home", Australia "away") via a "<touring team> tour of <host
//     team>" series-name heuristic, confirmed against the real series
//     name "Australia tour of Pakistan 2026".
// 11. CONFIRMED FIX, direct report immediately after shipping fix #10:
//     Tennis picks got no sync note at all, and it turned out to be
//     another version of the exact same silent-skip bug -- Tennis/Golf/
//     MMA/Boxing (NO_HOME_AWAY_SPORTS) were being skipped ENTIRELY at the
//     sport level before any pick was ever looked at, on the theory that
//     "doesn't need home_away" meant "needs no processing here at all."
//     Those are two different facts -- these sports still need
//     game_start_time like anyone else, this function just has no data
//     source for any of it. This branch also used to exclude Player Prop
//     picks outright, which meant Tennis (almost entirely props) was
//     getting close to zero real coverage even when it WAS reached. Now
//     unified: any no-ESPN-mapping sport (Tennis/Golf/MMA/Boxing, KBO,
//     CBA, Cricket, Euro Basketball, miscategorized entries) gets a real
//     per-pick note for whatever it's ACTUALLY missing -- home_away only
//     when the sport/bet-type needs one, game_start_time always -- rather
//     than either silence or a note that doesn't match what's really gone.
//     Parlay wrapper rows stay fully excluded, same as everywhere else.
// 12. Tennis now has real schedule coverage -- direct concern, confirmed
//     with real data: Tennis picks routinely arrive late at night for
//     matches starting as early as 5-6am ET the next morning, and nobody
//     reading the pick later (customer or reviewer) has any way to know
//     that. ESPN's tennis/atp and tennis/wta endpoints expose individual
//     match start times nested inside each tournament's draw (tournament
//     -> Men's/Women's Singles/Doubles grouping -> match) -- structurally
//     different from every other sport in this file, so Tennis gets its
//     own dedicated matching path (like Soccer's, but not games/teams --
//     players and matches). Handles singles and doubles together, since
//     cappers call both and a lone player name can appear in BOTH a
//     singles AND a doubles match the same day (disambiguated by
//     preferring singles when that's the only thing that resolves it
//     cleanly). Surname-only picks ("Cobolli" instead of "Flavio
//     Cobolli") are matched the same way team bare-location names are --
//     only when unique across everyone playing that day. Verified
//     end-to-end against real June 1 2026 data and real picks in this
//     system before shipping, including a genuine bug caught in that
//     process: a Grand Slam's combined draw appears in BOTH the atp and
//     wta feeds with its full schedule each time, which silently
//     double-counted every match until deduped by match id.
// 13. CONFIRMED FIX, direct request: "what are we doing with the ones on
//     the wrong date... I had a scenario that will come up where someone
//     put in World Cup picks 2 weeks out." Confirmed directly against
//     ESPN's real API before building this: querying a tournament's own
//     feed on a date BEFORE it starts returns either a totally EMPTY event
//     list (soccer/fifa.world queried 2 weeks before the World Cup's real
//     June 11 start), or a completely DIFFERENT, unrelated tournament that
//     happens to be active that day instead (tennis/atp queried 3 weeks
//     before the French Open's real May 17 start returned the Madrid Open
//     instead) -- so a wrong event_date can't be fixed by just re-querying
//     ESPN with a slightly different guessed date; the query date has to
//     come from a REAL tournament window. Scoped to exactly the sports the
//     project owner named as actually having this problem (Tennis, Soccer
//     -- Golf/KBO/MMA don't have real ESPN coverage built yet at all, see
//     the "unsupported sport" branch above) -- every other sport keeps
//     strict same-day matching only, per direct confirmation these sports
//     "should never experience this issue outside of playoffs."
//     getCandidateQueryDates() below consults the real tournaments table
//     (already populated and kept current via the "Bulk refresh
//     tournaments" tool in Setup) for anything whose own start_date/
//     end_date falls within a 30-day buffer of the pick's stated
//     event_date, and adds each one's own MIDPOINT date as an extra query
//     date. Deliberately the midpoint, not start_date -- also confirmed
//     directly while building this: our own tournaments table's start_date
//     for French Open (2026-05-17) doesn't line up exactly with when
//     ESPN's own feed actually starts returning it (2026-05-18) -- a tight
//     boundary date is fragile to exactly this kind of one-day mismatch,
//     but a mid-tournament date isn't, and still works: querying ATP with
//     2026-05-27 (well inside the window) still returns Roland Garros's
//     FULL 633-match draw, including Round 1 matches from 2026-05-18,
//     since ESPN returns a tournament's whole schedule regardless of which
//     date within its active window was queried (same behavior CONFIRMED
//     FIX #12 already relies on).
//     Deliberately does NOT try to match tournament NAMES between our
//     table and ESPN's own naming (confirmed they can differ -- our table
//     says "French Open", ESPN calls it "Roland Garros") -- it just trusts
//     that querying a date within a real tournament's real window pulls
//     back whatever's actually relevant then. When a match is found on a
//     date different from the pick's own event_date, game_start_time still
//     gets set to the real value (so no second run is ever needed just
//     because the date was off), but schedule_sync_status stays 'matched'
//     WITH a note flagging the discrepancy -- a deliberate, one-time
//     exception to the usual "matched means note is null" rule, since the
//     whole point of this fix is to surface a wrong event_date instead of
//     silently correcting around it. event_date itself is never rewritten.
//     CONFIRMED REAL BUG, found immediately after shipping the above,
//     direct report with real production output: widening the Tennis pool
//     to span tournament windows (removing the same-day filter) broke two
//     things that used to safely assume "a player appears at most once per
//     day" -- (1) surname-uniqueness counted raw match OCCURRENCES, so a
//     player who advanced through multiple rounds inflated her OWN
//     surname's count above 1 and got silently excluded from surname-only
//     lookup even though she's the only real person with that name in the
//     whole pool (confirmed real failures: Andreeva, Zverev, Fonseca,
//     Mensik, Kostyuk, Svitolina, Cirstea, Krueger, Pellegrino -- every one
//     had a correct "did you mean" suggestion, proving they WERE in the
//     pool, just unreachable by surname); (2) single/multi-token
//     resolution required an exact count of 1 candidate, so a player or
//     pair with more than one real match in the widened pool (different
//     rounds) was wrongly treated as ambiguous (confirmed: "Casper Ruud",
//     "Marta Kostyuk"). Fixed by (1) counting DISTINCT normalized full
//     names per surname instead of raw occurrences, and (2) a
//     closestTennisMatch() tiebreaker that picks whichever of a resolved
//     player's/pair's real matches falls closest to the pick's own
//     event_date -- safe because every candidate reaching that tiebreaker
//     is already guaranteed (by construction) to belong to the same single
//     real player or pairing, so it's picking WHICH of their known real
//     dates was meant, not guessing between different possible people.
//     Verified directly against real ESPN data for the exact real failing
//     picks from the production run that surfaced this: 10 of 11 single-
//     name cases now resolve correctly (Zverev, Fonseca, Mensik, Kostyuk,
//     Svitolina, Cirstea, Krueger, Pellegrino, Casper Ruud, Marta Kostyuk),
//     plus the real doubles case (Bolelli/Vavassori over Nouza/
//     Oberleitner). The one that still correctly stays unmatched --
//     "Andreeva" -- is NOT a bug: confirmed there are genuinely TWO real
//     players with that surname in the pool (Mirra Andreeva and her
//     real-life sister Erika Andreeva), so declining to guess between them
//     is the right call, not a regression.
// 14. CONFIRMED FIX, direct request: "we do need a source for KBO as during
//     the KBO season I see a dozen or so picks nightly." ESPN has no KBO
//     coverage at all (confirmed directly against ESPN's own baseball-
//     leagues listing API -- MLB, college ball, several winter leagues,
//     but no KBO). Naver Sports (a major Korean portal) runs a real, live
//     KBO schedule through its own internal API -- confirmed directly:
//     pulling real 2025 dates returned real completed games with real
//     start times, scores, and team codes; pulling 6 spread-out dates
//     surfaced exactly the league's real 10 team codes, no more.
//     KBO_TEAM_NAMES maps each code to the English name real cappers in
//     this system actually use (confirmed against real KBO picks already
//     in the picks table). Naver's own start times are local KST with no
//     timezone suffix -- confirmed by pattern-matching real KBO start
//     times (18:30, 14:00) against known real weekday-evening/Sunday-day
//     KBO start conventions -- converted to UTC the same way ESPN's own
//     e.date is used everywhere else in this file. Real KBO picks in this
//     system's own picks table were checked before scoping this build --
//     all 32 found are team-level bets (Moneyline, Spread, Over/Under,
//     and their "First 5" variants), zero Player Props -- so this only
//     builds team-level matching for now; Naver's basic schedule endpoint
//     has no player/roster data anyway, so prop support would need a
//     separate source, not yet built. Once fetched, KBO games are
//     reshaped into the same shape ESPN's own events use so the EXISTING
//     team-matching pipeline (gameEntries/findMatchingGames/candidateGames)
//     runs completely unchanged -- no new matching logic, just a different
//     game-source step, same pattern Soccer already established.
//     Also queries the day before and after targetDate (not just
//     targetDate itself, see CONFIRMED FIX #13's date-mismatch-note
//     pattern, extended here) -- direct concern: KBO games are played in
//     Korea (KST, 13-14 hours ahead of US Eastern), so a pick entered late
//     evening ET can genuinely correspond to a game whose real Korean
//     calendar date is already the next day. Not tournament-table-driven
//     like Fix #13 -- KBO is a continuous league season, not a bracketed
//     event, so there's nothing there to look up; a simple +/-1-day window
//     covers the real failure mode described.
// 15. CONFIRMED FIX, direct request right after the Tennis surname fix
//     above shipped: "I can see that all the tournament fields for these
//     players are blank but I have no automated way of putting them in...
//     not something I want to update manually given the number of tennis
//     picks called on a daily basis." Confirmed against the real picks
//     table: event_name (the free-text field behind the Event/Tournament
//     dropdown in the pick-entry form, e.g. "French Open") is otherwise
//     only ever set by whoever enters the pick. A successful Tennis or
//     Soccer match already tells us the REAL tournament/competition name,
//     straight from ESPN -- Tennis carries it as tournament.name on each
//     match (confirmed real: "Roland Garros"); Soccer's competition name
//     lives at the top of each slug's own response
//     (result.value.leagues[0].name, e.g. "FIFA World Cup") rather than
//     per-event, confirmed directly, so it's stashed onto each event as
//     it's fetched. Both now write it back to event_name on a successful
//     match, but ONLY when the pick's own event_name is currently blank --
//     never overwriting a value someone already entered. KBO is
//     deliberately NOT included -- it's a continuous league season, not
//     treated as an "event" the way Tennis/Soccer/Golf are, so event_name
//     isn't a meaningful concept for a KBO pick (same reasoning CONFIRMED
//     FIX #14 already used to skip tournament-table widening for it).
// 16. CONFIRMED FIX, direct request: "the next step which is WNBA. It is
//     big enough we should be able to find somewhere to resolve the start
//     time as those failed for the WNBA player props." Confirmed directly
//     against BALLDONTLIE's own real docs (wnba.balldontlie.io) before
//     building this: their WNBA API mirrors their NBA API exactly -- same
//     GET /wnba/v1/games (dates[]/team_ids[]) and GET /wnba/v1/players
//     (team_ids[]) shape, both confirmed free-tier. The existing NBA prop-
//     lookup logic (fetch today's games, then each team's roster, build a
//     player-name -> {team, start time} map) is now shared between NBA and
//     WNBA via a single bdlSportPath variable -- no new matching logic,
//     just a different sport segment in the same URLs, same pattern
//     already used for KBO reusing the team-matching pipeline. NOTE: not
//     independently confirmed against a real authenticated response (no
//     BALLDONTLIE_API_KEY available to test with directly) -- balldontlie's
//     own docs state paid-tier PURCHASES don't carry across sports, but
//     the account-level API key credential itself is expected to be the
//     same one already configured for NBA, since both are free-tier
//     endpoints under the same account. If that assumption is wrong,
//     propLookupStatus will surface it clearly as a real, specific
//     games_fetch_failed status (e.g. 401) on the next run rather than
//     failing silently -- worth confirming against the first real result.
// 17. CONFIRMED FIX, direct report: "that did not resolve it and I have
//     some tennis ones that are still not resolving." A real pick,
//     "Sorana Cirstea/Andreeva," stayed unmatched even though a SEPARATE
//     pick for just "Sorana Cirstea" alone had already resolved correctly
//     to her real match against Mirra Andreeva in the SAME run. Root
//     cause: "Andreeva" alone is genuinely ambiguous (two real players,
//     sisters Mirra and Erika Andreeva, both in the pool), so it's
//     deliberately excluded from the safe surname-only lookup -- correct
//     for a LONE bare name, where nothing else can disambiguate it. But
//     for a multi-name pick, the OTHER named player (Cirstea) can do
//     exactly that disambiguating, since she only ever played one of the
//     two real Andreevas -- the strict single-token-only lookup never even
//     attempted this intersection, bailing out as soon as any token
//     resolved to zero safe candidates. tennisSurnameAllCandidates (every
//     player sharing a surname, not just a uniquely-safe one) is used
//     ONLY as a multi-token fallback, when a token's safe lookup comes
//     back empty and there's a second name available to disambiguate with
//     -- a lone ambiguous surname by itself still correctly stays
//     unresolved. Verified directly against real data: "Sorana Cirstea/
//     Andreeva" now correctly resolves; "Andreeva" alone still correctly
//     stays ambiguous. A separate real case checked the same day,
//     "Fonseca/Bolelli," was confirmed to be a genuine data issue rather
//     than a bug -- Fonseca only plays singles (Pavlovic, Prizmic,
//     Djokovic, Casper Ruud, Mensik) and Bolelli only plays doubles
//     (always paired with Vavassori), so they never actually meet;
//     correctly stays flagged for manual review.
// 18. CONFIRMED FIX, direct report same day: "Harris Lloyd played on June 2
//     in Birmingham" -- confirmed directly against real ESPN data that no
//     such match exists at Birmingham, but a REAL ATP player, "Lloyd
//     Harris," played Roland Garros on 2026-05-18 and 2026-05-20 -- first
//     and last name swapped, not a spelling typo. Neither existing
//     suggestion check (full-string Levenshtein, last-word-only) ever gets
//     close to a swapped name, since reversing two whole words changes the
//     character sequence far more than a normal typo would. A genuine
//     two-word reversal is a specific, well-defined transformation (not a
//     fuzzy guess), so it's registered directly as an extra lookup key --
//     not just a suggestion -- but ONLY when unambiguous: exactly one real
//     two-word name in the pool reverses to a given key, AND that key
//     doesn't collide with any OTHER real player's actual forward name
//     already in the lookup. Same safety bar already used for bare-surname
//     matching (CONFIRMED FIX #12), applied here to a reversed name
//     instead of a partial one. Verified directly against real data:
//     "Harris Lloyd" now resolves to Lloyd Harris's real match, and the
//     reversed key was confirmed to have exactly one real source with no
//     collision before shipping.
//     Same report also caught a misleading note: an NBA prop
//     (propLookupStatus 'built_but_empty' -- a genuinely EMPTY but
//     successful response, not a fetch error) used to say "try running the
//     backfill again," which is actively wrong when the real cause is a
//     wrong event_date -- confirmed directly: "the NBA prop was entered 2
//     days early as the NBA final did not start until the 3rd." Split the
//     note wording three ways: no data source at all (unchanged), a
//     genuinely empty-but-valid response (now explains the likely wrong-
//     date cause instead of implying a retry would help), and an actual
//     transient/config failure (unchanged, retry wording still applies).
// 19. CONFIRMED FIX, root cause found via the project owner's own real
//     BALLDONTLIE API key: their free tier allows only 5 requests PER
//     MINUTE (confirmed directly -- a real 429 hit after two quick
//     sequential test requests). The PARALLEL fetch pattern this used to
//     fire (2 games requests, then one MORE per team playing) blew
//     through that limit every run, silently dropping most player-fetch
//     requests. Rebuilt to stay within the real limit -- see the isTennis
//     branch's own comment history and the NBA/WNBA prop-lookup section
//     for the full story (later superseded by Fix #20's ESPN swap, which
//     removed the rate limit problem at the source instead of just
//     working around it).
// 20. CONFIRMED FIX: replaced the entire BALLDONTLIE-based NBA/WNBA prop
//     lookup with ESPN's own team roster endpoint instead -- confirmed
//     directly, no rate limit at all (8 rapid real requests, zero
//     issues), unlike BALLDONTLIE's confirmed 5/minute ceiling. Reuses
//     the `games` array already fetched for team-sport matching (no
//     second fetch needed). See the isNba/isWnba prop-lookup section's
//     own comment for the full story, including the honest caveat that
//     ESPN's roster data is current-only, not historically date-anchored
//     (same real limitation BALLDONTLIE's data effectively had too).
// 21. CONFIRMED FIX: added TEAM_NAME_ALIASES, a curated table for cases
//     where a capper's common/colloquial team name diverges from ESPN's
//     own branding -- real case: "Wisconsin" called for University of
//     Wisconsin-Milwaukee, but ESPN's own team data is just "Milwaukee,"
//     no "Wisconsin" substring anywhere. See TEAM_NAME_ALIASES' own
//     comment above for the full story and verification detail.
// 22. CONFIRMED FIX: added `ncaahockey: 'hockey/mens-college-hockey'` to
//     ESPN_SPORT_MAP ahead of fall college sports season -- confirmed
//     directly against ESPN's real API (12 real games found in a live
//     test) before adding. Does nothing until a matching "NCAA Hockey"
//     row exists in the sports table (SQL given directly in chat).
// 23. CONFIRMED FIX, direct follow-up: "I would think all women's sports
//     should get covered... if ESPN has it listed separately we should
//     account for it ahead of time." Added college softball, women's
//     college basketball/hockey/volleyball/lacrosse to ESPN_SPORT_MAP --
//     all confirmed real, working ESPN endpoints. See ESPN_SPORT_MAP's
//     own comment for the full list and verification detail. Same as
//     Fix #22, none of these do anything until a matching sports table
//     row exists.
// 24. CONFIRMED REAL BUG, found testing the widened-window fix on real
//     data: closestTennisMatch's plain closest-absolute-distance
//     tiebreak had no principled way to prefer a later match over an
//     earlier one when both were equidistant from the pick's event_date
//     -- real case: "Zverev" (event_date 2026-06-01) has real matches on
//     BOTH 2026-05-31 and 2026-06-02, exactly one day apart either way.
//     Direct clarification: "it should always assume that the game that
//     is submitted is for the same day or later. We may have a capper
//     either send an update to his picks from the night before and keep
//     them in the image but that would be a rare situation." Now prefers
//     any same-day-or-later candidate over an earlier one regardless of
//     raw distance, only falling back to the full candidate set when
//     NOTHING same-day-or-later exists for that player/pairing anywhere
//     in the widened window. Verified directly against real data:
//     "Zverev" (event_date 2026-06-01) now resolves to the 2026-06-02
//     match instead of 2026-05-31.
// 25. CONFIRMED FIX, direct follow-up same day: "Even if it can't validate
//     the date though it should still populate a tournament so we don't
//     have to go inputting information multiple times." A single-token
//     pick whose only real problem is genuine ambiguity between two-or-
//     more REAL players sharing a surname (not a typo) often still has
//     enough information to safely fill in event_name: if EVERY real
//     candidate for that surname happens to be playing the SAME
//     tournament, that fact doesn't depend on which specific one was
//     meant. Verified directly against real data both ways: several real
//     ambiguous surnames (Sanchez, Harris, Silva, Smith, Paul, Cerundolo,
//     Kichenok, Cash -- each 2 real players) all share exactly one real
//     tournament (Roland Garros) and would correctly get event_name
//     filled in; "Andreeva" and "Jones" (real ambiguous surnames spanning
//     TWO different real tournaments each) correctly decline to guess.
// 26. CONFIRMED FIX, direct follow-up same day, real production report:
//     "Svjada/Cobolli" still showed as unresolved even after Fix #25 --
//     but this isn't the ambiguous-surname case Fix #25 covers, it's a
//     plain typo ("Svjada" for real ATP player "Zachary Svajda") in a
//     TWO-name pick. Confirmed directly against real ESPN data: Zachary
//     Svajda actually played Flavio Cobolli at Roland Garros on exactly
//     this pick's own event_date (2026-06-01) -- fully resolvable, not
//     just a tournament guess, except the code already computed the
//     correct "did you mean" suggestion for its note and then never
//     tried matching with it. Now: when a multi-token pick has one name
//     still unresolved AND at least one OTHER name on the same pick
//     already resolved normally, the missing name's spelling suggestion
//     is tried too -- but ONLY kept if it produces a real shared match
//     with the already-confirmed name (the same match-intersection check
//     already used for two confirmed names), which is independent
//     evidence the correction was right, not a blind guess off edit-
//     distance alone. Deliberately NOT attempted for single-token picks
//     or when every name on a pick is missing -- there's no second name
//     to cross-check against there, same reasoning as Fix #25's scoping.
//     Verified directly against real data, all 5 cases behaving exactly
//     as intended: (1) the real "Svjada/Cobolli" case now fully resolves
//     to the real match, tournament, and start time; (2) a lone
//     single-token typo correctly still declines (no cross-check
//     available); (3) both names typo'd on the same pick correctly still
//     declines (no confirmed anchor); (4) a known-good pair with no typo
//     is unaffected, no regression; (5) the known real "Fonseca/Bolelli"
//     data-error case still correctly fails rather than forcing a match.
// 27. CONFIRMED FIX, direct request: "We could very well pick up a source
//     that calls Cricket or Chinese Basketball or European sports so we
//     should resolve those as there must be an API or source out there
//     to pick these up." Real Cricket schedule coverage added via
//     CricketData.org (api.cricapi.com, free tier, 100 hits/day, real
//     key confirmed directly). Chinese Basketball (CBA) explicitly
//     parked -- real data exists via TheSportsDB (confirmed directly
//     against real match data), but reliable production use needs a
//     $9/month Patreon key, not worth it yet for the single real pick
//     seen so far. Structured as its own top-level branch (see the
//     isCricket branch's own comment for the full architecture --
//     why it can't reuse the generic MLB/NBA/KBO/ESPN pipeline, the
//     series-search query strategy that stays within the tight rate
//     limit, and the same-day-or-later tiebreak it needed, same
//     reasoning as Fix #24). Verified directly against the real key and
//     real data behind this session's own two Cricket picks: "Pakistan"
//     and "Austrailia" (a typo for "Australia") both correctly resolve
//     to the real June 2, 2026 Pakistan vs Australia ODI (the closest
//     same-day-or-later match in the real 3-match series spanning May
//     30-June 4, none of which fall exactly on the picks' June 1
//     event_date) -- including the typo resolving via the same cross-
//     confirmed spelling-correction approach as Fix #26 (the correctly-
//     spelled "Pakistan" pick's own series search surfaces the real
//     Australia matches too, so "Austrailia" -> "Australia" only gets
//     trusted once it's confirmed against that real shared match pool,
//     not a blind guess), and both correctly get home_away set (Pakistan
//     "home", Australia "away") via a "<touring team> tour of <host
//     team>" series-name heuristic, confirmed against the real series
//     name "Australia tour of Pakistan 2026".
// 28. LIKELY FIX, NOT independently re-confirmed (this run comes from
//     inside Supabase's own Edge Function runtime, which can't be tested
//     directly the way everything else in this file was) -- direct real-
//     world report, reproduced twice, not transient: every real Cricket
//     lookup from the live function failed with "Connection reset by
//     peer" at the connect stage. The exact same URLs worked fine in
//     every direct test that verified Fix #27 before shipping -- the one
//     real difference: those tests always sent a browser-like User-Agent
//     header, and this fetch sent none at all. Deno's own default User-
//     Agent is a common trigger for an API's bot-protection/WAF to hard-
//     reset the connection outright instead of responding normally,
//     which matches this exact failure signature. Added a real User-
//     Agent header to both Cricket fetch calls, plus a short retry (in
//     case the real cause turns out to be an intermittent block rather
//     than a consistent one either way). Also fixed a real, separate
//     reporting bug found while looking into this: a single shared error
//     variable meant every unmatched pick's note always showed whichever
//     token's search failed LAST, even when only one token's search
//     actually failed -- now tracked per-token so each pick's note
//     reflects its own real outcome. Needs the project owner to re-run
//     the live check to confirm this actually resolves it.
// 29. CONFIRMED FIX, direct real-world report, treated as serious: a real
//     "Romano" pick (event_date 2026-06-01) had NO real ATP/WTA-tour
//     match anywhere near that date -- the only real "Romano" ESPN had
//     was an UNRELATED tour-level match 18 days later, a different
//     tournament entirely. Direct follow-up confirmed this is systemic,
//     not a one-off: "Challenger matches happen all the time... flagging
//     a dozen tennis picks because someone filled up the entire day's
//     bracket with a tournament ESPN doesn't cover is an issue." Since
//     ESPN has NO Challenger-tour coverage at all (confirmed directly:
//     zero Challenger-named tournaments anywhere in a real 70-day
//     window), a same-surname match found far from the pick's own date
//     is often a coincidentally-named TOUR-level player, not the real
//     (Challenger-level, invisible to this data source) match at all --
//     auto-matching there isn't a helpful guess, it's confidently WRONG
//     data, worse than staying unmatched. See closestTennisMatch's
//     result-handling in the isTennis branch's own `if (matched)` block
//     for the fix: beyond a 2-day gap between the pick's event_date and
//     the real match found, this now stops trusting it as the same event
//     and surfaces what it found as a LEAD for manual verification
//     instead of a confirmed match. Verified directly two ways: (1) the
//     real Romano case (gap +18 days) now correctly declines instead of
//     confidently matching Mallorca; (2) ran this same check against
//     every one of the 24 already-matched real Tennis picks from
//     2026-06-01 -- only 1 exceeds the new 2-day threshold ("Harris
//     Lloyd", 14 days), and that one was independently confirmed correct
//     via direct research earlier this session (a real player, real
//     match, not a coincidental same-name guess), so this threshold
//     doesn't second-guess data already known-good, it just closes the
//     door on the next unverified one. A real, dedicated Tennis API with
//     genuine Challenger coverage (found and priced during this same
//     conversation -- tennis-api.com, ~$10-39/month depending on volume)
//     is the actual long-term fix the project owner wants once budget
//     allows; this is the safety net for in the meantime.
//
// 30. CONFIRMED FIX, direct request 2026-08-14: admin.html's "Find & Update
//     Teams / Tournaments" button already owns Prop team (MLB/NBA/WNBA/NHL,
//     via its own dedicated validate-*-player-txt functions) and Tournament/
//     event_name (Tennis/Soccer/Cricket, via this same function scoped to
//     one sport at a time). "Find & Update Pick Info" (this function called
//     unscoped, every sport) was ALSO writing prop_team and event_name as a
//     side effect of the same MLB/NBA roster lookup and Tennis/Soccer/
//     Cricket match, creating a confusing double-write between two buttons
//     with no way to tell which one "really" owns those fields -- direct
//     concern: "why do we have 2 buttons" once it was clear both touched
//     the same fields. New optional `skipProps=true` query param suppresses
//     ONLY the prop_team write (MLB/NBA roster-lookup branch) and the
//     event_name write (Tennis/Cricket/Soccer match branches) -- everything
//     else (game_start_time, home_away, the underlying roster/match lookups
//     themselves) is untouched, since game_start_time for a Player Prop
//     pick has no other source in this file besides that same roster
//     lookup. admin.html's "Find & Update Pick Info" button now always
//     passes skipProps=true, making it the sole owner of Start Time/
//     Home-Away; "Find & Update Teams / Tournaments" never passes it
//     (default false), staying the sole owner of Prop team/Tournament.
//     NOTE: Tennis/Soccer/Cricket's own tournament MATCH still necessarily
//     finds game_start_time as part of locating the right match (that part
//     was never separable) -- "Find & Update Teams / Tournaments" running
//     first for those three sports has always incidentally set Start Time
//     too, same as before this fix; skipProps only closes the specific
//     prop_team/event_name double-write, not that pre-existing overlap.
//
// 31. THREE separate real bugs found and fixed together, all from a real
//     production run against the 2026-06-02 backlog:
//     (a) CONFIRMED FALSE-POSITIVE MATCH: a real "Boston Red Sox" pick
//         incorrectly matched TWO games, including an unrelated Royals @
//         Reds game. Root cause: normalize() strips spaces, so "Boston Red
//         Sox" becomes "bostonredsox" -- which contains "reds" as a
//         substring purely from the Red/Sox word boundary, and t.name
//         ("Reds") was still being matched via substring containment
//         (`.includes()`), the exact same class of false positive already
//         fixed for abbreviations (Fix #2, "ARI" inside "Mariners") but
//         never extended to the bare mascot name. FIRST PASS moved only
//         t.name to exactNames and still reproduced the bug -- confirmed
//         directly against ESPN's real team objects that shortDisplayName
//         is ALSO often just the bare mascot name (Red Sox's
//         shortDisplayName is literally "Red Sox", Reds' is literally
//         "Reds"), and it was still sitting in the substring-safe list.
//         Corrected: `names` (substring-safe) now holds ONLY location
//         (already gated to unique-today) and the full displayName (city +
//         mascot); `exactNames` holds abbreviation, t.name, AND
//         shortDisplayName. Re-verified with a standalone simulation of the
//         real Red Sox/Reds collision before trusting the fix.
//     (b) CONFIRMED GAP: a pick reading only "Oakland" (the Athletics' old,
//         still-commonly-used city name) had nothing to match against --
//         confirmed directly against ESPN's real team object that
//         location/name/displayName are ALL now just "Athletics", no city
//         at all (the team dropped it after leaving Oakland). Added
//         `athletics: ['oakland', 'oaklandathletics']` to
//         TEAM_NAME_ALIASES, same table Fix #21 built for Wisconsin/
//         Milwaukee.
//     (c) INITIALLY SUSPECTED a duplicate-fetch bug (Naver's API wasn't
//         independently reachable to verify directly) since every KBO
//         matchup that day showed "2 possible games" with identical-
//         looking text. CORRECTED by direct follow-up: KBO teams play
//         daily, and the +/-1-day window (Fix #14, built deliberately for
//         the KST/ET date-crossing case) means a team playing on two real
//         back-to-back days is completely normal, not suspicious -- this
//         wasn't a duplicate-fetch bug at all, see Fix #32 below for the
//         real fix. String(g.gameId) hardening on the dedup kept anyway
//         (harmless, still a reasonable defensive fix regardless). The
//         self-diagnosing start_time addition to the ambiguous-match note
//         stays useful too -- it's what made the real explanation visible.
//
// 32. CONFIRMED FIX, direct follow-up to Fix #31(c) above: KBO's own
//     deliberately-widened +/-1-day window means a team playing on back-
//     to-back real days -- completely normal for KBO's daily schedule --
//     surfaced as "2 possible games matched" with no way to prefer the one
//     that's actually correct, even though one of them usually IS simply
//     right. Direct context for why the entered date is generally
//     trustworthy, not a coin flip: "KBO picks... will come in late at
//     night for the next day as cappers... work systematically and won't
//     bother calling or putting out KBO picks when their morning is trying
//     to build out picks for the earlier games first." Rather than
//     guessing a direction ("always prefer next day"), added a same-
//     date-first tiebreak: when multiple real candidates exist, prefer
//     whichever one's OWN date exactly equals the pick's stated
//     event_date (a stronger, non-directional signal) -- only narrows when
//     exactly one candidate shares that exact date; falls through to the
//     existing ambiguous/unmatched handling unchanged if zero or multiple
//     do, since that's a genuine, real conflict (e.g. an actual same-date
//     doubleheader). Verified with two simulations: the real reported "KT"
//     case (one candidate on 06/01, one on 06/02, target 06/02) correctly
//     resolves to the 06/02 game; a synthetic genuine same-date
//     doubleheader (both candidates dated 06/02) correctly stays flagged
//     ambiguous rather than being incorrectly narrowed.
//
// 33. CONFIRMED FIX, direct follow-up REVERTING Fix #32's auto-narrow:
//     "when a capper sends me a pick at 9pm I'm putting it in for Jun 2.
//     What is to stop this from putting the pick time at 06/02 at 5am when
//     the capper is calling the 06/03 game." KBO games are evening KST
//     starts, which land in EARLY MORNING ET the SAME Korean calendar date
//     -- so a pick received evening ET is almost always for the NEXT US
//     calendar day's game, the OPPOSITE of what Fix #32 assumed ("the
//     entered date is generally reliable"). Worse, for manually-entered/
//     bulk-uploaded historical data there's no reliable received-timestamp
//     signal to lean on at all -- confirmed directly: "nowhere in my
//     manually input data would that match as I put them in at random
//     times." Auto-narrowing on an unreliable signal risked silently
//     writing the WRONG game with schedule_sync_status='matched' and no
//     note -- worse than the ambiguous state it replaced. Reverted the
//     Fix #32 tiebreak entirely (back to always flagging 2+ KBO candidates
//     for manual review), and instead made the note itself do the work:
//     any candidate whose date doesn't match the entered event_date is now
//     surfaced as an explicit "did you mean {date} at {time} ET instead?"
//     suggestion, using Intl.DateTimeFormat with timeZone: 'America/
//     New_York' (correct across the EST/EDT boundary automatically, no
//     hand-rolled offset math -- verified directly against a real example:
//     June 3 18:30 KST correctly formats as "06/03 at 5:30 AM ET"). Direct
//     confirmation this is an acceptable interim state: "we can leave them
//     flagged and I can manually update them for the next day... it will
//     be a few a day but not a dealbreaker for now." A live-transcription-
//     timestamp-based version of this (using the real date_entered value,
//     reliable only for the future live-listener pipeline, not historical/
//     bulk data) was discussed as a possible later refinement, not built.
//
// Deliberately does NOT touch odds/markets data -- that's schedule-sync's
// job for anything within its own window, and closing odds for dates this
// old generally aren't recoverable from any live-odds API regardless of
// provider.
//
// Run it once per date you want to catch up: POST /schedule-sync-backfill?date=2026-06-01
// Optionally add &sport=MLB to run just one sport at a time, or &skipProps=true
// to only touch game_start_time/home_away and never prop_team/event_name.

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

// CONFIRMED FIX, direct real-world report: two consecutive live runs of
// validate-nba-player-txt/validate-wnba-player-txt both failed with "ESPN
// scoreboard request failed" on a date confirmed to have real games (NBA
// Finals Game 2) -- ruled out ESPN being down by fetching the exact same
// URL directly, which succeeded. Same root cause and fix already proven in
// THIS file for CricketData.org (see cricketFetch's own Fix #28 comment
// below): Deno's default fetch() sends no User-Agent header at all, a
// common trigger for an API's bot-protection/WAF to hard-reset the
// connection instead of responding normally. Every ESPN call in this file
// (main scoreboard, Tennis, Soccer, NBA/WNBA rosters) now goes through
// this wrapper instead of a bare fetch() -- applied proactively to the
// ones that hadn't failed yet too, since the root cause is about how
// Deno's Edge Function runtime talks to ESPN, not anything sport-specific.
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

const NAME_SUFFIX_RE = /(jr|sr|ii|iii|iv)$/;
// Direct request 2026-08-28, CONFIRMED REAL BUG found while investigating
// it: this used to call map.set(norm, info) -- a single value overwritten
// on every call. A team playing twice in one day (doubleheader) means
// this runs once per game for the same roster, so every player's entry
// silently landed on whichever game was registered LAST, wrong for
// anyone whose pick was actually the other game. Confirmed directly
// against real ESPN data (Milwaukee @ Kansas City doubleheader,
// 2026-04-04). Now collects every distinct startTime a name is
// registered under; the lookup below only trusts a single-entry match
// automatically, and uses doubleheader_game to pick the right one when
// there are two, instead of ever silently guessing.
function addPropLookupEntry(map: Map<string, { team: string; startTime: string }[]>, key: string, info: { team: string; startTime: string }) {
  const arr = map.get(key) || [];
  if (!arr.some(e => e.startTime === info.startTime)) arr.push(info);
  map.set(key, arr);
}
function registerPlayerName(map: Map<string, { team: string; startTime: string }[]>, name: string, info: { team: string; startTime: string }) {
  const norm = normalize(name);
  addPropLookupEntry(map, norm, info);
  const m = norm.match(NAME_SUFFIX_RE);
  if (m) {
    const stripped = norm.slice(0, norm.length - m[0].length);
    if (stripped.length >= 4) addPropLookupEntry(map, stripped, info);
  }
}

function formatEtDateTime(isoString: string): string {
  const d = new Date(isoString);
  const datePart = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit' }).format(d);
  const timePart = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  return `${datePart} at ${timePart} ET`;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
    }
  }
  return d[m][n];
}

function suggestClosest(rawName: string, candidateDisplayNames: string[]): string | null {
  const norm = normalize(rawName);
  if (!norm || !candidateDisplayNames.length) return null;
  let closest: string | null = null;
  let closestDist = Infinity;
  for (const displayName of candidateDisplayNames) {
    const words = displayName.split(/\s+/).map(normalize).filter(Boolean);
    const candidates = [normalize(displayName), ...words];
    for (const candidate of candidates) {
      const dist = levenshtein(norm, candidate);
      if (dist < closestDist) { closestDist = dist; closest = displayName; }
    }
  }
  const threshold = Math.max(2, Math.ceil(norm.length * 0.3));
  return closestDist <= threshold ? closest : null;
}

function suggestClosestPlayer(rawName: string, candidateNames: string[]): string | null {
  const norm = normalize(rawName);
  if (!norm || !candidateNames.length) return null;
  let closest: string | null = null;
  let closestDist = Infinity;
  for (const candidate of candidateNames) {
    const dist = levenshtein(norm, normalize(candidate));
    if (dist < closestDist) { closestDist = dist; closest = candidate; }
  }
  return closestDist <= 2 ? closest : null;
}

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
  ncaahockey: 'hockey/mens-college-hockey',
  ncaasoftball: 'baseball/college-softball',
  ncaawbasketball: 'basketball/womens-college-basketball',
  ncaawhockey: 'hockey/womens-college-hockey',
  ncaawvolleyball: 'volleyball/womens-college-volleyball',
  ncaawlacrosse: 'lacrosse/womens-college-lacrosse',
  cfl: 'football/cfl',
};

const NO_HOME_AWAY_SPORTS = ['tennis', 'golf', 'mma', 'boxing'];

const NO_SIDE_BET_TYPES = ['no run first inning', 'yes run first inning', 'both teams to score'];
function betTypeUsesHomeAway(betTypeName: string): boolean {
  const n = (betTypeName || '').toLowerCase().trim();
  if (n.includes('parlay')) return false;
  if (n.includes('over/under')) return false;
  if (n === 'total') return false;
  if (NO_SIDE_BET_TYPES.includes(n)) return false;
  return true;
}

const SOCCER_COMPETITION_SLUGS = [
  'eng.1', 'esp.1', 'ger.1', 'ita.1', 'fra.1',
  'uefa.champions', 'uefa.europa', 'uefa.europa.conf',
  'concacaf.champions', 'conmebol.libertadores', 'conmebol.sudamericana',
  'usa.1', 'mex.1',
  'fifa.friendly', 'fifa.world',
  'fifa.worldq.uefa', 'fifa.worldq.concacaf', 'fifa.worldq.conmebol', 'fifa.worldq.afc', 'fifa.worldq.caf',
  'uefa.euro', 'conmebol.america', 'concacaf.gold',
];

const KBO_TEAM_NAMES: Record<string, { location: string; name: string }> = {
  HH: { location: 'Hanwha', name: 'Eagles' },
  HT: { location: 'KIA', name: 'Tigers' },
  KT: { location: 'KT', name: 'Wiz' },
  LG: { location: 'LG', name: 'Twins' },
  LT: { location: 'Lotte', name: 'Giants' },
  NC: { location: 'NC', name: 'Dinos' },
  OB: { location: 'Doosan', name: 'Bears' },
  SK: { location: 'SSG', name: 'Landers' },
  SS: { location: 'Samsung', name: 'Lions' },
  WO: { location: 'Kiwoom', name: 'Heroes' },
};

const TEAM_NAME_ALIASES: Record<string, string[]> = {
  milwaukee: ['wisconsin', 'wisconsinmilwaukee', 'uwmilwaukee', 'uwm', 'milwuakee'],
  cincinnati: ['cincinatti'],
  athletics: ['oakland', 'oaklandathletics'],
};

const TEAM_ABBREVIATION_ALIASES: Record<string, string[]> = {
  laa: ['laangels'],
  lad: ['ladodgers'],
};

const TENNIS_TOURS = ['atp', 'wta'];

function splitTennisNames(selection: string): string[] {
  return selection.split(/\/| over | vs\.? /i).map(s => s.trim()).filter(Boolean);
}

function suggestClosestTennisPlayer(rawName: string, candidateNames: string[]): string | null {
  const norm = normalize(rawName);
  if (!norm || !candidateNames.length) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of candidateNames) {
    const fullDist = levenshtein(norm, normalize(candidate));
    const fullThreshold = Math.max(2, Math.ceil(norm.length * 0.3));
    if (fullDist <= fullThreshold && fullDist < bestDist) {
      best = candidate; bestDist = fullDist;
    }
    const words = candidate.trim().split(/\s+/);
    if (words.length > 1) {
      const surnameDist = levenshtein(norm, normalize(words[words.length - 1]));
      if (surnameDist <= 2 && surnameDist < bestDist) {
        best = candidate; bestDist = surnameDist;
      }
    }
  }
  return best;
}

async function getCandidateQueryDates(
  db: (path: string, options?: RequestInit) => Promise<any>,
  sportId: string, targetDate: string, bufferDays: number
): Promise<string[]> {
  const dates = new Set<string>([targetDate.replace(/-/g, '')]);
  try {
    const target = new Date(targetDate + 'T00:00:00Z').getTime();
    const bufferMs = bufferDays * 24 * 60 * 60 * 1000;
    const windowStart = new Date(target - bufferMs).toISOString().slice(0, 10);
    const windowEnd = new Date(target + bufferMs).toISOString().slice(0, 10);
    const candidates = await db(
      `tournaments?select=start_date,end_date&sport_id=eq.${sportId}&start_date=lte.${windowEnd}&end_date=gte.${windowStart}`
    );
    for (const t of (candidates || [])) {
      if (!t.start_date) continue;
      const start = new Date(t.start_date + 'T00:00:00Z').getTime();
      const end = new Date((t.end_date || t.start_date) + 'T00:00:00Z').getTime();
      const midpoint = new Date(start + (end - start) / 2);
      dates.add(midpoint.toISOString().slice(0, 10).replace(/-/g, ''));
    }
  } catch {
    // Best-effort enhancement only -- see comment above.
  }
  return [...dates];
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
    const cricketApiKey = Deno.env.get('CRICKET_API_KEY');

    const url = new URL(req.url);
    const targetDate = url.searchParams.get('date');
    const sportFilter = url.searchParams.get('sport');
    const skipProps = url.searchParams.get('skipProps') === 'true';
    if (!targetDate) {
      return new Response(JSON.stringify({ error: 'Missing required "date" query parameter, e.g. ?date=2026-06-01' }), {
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

    function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

    const espnDate = targetDate.replace(/-/g, '');

    const overall = {
      date: targetDate,
      sports_processed: [] as any[],
      sports_skipped: [] as any[]
    };

    for (const ourSport of ourSports) {
      const sportNormName = normalize(ourSport.name);
      const isSoccer = sportNormName === 'soccer';
      const isTennis = sportNormName === 'tennis';
      const isKBO = sportNormName === 'kbo';
      const isCricket = sportNormName === 'cricket';
      const espnPath = ESPN_SPORT_MAP[sportNormName];
      if (!isSoccer && !isTennis && !isKBO && !isCricket && !espnPath) {
        const needsHomeAwayHere = !NO_HOME_AWAY_SPORTS.includes(sportNormName);
        const unsupportedPicks = await db(
          `picks?select=id,selection,home_away,game_start_time,bet_types(name,uses_prop_fields)&sport_id=eq.${ourSport.id}&event_date=eq.${targetDate}&or=(schedule_sync_status.is.null,schedule_sync_status.neq.matched)`
        );
        const applicable = (unsupportedPicks || []).filter((p: any) => {
          const betTypeName = (p.bet_types && p.bet_types.name || '').toLowerCase();
          const usesProp = p.bet_types && p.bet_types.uses_prop_fields;
          if (betTypeName.includes('parlay')) return false;
          const missingHomeAway = needsHomeAwayHere && !usesProp && !p.home_away;
          const missingStartTime = !p.game_start_time;
          return missingHomeAway || missingStartTime;
        });
        for (const p of applicable) {
          const betTypeName = (p.bet_types && p.bet_types.name || '').toLowerCase();
          const usesProp = p.bet_types && p.bet_types.uses_prop_fields;
          const missingParts: string[] = [];
          if (needsHomeAwayHere && !usesProp && !p.home_away) missingParts.push('home/away');
          if (!p.game_start_time) missingParts.push('start time');
          const note = `No automated schedule source available for ${ourSport.name} -- ${missingParts.join(' and ')} needs manual entry.`;
          await db(`picks?id=eq.${p.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'not_supported', schedule_sync_note: note }) });
        }
        overall.sports_skipped.push({ sport: ourSport.name, reason: 'No ESPN scoreboard mapping for this sport.', picks_flagged: applicable.length });
        continue;
      }

      try {
        await sleep(500);

        if (isTennis) {
          const seenMatchIds = new Set<string>();
          const tennisMatches: { matchId: string; startTime: string; playerNames: string[]; matchup: string; tournamentName?: string | null }[] = [];

          const candidateDates = await getCandidateQueryDates(db, ourSport.id, targetDate, 30);
          const tourResults = await Promise.allSettled(
            candidateDates.flatMap(d => TENNIS_TOURS.map(tour =>
              espnFetch(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${d}`).then(r => r.ok ? r.json() : null)
            ))
          );
          for (const result of tourResults) {
            if (result.status !== 'fulfilled' || !result.value) continue;
            const tournaments = result.value.events || [];
            for (const tournament of tournaments) {
              for (const grouping of (tournament.groupings || [])) {
                for (const comp of (grouping.competitions || [])) {
                  const matchId = `${tournament.id}-${comp.id}`;
                  if (seenMatchIds.has(matchId)) continue;
                  seenMatchIds.add(matchId);
                  const names: string[] = [];
                  for (const competitor of (comp.competitors || [])) {
                    if (competitor.athlete && competitor.athlete.displayName) {
                      names.push(competitor.athlete.displayName);
                    } else if (competitor.roster && Array.isArray(competitor.roster.athletes)) {
                      for (const a of competitor.roster.athletes) {
                        if (a.displayName) names.push(a.displayName);
                      }
                    }
                  }
                  if (!names.length) continue;
                  tennisMatches.push({ matchId, startTime: comp.date, playerNames: names, matchup: names.join(' / '), tournamentName: tournament.name || null });
                }
              }
            }
          }

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
          const tennisPlayerLookup = new Map<string, typeof tennisMatches>();
          const tennisPlayerDisplayNames: string[] = [];
          function addToTennisLookup(key: string, match: typeof tennisMatches[0]) {
            const existing = tennisPlayerLookup.get(key) || [];
            if (!existing.includes(match)) existing.push(match);
            tennisPlayerLookup.set(key, existing);
          }
          for (const m of tennisMatches) {
            for (const n of m.playerNames) {
              tennisPlayerDisplayNames.push(n);
              addToTennisLookup(normalize(n), m);
              const words = n.trim().split(/\s+/);
              if (words.length > 1) {
                const surname = normalize(words[words.length - 1]);
                if ((surnameToPlayers.get(surname)?.size || 0) === 1) addToTennisLookup(surname, m);
              }
            }
          }
          const reversedNameSources = new Map<string, Set<string>>();
          for (const m of tennisMatches) {
            for (const n of m.playerNames) {
              const words = n.trim().split(/\s+/);
              if (words.length === 2) {
                const reversedKey = normalize(`${words[1]} ${words[0]}`);
                if (!reversedNameSources.has(reversedKey)) reversedNameSources.set(reversedKey, new Set());
                reversedNameSources.get(reversedKey)!.add(normalize(n));
              }
            }
          }
          for (const m of tennisMatches) {
            for (const n of m.playerNames) {
              const words = n.trim().split(/\s+/);
              if (words.length === 2) {
                const reversedKey = normalize(`${words[1]} ${words[0]}`);
                const sources = reversedNameSources.get(reversedKey);
                if (sources && sources.size === 1 && !tennisPlayerLookup.has(reversedKey)) {
                  addToTennisLookup(reversedKey, m);
                }
              }
            }
          }
          const tennisSurnameAllCandidates = new Map<string, typeof tennisMatches>();
          for (const m of tennisMatches) {
            for (const n of m.playerNames) {
              const words = n.trim().split(/\s+/);
              if (words.length > 1) {
                const surname = normalize(words[words.length - 1]);
                const existing = tennisSurnameAllCandidates.get(surname) || [];
                if (!existing.includes(m)) existing.push(m);
                tennisSurnameAllCandidates.set(surname, existing);
              }
            }
          }
          function closestTennisMatch(candidates: typeof tennisMatches, targetDateStr: string): typeof tennisMatches[0] {
            const sameOrLater = candidates.filter(c => (c.startTime || '').slice(0, 10) >= targetDateStr);
            const pool = sameOrLater.length ? sameOrLater : candidates;
            const targetMs = new Date(targetDateStr + 'T12:00:00Z').getTime();
            let best = pool[0];
            let bestDiff = Math.abs(new Date(best.startTime).getTime() - targetMs);
            for (const cand of pool.slice(1)) {
              const diff = Math.abs(new Date(cand.startTime).getTime() - targetMs);
              if (diff < bestDiff) { best = cand; bestDiff = diff; }
            }
            return best;
          }

          const allTennisPicks = await db(
            `picks?select=id,selection,prop_player,bet_type_id,event_name,bet_types(name,uses_prop_fields)&sport_id=eq.${ourSport.id}&event_date=eq.${targetDate}&or=(schedule_sync_status.is.null,schedule_sync_status.neq.matched)`
          );
          const tennisPicks = (allTennisPicks || []).filter((p: any) => {
            const betTypeName = (p.bet_types && p.bet_types.name || '').toLowerCase();
            return !betTypeName.includes('parlay');
          });

          const tennisSportResult = {
            sport: ourSport.name, matches_found: tennisMatches.length,
            matched: [] as any[], unmatched: [] as any[]
          };

          for (const pick of tennisPicks) {
            const isProp = pick.bet_types && pick.bet_types.uses_prop_fields;
            const tokens = isProp
              ? (pick.prop_player ? splitTennisNames(pick.prop_player) : [])
              : splitTennisNames(pick.selection);

            if (!tokens.length) {
              const note = `This pick has no player name recorded -- can't be matched to a match without one.`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
              tennisSportResult.unmatched.push({ id: pick.id, selection: '(no player name set)', reason: note });
              continue;
            }

            const resolvedLists = tokens.map(t => tennisPlayerLookup.get(normalize(t)) || []);
            if (tokens.length > 1) {
              for (let i = 0; i < tokens.length; i++) {
                if (resolvedLists[i].length) continue;
                const fallback = tennisSurnameAllCandidates.get(normalize(tokens[i]));
                if (fallback && fallback.length) resolvedLists[i] = fallback;
              }
            }
            const spellingCorrections: Record<string, string> = {};
            {
              const stillMissingIdx = tokens.map((_, i) => i).filter(i => resolvedLists[i].length === 0);
              if (tokens.length > 1 && stillMissingIdx.length && stillMissingIdx.length < tokens.length) {
                const correctedLists = resolvedLists.slice();
                let allSuggested = true;
                for (const i of stillMissingIdx) {
                  const suggestion = suggestClosestTennisPlayer(tokens[i], tennisPlayerDisplayNames);
                  const suggestedCandidates = suggestion ? (tennisPlayerLookup.get(normalize(suggestion)) || []) : [];
                  if (!suggestedCandidates.length) { allSuggested = false; break; }
                  correctedLists[i] = suggestedCandidates;
                  spellingCorrections[tokens[i]] = suggestion as string;
                }
                if (allSuggested) {
                  let commonIds = new Set(correctedLists[0].map(m => m.matchId));
                  for (const lst of correctedLists.slice(1)) {
                    const ids = new Set(lst.map(m => m.matchId));
                    commonIds = new Set([...commonIds].filter(id => ids.has(id)));
                  }
                  if (commonIds.size) {
                    for (const i of stillMissingIdx) resolvedLists[i] = correctedLists[i];
                  } else {
                    for (const k of Object.keys(spellingCorrections)) delete spellingCorrections[k];
                  }
                } else {
                  for (const k of Object.keys(spellingCorrections)) delete spellingCorrections[k];
                }
              }
            }
            const missingTokens = tokens.filter((t, i) => resolvedLists[i].length === 0);

            if (missingTokens.length) {
              const suggestions = missingTokens
                .map(t => { const s = suggestClosestTennisPlayer(t, tennisPlayerDisplayNames); return s ? `"${t}" -> "${s}"` : null; })
                .filter(Boolean);
              let ambiguousTournament: string | null = null;
              if (tokens.length === 1 && !pick.event_name) {
                const ambiguousCandidates = tennisSurnameAllCandidates.get(normalize(tokens[0]));
                if (ambiguousCandidates && ambiguousCandidates.length) {
                  const tournamentNames = new Set(ambiguousCandidates.map(m => m.tournamentName).filter(Boolean));
                  if (tournamentNames.size === 1) ambiguousTournament = [...tournamentNames][0] as string;
                }
              }
              const updatePayload: Record<string, unknown> = { schedule_sync_status: 'unmatched' };
              let note = `Could not find ${missingTokens.map(t => `"${t}"`).join(', ')} on any ATP/WTA match near ${targetDate} (checked that date plus any real tournament windows within 30 days of it) -- may be a name spelling issue, or the tournament may not be in your tournaments table yet.${suggestions.length ? ' ' + suggestions.join(', ') + '.' : ''}`;
              if (ambiguousTournament && !skipProps) {
                updatePayload.event_name = ambiguousTournament;
                note += ` Event name set to "${ambiguousTournament}" anyway -- every real player with this name is playing that same tournament, even though which specific one (and their exact match/start time) can't be told apart from the name alone.`;
              }
              updatePayload.schedule_sync_note = note;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify(updatePayload) });
              tennisSportResult.unmatched.push({ id: pick.id, selection: isProp ? pick.prop_player : pick.selection, reason: note, event_name: ambiguousTournament });
              continue;
            }

            let matched: typeof tennisMatches[0] | null = null;
            if (tokens.length === 1) {
              const candidates = resolvedLists[0];
              const singles = candidates.filter(m => m.playerNames.length === 2);
              const pool = singles.length ? singles : candidates;
              if (pool.length) matched = closestTennisMatch(pool, targetDate);
            } else {
              let commonIds = new Set(resolvedLists[0].map(m => m.matchId));
              for (const lst of resolvedLists.slice(1)) {
                const ids = new Set(lst.map(m => m.matchId));
                commonIds = new Set([...commonIds].filter(id => ids.has(id)));
              }
              if (commonIds.size) {
                const candidateMatches = resolvedLists[0].filter(m => commonIds.has(m.matchId));
                matched = closestTennisMatch(candidateMatches, targetDate);
              }
            }

            if (matched) {
              const matchedDateStr = (matched.startTime || '').slice(0, 10);
              const dateDiffers = !!matchedDateStr && matchedDateStr !== targetDate;
              const gapDays = matchedDateStr
                ? Math.round((new Date(matchedDateStr + 'T00:00:00Z').getTime() - new Date(targetDate + 'T00:00:00Z').getTime()) / 86400000)
                : 0;
              const TENNIS_DATE_GAP_SAFETY_DAYS = 2;
              if (Math.abs(gapDays) > TENNIS_DATE_GAP_SAFETY_DAYS) {
                const note = `Found a same-name match on ${matchedDateStr} (${matched.matchup}, ${matched.tournamentName || 'tournament unknown'}), but that's ${Math.abs(gapDays)} days from this pick's own event_date (${targetDate}) -- too far to auto-confirm this is the same match. This may be a real event outside this system's data source (e.g. a Challenger/lower-tier tournament ESPN doesn't cover), not the tour-level match found here. Needs manual verification before trusting this date.`;
                await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
                tennisSportResult.unmatched.push({ id: pick.id, selection: isProp ? pick.prop_player : pick.selection, reason: note });
                continue;
              }
              const correctionNote = Object.keys(spellingCorrections).length
                ? `Auto-corrected spelling: ${Object.entries(spellingCorrections).map(([k, v]) => `"${k}" -> "${v}"`).join(', ')} -- confirmed by a real shared match with the other name on this pick, but please double-check this was the intended player. `
                : '';
              const dateDifferNote = dateDiffers
                ? `Found on ${matchedDateStr} -- this pick's event_date is currently ${targetDate}. Consider correcting event_date to match; game_start_time has already been set to the real value.`
                : '';
              const note = (correctionNote || dateDifferNote) ? `${correctionNote}${dateDifferNote}`.trim() : null;
              const updatePayload: Record<string, unknown> = {
                game_start_time: matched.startTime, schedule_sync_status: 'matched', schedule_sync_note: note
              };
              if (!skipProps && !pick.event_name && matched.tournamentName) updatePayload.event_name = matched.tournamentName;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify(updatePayload) });
              tennisSportResult.matched.push({ id: pick.id, selection: isProp ? pick.prop_player : pick.selection, start_time: matched.startTime, matchup: matched.matchup, date_corrected: dateDiffers, event_name: updatePayload.event_name || pick.event_name || null });
            } else {
              const note = `"${tokens.join(' / ')}" -- each name was found on today's schedule, but not clearly in the same match (a name matched more than one of today's matches, or the names named don't share a match) -- needs manual review.`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
              tennisSportResult.unmatched.push({ id: pick.id, selection: isProp ? pick.prop_player : pick.selection, reason: note });
            }
          }

          overall.sports_processed.push(tennisSportResult);
          continue;
        }

        if (isCricket) {
          const cricketPicks = ((await db(
            `picks?select=id,selection,prop_player,bet_type_id,event_name,bet_types(name,uses_prop_fields)&sport_id=eq.${ourSport.id}&event_date=eq.${targetDate}&or=(schedule_sync_status.is.null,schedule_sync_status.neq.matched)`
          )) || []).filter((p: any) => {
            const betTypeName = (p.bet_types && p.bet_types.name || '').toLowerCase();
            return !betTypeName.includes('parlay');
          });

          const cricketSportResult = {
            sport: ourSport.name, matches_found: 0,
            matched: [] as any[], unmatched: [] as any[]
          };

          if (!cricketPicks.length) {
            overall.sports_processed.push(cricketSportResult);
            continue;
          }

          if (!cricketApiKey) {
            for (const p of cricketPicks) {
              const note = `Cricket schedule lookup is configured but CRICKET_API_KEY isn't set as a secret on this function yet -- add it, then re-run.`;
              await db(`picks?id=eq.${p.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
              cricketSportResult.unmatched.push({ id: p.id, selection: p.selection || p.prop_player, reason: note });
            }
            overall.sports_processed.push(cricketSportResult);
            continue;
          }

          const cricketTokens = [...new Set(cricketPicks.map((p: any) => (p.selection || p.prop_player || '').trim()).filter(Boolean))];

          const CRICKET_DATE_BUFFER_DAYS = 30;
          const targetMs = new Date(targetDate + 'T12:00:00Z').getTime();

          function parseSeriesDate(dateStr: string, fallbackYear: string): string | null {
            if (!dateStr) return null;
            if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
            const parsed = new Date(`${dateStr} ${fallbackYear}`);
            if (isNaN(parsed.getTime())) return null;
            return parsed.toISOString().slice(0, 10);
          }

          async function cricketFetch(url: string, attempts = 3): Promise<Response> {
            let lastErr: unknown;
            for (let i = 0; i < attempts; i++) {
              try {
                return await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CoreBettingSolutions-ScheduleSync/1.0)' } });
              } catch (e) {
                lastErr = e;
                if (i < attempts - 1) await sleep(500 * (i + 1));
              }
            }
            throw lastErr;
          }

          const seenSeriesIds = new Set<string>();
          const cricketSearchErrors = new Map<string, string>();

          for (const token of cricketTokens) {
            try {
              const seriesRes = await cricketFetch(`https://api.cricapi.com/v1/series?apikey=${cricketApiKey}&offset=0&search=${encodeURIComponent(token)}`);
              if (!seriesRes.ok) { cricketSearchErrors.set(token, `Series search failed (${seriesRes.status})`); continue; }
              const seriesData = await seriesRes.json();
              if (seriesData.status !== 'success') { cricketSearchErrors.set(token, seriesData.status || 'series search error'); continue; }
              for (const s of seriesData.data || []) {
                if (seenSeriesIds.has(s.id)) continue;
                const startYear = (s.startDate || '').slice(0, 4) || String(new Date(targetDate + 'T00:00:00Z').getUTCFullYear());
                const startIso = parseSeriesDate(s.startDate, startYear);
                if (!startIso) continue;
                const endIso = parseSeriesDate(s.endDate, startYear) || startIso;
                const startMs = new Date(startIso + 'T00:00:00Z').getTime();
                const endMs = new Date(endIso + 'T00:00:00Z').getTime();
                const bufferMs = CRICKET_DATE_BUFFER_DAYS * 24 * 60 * 60 * 1000;
                if (targetMs < startMs - bufferMs || targetMs > endMs + bufferMs) continue;
                seenSeriesIds.add(s.id);
              }
            } catch (e) {
              cricketSearchErrors.set(token, (e as Error).message);
            }
            await sleep(300);
          }

          let cricketInfoError: string | null = null;
          const cricketMatches: { matchId: string; startTime: string; teamNames: string[]; seriesName: string }[] = [];
          for (const seriesId of seenSeriesIds) {
            try {
              const infoRes = await cricketFetch(`https://api.cricapi.com/v1/series_info?apikey=${cricketApiKey}&id=${seriesId}`);
              if (!infoRes.ok) { cricketInfoError = `Series info failed (${infoRes.status})`; continue; }
              const infoData = await infoRes.json();
              if (infoData.status !== 'success') { cricketInfoError = infoData.status || 'series info error'; continue; }
              const seriesName = (infoData.data && infoData.data.info && infoData.data.info.name) || '';
              const matchList = (infoData.data && infoData.data.matchList) || [];
              for (const m of matchList) {
                if (!m.dateTimeGMT || !Array.isArray(m.teams) || m.teams.length !== 2) continue;
                cricketMatches.push({ matchId: m.id, startTime: m.dateTimeGMT + 'Z', teamNames: m.teams, seriesName });
              }
            } catch (e) {
              cricketInfoError = (e as Error).message;
            }
            await sleep(300);
          }

          cricketSportResult.matches_found = cricketMatches.length;
          const cricketTeamDisplayNames = [...new Set(cricketMatches.flatMap(m => m.teamNames))];

          function findCricketCandidates(rawName: string) {
            const norm = normalize(rawName);
            const exact = cricketMatches.filter(m => m.teamNames.some(t => normalize(t) === norm));
            if (exact.length) return exact;
            return cricketMatches.filter(m => m.teamNames.some(t => normalize(t).includes(norm) || norm.includes(normalize(t))));
          }

          function closestCricketMatch(candidates: typeof cricketMatches, targetDateStr: string) {
            const sameOrLater = candidates.filter(c => (c.startTime || '').slice(0, 10) >= targetDateStr);
            const pool = sameOrLater.length ? sameOrLater : candidates;
            const tMs = new Date(targetDateStr + 'T12:00:00Z').getTime();
            let best = pool[0];
            let bestDiff = Math.abs(new Date(best.startTime).getTime() - tMs);
            for (const cand of pool.slice(1)) {
              const diff = Math.abs(new Date(cand.startTime).getTime() - tMs);
              if (diff < bestDiff) { best = cand; bestDiff = diff; }
            }
            return best;
          }

          for (const pick of cricketPicks) {
            const isProp = pick.bet_types && pick.bet_types.uses_prop_fields;
            if (isProp) {
              const note = `No player-level Cricket data source is built yet -- only team-level schedule lookup exists so far. Start time needs manual entry.`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'not_supported', schedule_sync_note: note }) });
              cricketSportResult.unmatched.push({ id: pick.id, selection: pick.prop_player, reason: note });
              continue;
            }
            const rawName = (pick.selection || '').trim();
            if (!rawName) {
              const note = `This pick has no selection recorded -- can't be matched to a match without one.`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
              cricketSportResult.unmatched.push({ id: pick.id, selection: '(none)', reason: note });
              continue;
            }
            let candidates = findCricketCandidates(rawName);
            let usedSuggestion: string | null = null;
            if (!candidates.length) {
              const suggestion = suggestClosest(rawName, cricketTeamDisplayNames);
              if (suggestion) {
                const suggestedCandidates = findCricketCandidates(suggestion);
                if (suggestedCandidates.length) { candidates = suggestedCandidates; usedSuggestion = suggestion; }
              }
            }
            if (!candidates.length) {
              const suggestion = suggestClosest(rawName, cricketTeamDisplayNames);
              const ownError = cricketSearchErrors.get(rawName) || cricketInfoError;
              const note = `Could not find "${rawName}" on any Cricket series covering ${targetDate} (checked matching series within ${CRICKET_DATE_BUFFER_DAYS} days of it)${ownError ? ` -- a lookup hit an error: ${ownError}` : ''}.${suggestion ? ` "${rawName}" -> "${suggestion}".` : ''}`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
              cricketSportResult.unmatched.push({ id: pick.id, selection: rawName, reason: note });
              continue;
            }
            const matched = closestCricketMatch(candidates, targetDate);
            const matchedDateStr = (matched.startTime || '').slice(0, 10);
            const dateDiffers = !!matchedDateStr && matchedDateStr !== targetDate;
            const correctionNote = usedSuggestion ? `Auto-corrected spelling: "${rawName}" -> "${usedSuggestion}" -- confirmed by a real match on the covering series, but please double-check this was the intended team. ` : '';
            const dateDifferNote = dateDiffers ? `Found on ${matchedDateStr} -- this pick's event_date is currently ${targetDate}. Consider correcting event_date to match; game_start_time has already been set to the real value.` : '';
            const note = (correctionNote || dateDifferNote) ? `${correctionNote}${dateDifferNote}`.trim() : null;

            const betTypeName = (pick.bet_types && pick.bet_types.name) || '';
            let homeAway: string | null = null;
            if (betTypeUsesHomeAway(betTypeName)) {
              const tourMatch = matched.seriesName.match(/^(.+?)\s+tour of\s+(.+?)(?:,|\s+\d{4}|$)/i);
              if (tourMatch) {
                const touring = normalize(tourMatch[1]);
                const host = normalize(tourMatch[2]);
                const rawNorm = normalize(rawName);
                const suggNorm = usedSuggestion ? normalize(usedSuggestion) : null;
                if (rawNorm === host || suggNorm === host) homeAway = 'home';
                else if (rawNorm === touring || suggNorm === touring) homeAway = 'away';
              }
            }

            const updatePayload: Record<string, unknown> = {
              game_start_time: matched.startTime, schedule_sync_status: 'matched', schedule_sync_note: note
            };
            if (homeAway) updatePayload.home_away = homeAway;
            if (!skipProps && !pick.event_name && matched.seriesName) updatePayload.event_name = matched.seriesName;
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify(updatePayload) });
            cricketSportResult.matched.push({
              id: pick.id, selection: rawName, start_time: matched.startTime,
              matchup: matched.teamNames.join(' vs '), date_corrected: dateDiffers,
              home_away: homeAway, event_name: updatePayload.event_name || pick.event_name || null
            });
          }

          overall.sports_processed.push(cricketSportResult);
          continue;
        }

        let games: any[];
        if (isSoccer) {
          const candidateDates = await getCandidateQueryDates(db, ourSport.id, targetDate, 30);
          const competitionResults = await Promise.allSettled(
            candidateDates.flatMap(d => SOCCER_COMPETITION_SLUGS.map(slug =>
              espnFetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${d}`).then(r => r.ok ? r.json() : null)
            ))
          );
          const seenEventIds = new Set<string>();
          games = [];
          for (const result of competitionResults) {
            if (result.status === 'fulfilled' && result.value && Array.isArray(result.value.events)) {
              const competitionName = (result.value.leagues && result.value.leagues[0] && result.value.leagues[0].name) || null;
              for (const ev of result.value.events) {
                if (seenEventIds.has(ev.id)) continue;
                seenEventIds.add(ev.id);
                ev._competitionName = competitionName;
                games.push(ev);
              }
            }
          }
        } else if (isKBO) {
          const kboDates = [-1, 0, 1].map(offset => {
            const d = new Date(targetDate + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + offset);
            return d.toISOString().slice(0, 10);
          });
          const kboResults = await Promise.allSettled(
            kboDates.map(d =>
              fetch(`https://api-gw.sports.naver.com/schedule/games?fields=basic&fromDate=${d}&toDate=${d}&upperCategoryId=kbaseball&categoryId=kbo`)
                .then(r => r.ok ? r.json() : null)
            )
          );
          const seenGameIds = new Set<string>();
          games = [];
          for (const result of kboResults) {
            if (result.status !== 'fulfilled' || !result.value) continue;
            const kboGames = (result.value.result && result.value.result.games) || [];
            for (const g of kboGames) {
              if (!g.gameId || !g.gameDateTime || !g.homeTeamCode || !g.awayTeamCode) continue;
              const gameIdKey = String(g.gameId);
              if (seenGameIds.has(gameIdKey)) continue;
              seenGameIds.add(gameIdKey);
              const home = KBO_TEAM_NAMES[g.homeTeamCode];
              const away = KBO_TEAM_NAMES[g.awayTeamCode];
              if (!home || !away) continue;
              const startTimeUtc = new Date(g.gameDateTime + '+09:00').toISOString();
              function teamShape(loc: string, name: string) {
                return { location: loc, name, displayName: `${loc} ${name}`, shortDisplayName: `${loc} ${name}` };
              }
              games.push({
                id: g.gameId,
                date: startTimeUtc,
                competitions: [{
                  competitors: [
                    { homeAway: 'home', team: teamShape(home.location, home.name) },
                    { homeAway: 'away', team: teamShape(away.location, away.name) }
                  ]
                }]
              });
            }
          }
        } else {
          const eventsRes = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${espnDate}`);
          if (!eventsRes.ok) {
            overall.sports_processed.push({ sport: ourSport.name, error: `ESPN request failed (${eventsRes.status})` });
            continue;
          }
          const eventsData = await eventsRes.json();
          games = eventsData.events || [];
        }

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
        const allTeamDisplayNamesToday = [...new Set(allTeamsToday.map(t => t.displayName).filter(Boolean))];

        const gameEntries = games.map((e: any) => {
          const competitors = (e.competitions && e.competitions[0] && e.competitions[0].competitors) || [];
          const home = competitors.find((c: any) => c.homeAway === 'home');
          const away = competitors.find((c: any) => c.homeAway === 'away');

          function variantsFor(c: any) {
            if (!c || !c.team) return null;
            const t = c.team;
            const bareNameIsUnique = t.location && (bareNameCounts.get(normalize(t.location)) || 0) <= 1;
            const names = [bareNameIsUnique ? t.location : null, t.displayName]
              .filter(Boolean).map(normalize);
            const aliasKey = t.location ? normalize(t.location) : null;
            if (aliasKey && TEAM_NAME_ALIASES[aliasKey]) names.push(...TEAM_NAME_ALIASES[aliasKey]);
            const abbrKey = t.abbreviation ? normalize(t.abbreviation) : null;
            if (abbrKey && TEAM_ABBREVIATION_ALIASES[abbrKey]) names.push(...TEAM_ABBREVIATION_ALIASES[abbrKey]);
            const exactNames = [t.abbreviation, t.name, t.shortDisplayName].filter(Boolean).map(normalize);
            return { is_home: c.homeAway === 'home', names, exactNames };
          }

          const homeV = variantsFor(home);
          const awayV = variantsFor(away);
          const matchup = (home && away) ? `${away.team.displayName} @ ${home.team.displayName}` : 'unknown matchup';

          return {
            event_id: e.id,
            start_time: e.date,
            variants: [homeV, awayV].filter(Boolean),
            matchup,
            competition_name: e._competitionName || null
          };
        });

        function findMatchingGames(teamStr: string) {
          const norm = normalize(teamStr);
          const matches: { game: typeof gameEntries[0]; isHome: boolean }[] = [];
          for (const game of gameEntries) {
            for (const variant of game.variants) {
              const hit = variant.names.some((n: string) => n === norm || n.includes(norm) || norm.includes(n))
                || variant.exactNames.some((n: string) => n === norm);
              if (hit) { matches.push({ game, isHome: variant.is_home }); break; }
            }
          }
          return matches;
        }

        const propLookup = new Map<string, { team: string; startTime: string }[]>();
        const propDisplayNames: string[] = [];
        let propLookupStatus = 'not_applicable';

        if (sportNormName === 'mlb') {
          try {
            const mlbScheduleRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${targetDate}`);
            if (mlbScheduleRes.ok) {
              const mlbScheduleData = await mlbScheduleRes.json();
              const mlbGames = (mlbScheduleData.dates && mlbScheduleData.dates[0] && mlbScheduleData.dates[0].games) || [];
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
                teamGamePairs.map(t => fetch(`https://statsapi.mlb.com/api/v1/teams/${t.teamId}/roster?rosterType=active&date=${targetDate}`).then(r => r.ok ? r.json() : null))
              );
              for (let i = 0; i < teamGamePairs.length; i++) {
                const result = rosterResults[i];
                const t = teamGamePairs[i];
                if (result.status !== 'fulfilled' || !result.value) continue;
                const roster = result.value.roster || [];
                for (const r of roster) {
                  const name = r.person && r.person.fullName;
                  if (name) { registerPlayerName(propLookup, name, { team: t.teamName, startTime: t.startTime }); propDisplayNames.push(name); }
                }
              }
              propLookupStatus = propLookup.size > 0 ? 'built' : 'built_but_empty';
            } else {
              propLookupStatus = `schedule_fetch_failed (status ${mlbScheduleRes.status})`;
            }
          } catch (e) {
            propLookupStatus = `build_threw_error: ${String(e)}`;
          }
        } else if (sportNormName === 'nba' || sportNormName === 'wnba') {
          const espnRosterSportPath = sportNormName === 'wnba' ? 'basketball/wnba' : 'basketball/nba';
          const teamsToday = new Map<string, { teamName: string; startTime: string }>();
          for (const g of games) {
            const competitors = (g.competitions && g.competitions[0] && g.competitions[0].competitors) || [];
            for (const c of competitors) {
              if (c.team && c.team.id !== undefined && c.team.id !== null && !teamsToday.has(c.team.id)) {
                teamsToday.set(c.team.id, { teamName: c.team.displayName || c.team.name, startTime: g.date });
              }
            }
          }
          if (teamsToday.size) {
            const rosterResults = await Promise.allSettled(
              [...teamsToday.keys()].map(id =>
                espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${espnRosterSportPath}/teams/${id}/roster`).then(r => r.ok ? r.json() : null)
              )
            );
            let i = 0;
            for (const id of teamsToday.keys()) {
              const result = rosterResults[i++];
              const t = teamsToday.get(id)!;
              if (result.status !== 'fulfilled' || !result.value) continue;
              const athletes = result.value.athletes || [];
              for (const a of athletes) {
                const name = a.fullName || a.displayName;
                if (name) { registerPlayerName(propLookup, name, { team: t.teamName, startTime: t.startTime }); propDisplayNames.push(name); }
              }
            }
            propLookupStatus = propLookup.size > 0 ? 'built' : 'built_but_empty';
          } else {
            propLookupStatus = 'built_but_empty';
          }
        }

        const allPicks = await db(
          `picks?select=id,selection,prop_player,prop_team,bet_type_id,event_name,doubleheader_game,bet_types(name,uses_prop_fields,uses_matchup_fields)&sport_id=eq.${ourSport.id}&event_date=eq.${targetDate}&or=(schedule_sync_status.is.null,schedule_sync_status.neq.matched)`
        );
        const picks = (allPicks || []).filter((p: any) => {
          const betTypeName = (p.bet_types && p.bet_types.name || '').toLowerCase();
          return !betTypeName.includes('parlay');
        });

        const sportResult = {
          sport: ourSport.name, games_found: games.length,
          prop_lookup_status: propLookupStatus, prop_lookup_players_found: propLookup.size,
          matched: [] as any[], unmatched: [] as any[]
        };

        for (const pick of picks) {
          const isProp = pick.bet_types && pick.bet_types.uses_prop_fields;

          if (isProp) {
            if (!pick.prop_player) {
              const note = `This pick has no player name recorded -- can't be matched to a game without one.`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
              sportResult.unmatched.push({ id: pick.id, selection: '(no player name set)', reason: note });
              continue;
            }
            if (!propLookup.size) {
              const isPermanent = propLookupStatus === 'not_applicable';
              const isEmptyNotError = propLookupStatus === 'built_but_empty';
              let note: string;
              if (isPermanent) {
                note = `No player roster data source available for ${ourSport.name} props -- start time needs manual entry.`;
              } else if (isEmptyNotError) {
                note = `No ${ourSport.name} games found on ${targetDate} (or the day after) -- if this pick's event_date is wrong (e.g. entered before a playoff series/Finals actually started), correct it and re-run. If a game really is scheduled that day, this may be a temporary data gap worth retrying.`;
              } else {
                note = `Could not build a ${ourSport.name} player roster for ${targetDate} this run (${propLookupStatus}) -- try running the backfill again, or enter start time manually.`;
              }
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: isPermanent ? 'not_supported' : 'unmatched', schedule_sync_note: note }) });
              sportResult.unmatched.push({ id: pick.id, selection: pick.prop_player, reason: note });
              continue;
            }
            const propMatches = propLookup.get(normalize(pick.prop_player));
            // Direct request 2026-08-28: a player whose team plays twice
            // today (doubleheader) now has 2 real entries here instead of
            // one silently overwriting the other (see registerPlayerName's
            // own comment above). Only auto-resolves when the pick is
            // tagged AND there are exactly 2 entries -- otherwise this
            // falls through to a real "needs manual review" note, never a
            // silent guess.
            let propMatch: { team: string; startTime: string } | null = null;
            if (propMatches && propMatches.length === 1) {
              propMatch = propMatches[0];
            } else if (propMatches && propMatches.length === 2 && (pick.doubleheader_game === 1 || pick.doubleheader_game === 2)) {
              const sorted = [...propMatches].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
              propMatch = sorted[pick.doubleheader_game - 1];
            }
            if (propMatch) {
              const updatePayload: Record<string, unknown> = {
                game_start_time: propMatch.startTime,
                schedule_sync_status: 'matched',
                schedule_sync_note: null
              };
              if (!skipProps && !pick.prop_team) updatePayload.prop_team = propMatch.team;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify(updatePayload) });
              sportResult.matched.push({
                id: pick.id, selection: `${pick.prop_player} (prop)`, start_time: propMatch.startTime,
                prop_team: propMatch.team
              });
              continue;
            }
            if (propMatches && propMatches.length > 1) {
              const note = `"${pick.prop_player}"'s team plays more than once on ${targetDate} (possible start times: ${propMatches.map(m => m.startTime).join(', ')}) -- set this pick's Doubleheader game # (1 or 2) and re-run to resolve automatically, or fill in Start Time manually.`;
              await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
              sportResult.unmatched.push({ id: pick.id, selection: pick.prop_player, reason: note });
              continue;
            }
            const propSuggestion = suggestClosestPlayer(pick.prop_player, propDisplayNames);
            const note = `"${pick.prop_player}" was not found on any ${ourSport.name} active roster playing on ${targetDate} -- may be a name spelling issue, or the player may not be active/on this team.${propSuggestion ? ` Closest name on today's rosters: "${propSuggestion}".` : ''}`;
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
            sportResult.unmatched.push({ id: pick.id, selection: pick.prop_player, reason: note });
            continue;
          }

          const hasSlash = pick.selection.includes('/');
          const betTypeName = (pick.bet_types && pick.bet_types.name) || '';
          const needsHomeAway = betTypeUsesHomeAway(betTypeName);
          const isOverUnder = hasSlash && !needsHomeAway;
          const isAmbiguousSlash = hasSlash && needsHomeAway;
          let candidateGames: typeof gameEntries;
          let matchedIsHome: boolean | null = null;
          let slashTeamA = '', slashTeamB = '';
          let slashMatchesA: ReturnType<typeof findMatchingGames> | null = null;
          let slashMatchesB: ReturnType<typeof findMatchingGames> | null = null;
          if (hasSlash) {
            const [teamA, teamB] = pick.selection.split('/').map((s: string) => s.trim());
            slashTeamA = teamA; slashTeamB = teamB;
            const matchesA = findMatchingGames(teamA);
            const matchesB = findMatchingGames(teamB);
            slashMatchesA = matchesA; slashMatchesB = matchesB;
            candidateGames = matchesA.filter(a => matchesB.some(b => b.game.event_id === a.game.event_id)).map(a => a.game);
          } else {
            const matches = findMatchingGames(pick.selection);
            candidateGames = matches.map(m => m.game);
            if (matches.length === 1) matchedIsHome = matches[0].isHome;
          }

          // Direct request 2026-08-28: "we need to catch this upstream... I
          // need a way to identify it in uploads." admin.html's entry
          // template/Bulk Import/Add Pick form now capture doubleheader_game
          // (1 or 2) as a real field at data-entry time. When a pick is
          // tagged this way and exactly 2 real games matched the same
          // matchup on the same date (a genuine doubleheader, not a data
          // error), sort them by start time and treat whichever one the tag
          // names as the single confirmed match, instead of falling through
          // to "needs manual review" below. Requires EXACTLY 2 candidates --
          // 3+ still needs a human look rather than a guess. Deliberately
          // placed before the Draw No Bet / isAmbiguousSlash branch just
          // below so a doubleheader Draw No Bet pick benefits from this too.
          if (candidateGames.length === 2 && (pick.doubleheader_game === 1 || pick.doubleheader_game === 2)) {
            const sorted = [...candidateGames].sort(
              (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
            );
            const chosen = sorted[pick.doubleheader_game - 1];
            candidateGames = [chosen];
            if (!hasSlash) {
              const rematch = findMatchingGames(pick.selection).find(m => m.game.event_id === chosen.event_id);
              matchedIsHome = rematch ? rematch.isHome : null;
            }
          }

          // CONFIRMED REAL BUG, direct report 2026-08-21: "this is how we
          // built draw no bets into the system... I'm confused about the
          // error message." Draw No Bet (and anything else using
          // admin.html's Team 1/Team 2 matchup form) stores its selection
          // as "Team1/Team2" with Team 1 REQUIRED and Team 2 optional --
          // the same structural convention already established for
          // Over/Under (see populateMatchupTeamDropdowns' own comment in
          // admin.html). For a side-picking bet type like Draw No Bet,
          // Team 1 isn't incidental -- it's the actual side backed, same
          // as a plain Moneyline selection. This branch was treating EVERY
          // two-team slash selection as unresolvably ambiguous regardless
          // of where it came from, when a pick entered through the
          // structured form has real positional meaning a free-typed/
          // transcribed selection doesn't. Only a slash selection that did
          // NOT come from that structured form (bet type isn't flagged
          // uses_matchup_fields) still gets treated as genuinely ambiguous.
          const usesMatchupForm = !!(pick.bet_types && pick.bet_types.uses_matchup_fields);
          if (candidateGames.length === 1 && isAmbiguousSlash && usesMatchupForm && slashMatchesA) {
            const aInGame = slashMatchesA.find(m => m.game.event_id === candidateGames[0].event_id);
            const updatePayload: Record<string, unknown> = {
              game_start_time: candidateGames[0].start_time, schedule_sync_status: 'matched', schedule_sync_note: null
            };
            if (aInGame) updatePayload.home_away = aInGame.isHome ? 'home' : 'away';
            // Same date-mismatch detection as the plain-match branch below
            // -- a Draw No Bet pick can land on the wrong day exactly like
            // any other Soccer pick, and this branch shouldn't silently
            // skip that check just because it took a different path here.
            let dnbDateCorrected = false;
            if (isSoccer || isKBO) {
              const matchedDateStr = (candidateGames[0].start_time || '').slice(0, 10);
              if (matchedDateStr && matchedDateStr !== targetDate) {
                dnbDateCorrected = true;
                updatePayload.schedule_sync_note = `Found on ${matchedDateStr} -- this pick's event_date is currently ${targetDate}. Consider correcting event_date to match; game_start_time has already been set to the real value.`;
              }
            }
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify(updatePayload) });
            sportResult.matched.push({
              id: pick.id, selection: pick.selection, start_time: candidateGames[0].start_time,
              home_away: aInGame ? (aInGame.isHome ? 'home' : 'away') : null,
              date_corrected: dnbDateCorrected
            });
          } else if (candidateGames.length === 1 && isAmbiguousSlash) {
            const note = `"${pick.selection}" matched a real game (${candidateGames[0].matchup}), but this is a ${betTypeName} pick with a two-team selection format -- can't tell which side was actually picked from the text alone. Needs manual entry of home/away.`;
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ game_start_time: candidateGames[0].start_time, schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
            sportResult.unmatched.push({ id: pick.id, selection: pick.selection, reason: note });
          } else if (candidateGames.length === 1) {
            const updatePayload: Record<string, unknown> = {
              game_start_time: candidateGames[0].start_time, schedule_sync_status: 'matched', schedule_sync_note: null
            };
            if (matchedIsHome !== null) updatePayload.home_away = matchedIsHome ? 'home' : 'away';
            let dateCorrected = false;
            if (isSoccer || isKBO) {
              const matchedDateStr = (candidateGames[0].start_time || '').slice(0, 10);
              if (matchedDateStr && matchedDateStr !== targetDate) {
                dateCorrected = true;
                updatePayload.schedule_sync_note = `Found on ${matchedDateStr} -- this pick's event_date is currently ${targetDate}. Consider correcting event_date to match; game_start_time has already been set to the real value.`;
              }
            }
            if (!skipProps && isSoccer && !pick.event_name && candidateGames[0].competition_name) {
              updatePayload.event_name = candidateGames[0].competition_name;
            }
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify(updatePayload) });
            sportResult.matched.push({
              id: pick.id, selection: pick.selection, start_time: candidateGames[0].start_time,
              home_away: matchedIsHome !== null ? (matchedIsHome ? 'home' : 'away') : null,
              date_corrected: dateCorrected, event_name: updatePayload.event_name || pick.event_name || null
            });
          } else if (candidateGames.length === 0) {
            let suggestionText = '';
            if (hasSlash) {
              const parts: string[] = [];
              if (slashMatchesA && slashMatchesA.length === 0) {
                const s = suggestClosest(slashTeamA, allTeamDisplayNamesToday);
                if (s) parts.push(`"${slashTeamA}" -> "${s}"`);
              }
              if (slashMatchesB && slashMatchesB.length === 0) {
                const s = suggestClosest(slashTeamB, allTeamDisplayNamesToday);
                if (s) parts.push(`"${slashTeamB}" -> "${s}"`);
              }
              if (parts.length) suggestionText = ` Possible spelling issue: ${parts.join(', ')}.`;
            } else {
              const s = suggestClosest(pick.selection, allTeamDisplayNamesToday);
              if (s) suggestionText = ` Closest team playing today: "${s}" -- possible spelling issue.`;
            }
            let dateNote = ` on ${targetDate}`;
            if (isSoccer) dateNote = ` (checked ${targetDate} plus any real tournament windows within 30 days of it)`;
            else if (isKBO) dateNote = ` (checked ${targetDate} plus the day before and after)`;
            const note = `No matching ${ourSport.name} game found for "${pick.selection}"${dateNote}.${suggestionText}`;
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
            sportResult.unmatched.push({ id: pick.id, selection: pick.selection, reason: note });
          } else if (isKBO) {
            const sameDateGames = candidateGames.filter(g => (g.start_time || '').slice(0, 10) === targetDate);
            const otherDateGames = candidateGames.filter(g => (g.start_time || '').slice(0, 10) !== targetDate);
            const suggestions = otherDateGames.map(g => `did you mean ${formatEtDateTime(g.start_time)} instead (${g.matchup})?`);
            const sameDateNote = sameDateGames.length
              ? `One real game IS on ${targetDate} (${sameDateGames.map(g => g.matchup).join(', ')}). `
              : '';
            const note = `${candidateGames.length} possible games matched "${pick.selection}" -- entered as ${targetDate}, but KBO's evening KST games often land on the pick's US calendar day one day early or late. ${sameDateNote}${suggestions.join(' ')} If a later/earlier date is right, update this pick's Event date and re-run -- needs manual review.`;
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
            sportResult.unmatched.push({ id: pick.id, selection: pick.selection, reason: note });
          } else {
            const note = `${candidateGames.length} possible games matched "${pick.selection}" on ${targetDate}: [${candidateGames.map(g => `${g.matchup} (${g.start_time})`).join(' | ')}] -- needs manual review.`;
            await db(`picks?id=eq.${pick.id}`, { method: 'PATCH', body: JSON.stringify({ schedule_sync_status: 'unmatched', schedule_sync_note: note }) });
            sportResult.unmatched.push({ id: pick.id, selection: pick.selection, reason: note });
          }
        }
        overall.sports_processed.push(sportResult);
      } catch (sportErr) {
        overall.sports_processed.push({ sport: ourSport.name, error: String(sportErr) });
      }
    }

    return new Response(JSON.stringify(overall, null, 2), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
