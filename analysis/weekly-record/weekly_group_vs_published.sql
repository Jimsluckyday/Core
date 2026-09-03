-- Weekly Overall Record: Group (all cappers) vs. Published (what we posted)
--
-- Answers: "was this a winning week for the group, and did what we actually
-- published track that?" A winning week for the group with a losing week
-- for our published picks is the signal to look at pick selection, not the
-- cappers themselves.
--
-- Edit start_date/end_date below, then run in the Supabase SQL editor.
--
-- Excludes parlay legs (is_parlay_leg = false) so a multi-leg parlay counts
-- once on its own combined price, never once per leg -- see the
-- "Out of Line Bets" fix (is_parlay_leg = false replacing bt.name <> 'Parlay')
-- in the profitability work this query is built from.
--
-- Profit uses the same $100-stake convention as the app's calcProfit():
-- loss = -100, push = 0, win = odds (if positive) or 10000/abs(odds)
-- (if negative), using opening_odds if present else closing_odds.
-- Pending picks are counted but excluded from win%/profit (outcome unknown).

with week_bounds as (
  select date '2025-06-01' as start_date, date '2025-06-07' as end_date
),
base as (
  select
    p.id,
    p.capper_id,
    p.result,
    p.is_published,
    coalesce(p.opening_odds, p.closing_odds) as odds_used,
    case
      when p.result = 'loss' then -100
      when p.result = 'push' then 0
      when p.result = 'win' and coalesce(p.opening_odds, p.closing_odds) is not null then
        case when coalesce(p.opening_odds, p.closing_odds) > 0
          then coalesce(p.opening_odds, p.closing_odds)
          else 10000.0 / abs(coalesce(p.opening_odds, p.closing_odds))
        end
      else null
    end as profit
  from picks p, week_bounds w
  where p.event_date between w.start_date and w.end_date
    and p.is_parlay_leg = false
),
scoped as (
  select 'Group (all cappers)' as scope, * from base
  union all
  select 'Published (what we posted)' as scope, * from base where is_published = true
)
select
  scope,
  count(*) as total_picks,
  count(distinct capper_id) as cappers,
  count(*) filter (where result = 'win') as wins,
  count(*) filter (where result = 'loss') as losses,
  count(*) filter (where result = 'push') as pushes,
  count(*) filter (where result = 'pending') as pending,
  round(
    100.0 * count(*) filter (where result = 'win')
    / nullif(count(*) filter (where result in ('win','loss')), 0)
  , 1) as win_pct_excl_push,
  round(sum(profit) filter (where result in ('win','loss','push')), 2) as total_profit,
  round(
    100.0 * sum(profit) filter (where result in ('win','loss','push'))
    / nullif(100.0 * count(*) filter (where result in ('win','loss','push')), 0)
  , 1) as roi_pct
from scoped
group by scope
order by (scope = 'Group (all cappers)') desc;
