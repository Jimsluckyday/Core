Deno.serve(async (req) => {
  try {
    const apiKey = Deno.env.get('RUNDOWN_API_KEY');
    const res = await fetch(`https://therundown.io/api/v2/markets?key=${apiKey}`);
    const data = await res.json();
    return new Response(JSON.stringify({
      note: 'Full list of market types and their IDs. Look for anything related to pitcher strikeouts, batter hits, total bases, etc.',
      markets: data
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
