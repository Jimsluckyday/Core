# Formula-tuning analysis

Started 2026-09-02, direct request: "as we get more data... I can tweak my numbers
once we have enough data to know that x capper needs a boost or y capper needs to
be tuned down or we can look at specific sports boosts etc I think that's where the
real data mining value works."

## What this is

A recurring, read-only analysis (same cadence and shape as the independent grading
audit in `../grading-audit/`, if that gets its own folder later) that compares each
capper/sport/bet-type's REAL win rate against the score the scoring formula gave
their picks BEFORE the outcome was known (`first_scored_score` -- a write-once
snapshot captured at first-scoring time, so this comparison is never contaminated
by hindsight).

**This never touches `scoringConfig` or any live scoring code.** It only ever
produces a report flagging where the formula's implied valuation and the real
outcome diverge, for a human to review and decide whether to act on. Same rule as
the grading audit: no silent changes, ever -- "even a name change could lead to
drift causing more issues than it's worth" applies just as much to a formula
weight as it does to a capper's name spelling.

## Why this needs real volume before it means anything

A capper's real win rate on 8 graded picks is mostly noise. Confidence thresholds
used in every report this produces:

| Sample size (picks) | Confidence |
|---|---|
| < 20 | Insufficient -- track it, don't act on it |
| 20-75 | Early signal -- worth watching over the next few runs |
| 75+ | Meaningful -- worth a real discussion about adjusting something |

A finding below 75 picks should never be phrased as "capper X is overvalued" --
only as "capper X is trending toward looking overvalued, N picks so far."

## The weekly export

Run this in the Supabase SQL editor for the week being analyzed, paste the result
back for the next run:

```sql
select p.id, p.event_date, c.name as capper_name, s.name as sport_name,
       bt.name as bet_type_name, p.result, p.first_scored_score, p.is_parlay_leg
from picks p
left join cappers c on c.id = p.capper_id
left join sports s on s.id = p.sport_id
left join bet_types bt on bt.id = p.bet_type_id
where p.event_date between '<START>' and '<END>'
  and p.result in ('win','loss','push')
  and bt.name != 'Parlay'
order by p.event_date asc;
```

Parlay wrapper rows are excluded (they're a rollup, not a single scored bet with a
comparable `first_scored_score`) -- but parlay LEGS (`is_parlay_leg = true`) are
included, since a leg's real outcome is still genuine evidence of that capper's
own pick quality, separate from the confluence-scoring reason legs get excluded
from other parts of this system.

`first_scored_score` will be `null` on picks that predate the snapshot feature or
were graded without ever going through Publish Ranking -- those still count toward
raw win-rate, just excluded from the score-vs-outcome comparison specifically.

## The persistent log

`log.jsonl` -- one JSON object per run, append-only, so every run can read back
every prior run and build real trend commentary ("this capper has looked
overvalued for 3 consecutive weekly runs now") instead of restarting from zero
each time. Never edit or delete a past entry -- if a past run's data turns out to
have been wrong (e.g. a grading error the audit later caught and corrected), add a
new entry noting the correction rather than rewriting history.

Schema (one line of `log.jsonl`, pretty-printed here for readability):

```json
{
  "run_date": "2026-09-02",
  "week_covering": "2025-06-01 to 2025-06-07",
  "picks_analyzed": 89,
  "picks_with_score_data": 74,
  "cappers": [
    { "name": "Example Capper", "picks": 12, "wins": 7, "losses": 5, "pushes": 0,
      "win_pct": 58.3, "avg_first_scored_score": 42.1, "confidence": "insufficient" }
  ],
  "sports": [
    { "sport": "MLB", "picks": 70, "win_pct": 51.2, "avg_first_scored_score": 38.5,
      "confidence": "early_signal" }
  ],
  "bet_types": [
    { "bet_type": "Spread", "picks": 22, "win_pct": 54.5, "avg_first_scored_score": 40.0,
      "confidence": "insufficient" }
  ],
  "flags": [
    { "type": "capper_trending_overvalued", "subject": "Example Capper",
      "detail": "avg score 42 implies mid-50s win rate; real win rate is 58% over 12 picks",
      "confidence": "insufficient -- watch, don't act" }
  ],
  "notes": "free-text context for this run, e.g. small sample caveats, data gaps found"
}
```

## Status

Infrastructure built 2026-09-02. No real run has happened yet -- waiting on the
first score-inclusive weekly export. First few runs should be treated purely as
mechanism tests; nothing here should change any actual scoring formula until
there's a run comfortably past the 75-pick confidence line for whatever it's
flagging.
