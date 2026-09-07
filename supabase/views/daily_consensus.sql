-- daily_consensus (Postgres VIEW) -- backed up locally 2026-09-07 for the
-- same reason Edge Functions get backed up in ../functions/: this view
-- otherwise lives ONLY in the Supabase dashboard, no local source, no git
-- history. Started because it was almost lost to exactly that -- caught
-- via a real report showing "Tampa Bay Rays Open +7 / Close +7" (11
-- agreeing cappers, most around -105/+100), which made no sense as a real
-- price. Pulled the live definition via `select pg_get_viewdef('daily_consensus', true);`
-- and found the actual bug: avg_opening_odds/avg_closing_odds were a
-- plain `round(avg(p.opening_odds), 0)` -- a direct arithmetic average of
-- raw American odds. American odds are not on a linear scale (the jump
-- from -100 to +100 skips a huge range), so averaging them directly
-- produces a distorted, sometimes nonsensical number whenever a group
-- mixes favorites and underdogs -- exactly what happened here.
--
-- FIXED 2026-09-07: convert each row's odds to implied probability first
-- (which IS linear/poolable), average the probabilities, then convert
-- the averaged probability back to a single representative American odds
-- figure. Everything else about the view (the selection/prop_player
-- consensus-matching CASE logic, the Parlay-wrapper exclusion, the
-- grouping/ordering) is UNCHANGED from the original -- only the two
-- odds-averaging lines were touched.
--
-- Run this whole file (functions first, they're referenced by the view)
-- in the Supabase SQL editor to (re)apply.

create or replace function american_odds_to_prob(odds numeric)
returns numeric
language sql
immutable
as $$
  select case
    when odds is null then null
    when odds > 0 then 100.0 / (odds + 100.0)
    when odds < 0 then (-odds) / ((-odds) + 100.0)
    else null
  end;
$$;

create or replace function prob_to_american_odds(prob numeric)
returns numeric
language sql
immutable
as $$
  select case
    when prob is null or prob <= 0 or prob >= 1 then null
    when prob >= 0.5 then round(-100.0 * prob / (1 - prob))
    else round(100.0 * (1 - prob) / prob)
  end;
$$;

create or replace view daily_consensus as
select p.event_date,
    p.sport_id,
    s.name as sport_name,
    p.bet_type_id,
    bt.name as bet_type_name,
    bt.uses_prop_fields,
    case
        when lower(trim(bt.name)) like '%over/under%' or lower(trim(bt.name)) = 'total' or lower(trim(bt.name)) = any (array['no run first inning', 'yes run first inning', 'both teams to score']) then consensus_pair_key(p.selection, p.sport_id::bigint, p.game_start_time, not (exists (select 1 from teams t where t.sport_id = p.sport_id)))
        when not (exists (select 1 from teams t where t.sport_id = p.sport_id)) then resolve_consensus_name(p.selection, p.sport_id::bigint)
        else p.selection
    end as selection,
    p.line,
    case
        when not (exists (select 1 from teams t where t.sport_id = p.sport_id)) then resolve_consensus_name(p.prop_player, p.sport_id::bigint)
        else p.prop_player
    end as prop_player,
    p.prop_stat,
    p.result,
    count(distinct p.capper_id) as agreeing_cappers,
    array_agg(distinct c.name order by c.name) as capper_names,
    prob_to_american_odds(avg(american_odds_to_prob(p.opening_odds))) as avg_opening_odds,
    prob_to_american_odds(avg(american_odds_to_prob(p.closing_odds))) as avg_closing_odds,
    bool_or(p.is_published) as any_published
   from picks p
     join cappers c on c.id = p.capper_id
     left join sports s on s.id = p.sport_id
     left join bet_types bt on bt.id = p.bet_type_id
  where bt.name is distinct from 'Parlay'
  group by p.event_date, p.sport_id, s.name, p.bet_type_id, bt.name, bt.uses_prop_fields, (
        case
            when lower(trim(bt.name)) like '%over/under%' or lower(trim(bt.name)) = 'total' or lower(trim(bt.name)) = any (array['no run first inning', 'yes run first inning', 'both teams to score']) then consensus_pair_key(p.selection, p.sport_id::bigint, p.game_start_time, not (exists (select 1 from teams t where t.sport_id = p.sport_id)))
            when not (exists (select 1 from teams t where t.sport_id = p.sport_id)) then resolve_consensus_name(p.selection, p.sport_id::bigint)
            else p.selection
        end), p.line, (
        case
            when not (exists (select 1 from teams t where t.sport_id = p.sport_id)) then resolve_consensus_name(p.prop_player, p.sport_id::bigint)
            else p.prop_player
        end), p.prop_stat, p.result
  order by p.event_date desc, (count(distinct p.capper_id)) desc;
