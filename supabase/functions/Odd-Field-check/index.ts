Deno.serve(async (req) => {
  try {
    const apiKey = Deno.env.get('RUNDOWN_API_KEY');
    const url = `https://therundown.io/api/v2/sports/3/events/2026-06-02?key=${apiKey}&market_ids=1,2,3&include=all_periods`;
    const res = await fetch(url);
    const data = await res.json();

    const firstGame = data.events && data.events[0];
    return new Response(JSON.stringify({
      note: 'Looking for whatever field holds odds/lines, using a completed game so we know odds definitely existed at some point.',
      top_level_keys: firstGame ? Object.keys(firstGame) : [],
      total_games: data.events ? data.events.length : 0,
      first_game_full: firstGame || null
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
