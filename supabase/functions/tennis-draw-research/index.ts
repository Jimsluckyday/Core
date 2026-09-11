// tennis-draw-research
//
// SCOPED 2026-09-11, direct request: "if I can go in and ask Gemini to find
// me the tennis draws for Jun 14 2025 and it shows me the 4 tournaments on
// that day is there any way we can pull this information and store it
// somewhere so when we do our uploads we get around this tennis quagmire we
// are in considering the volume of picks that are made against tennis on a
// daily basis?" -- 15+ Tennis picks a night, and a large share of them land
// on ATP Challenger Tour events, which ESPN's tennis/atp + tennis/wta
// scoreboard endpoints (the only source schedule-sync-backfill's Tennis
// branch has ever had) simply do not cover at all -- confirmed the same day
// via real examples (Dino Prizmic, Darwin Blanch, Alexander Shevchenko,
// Gauthier Onclin all playing real Challenger events invisible to ESPN's
// API), each one previously requiring a one-by-one manual Flashscore lookup.
//
// This function does NOT touch any pick. It only researches a single day's
// real ATP/WTA/ATP-Challenger-Tour matches via Claude + server-side web
// search, and upserts them into `tennis_draw_cache` (new table, see the SQL
// delivered alongside this file). schedule-sync-backfill's existing Tennis
// matching separately reads this table and merges cached rows into the same
// `tennisMatches` pool ESPN rows already populate -- this function's only
// job is filling that cache, on demand, one calendar day at a time.
//
// ITF-level events, exhibitions, and juniors are explicitly OUT of scope --
// that tier is enormous in volume and isn't what's actually being picked
// against, based on the real examples researched this session.
//
// Call with: POST /tennis-draw-research?date=2026-09-11[&model=sonnet|opus][&maxUses=8]
//   model defaults to "sonnet" (claude-sonnet-5, ~$2/$10 per MTok) --
//   cheaper, expected sufficient for a factual research+extraction task.
//   "opus" (claude-opus-5, ~$5/$25 per MTok) is offered as the pricier,
//   more-thorough alternative for a night with unusually many concurrent
//   Challenger events. Both are surfaced as an explicit choice in
//   admin.html's own confirm() dialog -- never silently picked here.
//
// Uses claude-sonnet-5/claude-opus-5 with the CURRENT (as of 2026-09-11,
// verified via the claude-api skill, not assumed from training) server-side
// web search tool `web_search_20260209` -- NOT the stale `web_search_20250305`.
// Called via raw fetch() to api.anthropic.com, matching every other Edge
// Function in this codebase (espnFetch()/db() convention, no SDK).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const VALID_TOURS = ['ATP', 'WTA', 'Challenger'];

const MODEL_INFO: Record<string, { id: string; inputPerM: number; outputPerM: number }> = {
  sonnet: { id: 'claude-sonnet-5', inputPerM: 2, outputPerM: 10 },
  opus: { id: 'claude-opus-5', inputPerM: 5, outputPerM: 25 },
};

async function db(supabaseUrl: string, serviceRoleKey: string, path: string, opts: RequestInit = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: opts.method === 'PATCH' ? 'return=minimal' : 'return=representation',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase request failed (${res.status}): ${await res.text()}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function buildPrompt(date: string): string {
  return `You are researching real professional tennis matches for ${date} (Eastern Time, USA).

Scope: ONLY ATP tour, WTA tour, and ATP Challenger Tour events. Do NOT include ITF-level events, exhibitions, or juniors -- that tier is explicitly out of scope.

There are typically SEVERAL Challenger-level events running concurrently in any given week worldwide, not just the headline ATP/WTA events -- do not stop after finding one or two. Use web search systematically: check official ATP/WTA draw/schedule pages for the week of ${date}, and cross-reference against a comprehensive week-by-week source (e.g. Wikipedia's "[year] ATP Challenger Tour" page and the WTA 125 equivalent) to catch concurrent Challenger events that a single general search would miss.

For every real match scheduled or played on ${date} (Eastern calendar date) at ATP, WTA, or ATP Challenger Tour level, report:
- tour: "ATP", "WTA", or "Challenger"
- tournament_name
- round (e.g. "R32", "QF", "Q1" -- best effort, empty string if unknown)
- player_a and player_b: full player names
- start_time_et: approximate start time in US Eastern time, ISO 8601 with -04:00/-05:00 offset, or null if genuinely unknown -- this is a best-effort estimate, not authoritative, say so via null rather than guessing a specific time you're not reasonably confident in.

Only include matches you are reasonably confident are real and scheduled for this date -- if uncertain about a specific match, leave it out rather than guessing.

End your response with a single fenced JSON code block containing exactly this shape and nothing else inside the fence:

\`\`\`json
[
  {"tour": "ATP", "tournament_name": "...", "round": "...", "player_a": "...", "player_b": "...", "start_time_et": "2026-09-11T14:00:00-04:00"}
]
\`\`\``;
}

// Same fenced-JSON-stripping convention already used by this pipeline's own
// Claude calls (2_transcribe_images.py, lines ~133-140) -- ported to TS.
function parseMatchesFromText(text: string): any[] {
  let jsonText = text.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.split('```')[1];
    if (jsonText.startsWith('json')) jsonText = jsonText.slice(4);
    jsonText = jsonText.trim();
  }
  return JSON.parse(jsonText);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!supabaseUrl || !serviceRoleKey || !anthropicApiKey) {
      return new Response(JSON.stringify({ error: 'Missing required secret(s) (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ANTHROPIC_API_KEY).' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(req.url);
    const targetDate = url.searchParams.get('date');
    if (!targetDate) {
      return new Response(JSON.stringify({ error: 'Missing required "date" query parameter, e.g. ?date=2026-09-11' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const modelKey = (url.searchParams.get('model') || 'sonnet').toLowerCase();
    const modelInfo = MODEL_INFO[modelKey];
    if (!modelInfo) {
      return new Response(JSON.stringify({ error: `Unknown model "${modelKey}" -- use "sonnet" or "opus".` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const maxUses = Math.max(1, Math.min(20, parseInt(url.searchParams.get('maxUses') || '8', 10) || 8));

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: modelInfo.id,
        max_tokens: 8000,
        output_config: { effort: 'medium' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses }],
        messages: [{ role: 'user', content: buildPrompt(targetDate) }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return new Response(JSON.stringify({ error: `Claude API request failed (${anthropicRes.status}): ${errText}` }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const anthropicData = await anthropicRes.json();

    if (anthropicData.stop_reason === 'refusal') {
      return new Response(JSON.stringify({ error: 'Claude declined to answer this request (stop_reason: refusal).' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Server-tool (web_search) errors return HTTP 200 with an error content
    // block, not a raised exception -- surface any that occurred so a
    // silent partial-research run isn't mistaken for a complete one.
    const searchErrors: string[] = [];
    for (const block of (anthropicData.content || [])) {
      if (block.type === 'web_search_tool_result' && block.content && !Array.isArray(block.content)) {
        searchErrors.push(block.content.error_code || 'unknown web_search error');
      }
    }

    const textBlocks = (anthropicData.content || []).filter((b: any) => b.type === 'text');
    const lastText = textBlocks.length ? textBlocks[textBlocks.length - 1].text.trim() : '';
    if (!lastText) {
      return new Response(JSON.stringify({ error: 'Claude returned no text response to parse.', search_errors: searchErrors }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    let rawMatches: any[];
    try {
      rawMatches = parseMatchesFromText(lastText);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Could not parse a JSON match list from Claude\'s response.', raw_text_excerpt: lastText.slice(0, 2000) }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const researchedAt = new Date().toISOString();
    const source = `ai_research:${modelInfo.id}:${researchedAt}`;
    const rowsToUpsert: any[] = [];
    const skippedReasons: string[] = [];
    const tournamentCounts = new Map<string, { tour: string; count: number }>();

    rawMatches.forEach((m, idx) => {
      const tour = (m.tour || '').trim();
      if (!VALID_TOURS.includes(tour)) {
        skippedReasons.push(`Row ${idx + 1}: tour "${m.tour}" not in ATP/WTA/Challenger -- skipped`);
        return;
      }
      const playerA = (m.player_a || '').trim();
      const playerB = (m.player_b || '').trim();
      if (!playerA || !playerB) {
        skippedReasons.push(`Row ${idx + 1}: missing player_a or player_b -- skipped`);
        return;
      }
      // Sorted alphabetically (not trusted from Claude's own left/right
      // order) so a re-run with the two names swapped still upserts onto
      // the same row instead of creating a duplicate.
      const [player_a_name, player_b_name] = [playerA, playerB].sort();
      const tournament_name = (m.tournament_name || '').trim() || 'Unknown Tournament';
      const round = (m.round || '').trim();
      let start_time_et: string | null = null;
      if (m.start_time_et) {
        const parsed = new Date(m.start_time_et);
        if (!isNaN(parsed.getTime())) start_time_et = parsed.toISOString();
      }
      rowsToUpsert.push({
        match_date: targetDate, tour, tournament_name, round,
        player_a_name, player_b_name, start_time_et,
        source, raw_match_json: m, researched_at: researchedAt,
      });
      const key = `${tournament_name}|||${tour}`;
      const existing = tournamentCounts.get(key) || { tour, count: 0 };
      existing.count += 1;
      tournamentCounts.set(key, existing);
    });

    if (rowsToUpsert.length) {
      await db(supabaseUrl, serviceRoleKey,
        'tennis_draw_cache?on_conflict=match_date,tour,tournament_name,round,player_a_name,player_b_name',
        { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rowsToUpsert) }
      );
    }

    const usage = anthropicData.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const costEstimateUsd = (inputTokens / 1_000_000) * modelInfo.inputPerM + (outputTokens / 1_000_000) * modelInfo.outputPerM;

    const result = {
      date: targetDate,
      model_used: modelInfo.id,
      tournaments_found: tournamentCounts.size,
      matches_found: rawMatches.length,
      matches_upserted: rowsToUpsert.length,
      matches_skipped: skippedReasons.length,
      skipped_reasons: skippedReasons,
      tournaments: [...tournamentCounts.entries()].map(([key, v]) => ({ name: key.split('|||')[0], tour: v.tour, match_count: v.count })),
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, web_search_requests: (anthropicData.content || []).filter((b: any) => b.type === 'web_search_tool_result').length },
      cost_estimate_usd: Math.round(costEstimateUsd * 1000) / 1000,
      ...(searchErrors.length ? { search_errors: searchErrors } : {}),
    };

    return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
