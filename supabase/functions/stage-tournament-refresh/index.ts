// stage-tournament-refresh
// Accepts research findings from a scheduled tournament-refresh task (or
// anything else) and stages them for human review inside admin.html --
// never writes directly to the real tournaments table. A light shared-secret
// check keeps this from being a trivially abusable open endpoint, since
// unlike a pure read-only diagnostic function, this one writes data.
//
// Call with: POST /stage-tournament-refresh
// Body: { rows: [{ name, sport, start_date, end_date }, ...], summary?: string }
// Header: x-stage-secret: <STAGE_SHARED_SECRET>

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-stage-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const sharedSecret = Deno.env.get('STAGE_SHARED_SECRET');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!sharedSecret || !supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'Missing required secret(s).' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const providedSecret = req.headers.get('x-stage-secret');
    if (providedSecret !== sharedSecret) {
      return new Response(JSON.stringify({ error: 'Invalid or missing x-stage-secret header.' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json();
    const rows = body.rows;
    if (!Array.isArray(rows) || !rows.length) {
      return new Response(JSON.stringify({ error: 'Body must include a non-empty "rows" array.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Basic shape validation -- doesn't need to be exhaustive, since a human
    // reviews everything in admin.html before anything becomes real. This
    // just catches obviously malformed submissions early.
    for (const r of rows) {
      if (!r.name || !r.sport || !r.start_date || !r.end_date) {
        return new Response(JSON.stringify({ error: 'Every row needs name, sport, start_date, and end_date.', bad_row: r }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    const summary = body.summary || `${rows.length} tournament${rows.length === 1 ? '' : 's'} found`;

    const res = await fetch(`${supabaseUrl}/rest/v1/tournament_refresh_staging`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify([{ proposed_rows: rows, summary, status: 'pending_review' }])
    });
    if (!res.ok) throw new Error(`DB insert failed (${res.status}): ${await res.text()}`);
    const inserted = await res.json();

    return new Response(JSON.stringify({ status: 'staged', id: inserted[0].id, summary }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
