# Lane Metrics + Trends View — Design

**Date:** 2026-07-04
**Status:** Approved by user (metric list + backfill signed off; trends view
"execute without clarification").

## Purpose

Track ~22 additional laning/teamfight/objective/vision metrics from match-v5
`challenges` + participant fields, (a) per coaching segment with the existing
delta logic, and (b) over time in a new **Trends** view with per-metric graphs
and a day/week/month breakdown table.

## Metric registry (single source of truth)

`server/metrics.py` defines `METRICS`: list of dicts
`{key, label, group, source ('challenges'|'participant'|'derived'), field,
agg ('avg'|'pct01'|'per_min'|'pct_time'), direction (1|-1|0), decimals,
suffix}`. It drives: DDL columns, payload parsing, SQL aggregation
expressions, and the JSON `meta` sent to the frontend. Groups:

1. **Laning**: cs_at_10 (laneMinionsFirst10Minutes), lane_adv_early
   (earlyLaningPhaseGoldExpAdvantage, pct01), lane_adv_late
   (laningPhaseGoldExpAdvantage, pct01), max_cs_lead
   (maxCsAdvantageOnLaneOpponent), max_level_lead (maxLevelLeadLaneOpponent),
   plates (turretPlatesTaken), solo_kills (soloKills), early_takedowns
   (takedownsFirstXMinutes).
2. **Damage & fighting**: team_dmg_pct (teamDamagePercentage, pct01),
   kill_participation (killParticipation, pct01), dmg_taken_team_pct
   (damageTakenOnTeamPercentage, pct01, direction 0), skillshots_dodged
   (skillshotsDodged), self_mitigated (participant.damageSelfMitigated,
   per_min).
3. **Objectives & map**: turret_takedowns, turret_damage
   (participant.damageDealtToTurrets), tp_takedowns (teleportTakedowns),
   herald_takedowns (riftHeraldTakedowns).
4. **Vision & survival**: vision_per_min (visionScorePerMinute), vision_adv
   (visionScoreAdvantageLaneOpponent), control_wards (controlWardsPlaced),
   ward_takedowns (wardTakedowns), time_dead (participant.totalTimeSpentDead,
   pct_time, direction -1).

Aggregations: `avg` = AVG(col); `pct01` = 100*AVG(col); `per_min` =
60*SUM(col)/SUM(game_duration_s); `pct_time` =
100*SUM(col)/SUM(game_duration_s). AVG/SUM ignore NULLs (missing on old
matches) — `per_min`/`pct_time` sums must only include rows where col IS NOT
NULL (guard duration with CASE).

## Storage

`participant_metrics(match_id, puuid, has_challenges, <one column per
metric>, PRIMARY KEY(match_id, puuid))` — raw per-game values, populated
**only for tracked players' rows**. `parse_metrics(match_json, puuid) ->
dict|None` in `server/metrics.py` (None when participant absent). Missing
individual fields → NULL. `db.insert_participant_metrics(conn, match_id,
puuid, values)` (INSERT OR REPLACE).

Crawler: on storing a new match, insert metrics for any tracked participant.
`Crawler.backfill_metrics(limit=None)` re-fetches details of stored matches
that have a tracked participant but no participant_metrics row; safe to
interrupt/resume. CLI: `./crawl.sh --backfill-metrics` (skips normal crawl).

## Stats

- `_BASE` LEFT JOINs participant_metrics (me's row) so all metric columns are
  available in filtered subqueries.
- `segment_metrics(conn, puuids, from_ms, to_ms, champion=None, queues=None)
  -> {games, metrics_games, metrics: {key: value|None}}` (`metrics_games` =
  rows with a metrics record — coverage).
- `trend_buckets(conn, puuids, bucket='month', champion=None, queues=None) ->
  list[{bucket, from_label, games, wins, winrate, kda, cs_min, gold_min,
  dmg_min, avg_duration_s, metrics: {...}}]`, oldest→newest. Bucket exprs:
  day `%Y-%m-%d`, month `%Y-%m`, week = date of that week's Monday.

## API

- `GET /api/stats/metrics?from_ms&to_ms&champion&queue` → segment_metrics +
  `meta` (registry incl. labels/groups/direction/decimals/suffix).
- `GET /api/stats/trends?bucket=day|week|month&champion&queue` → buckets +
  `meta`. 400/422 on bad bucket.

## Frontend

**Coaching view**: expanding a Period now shows (1) the four metric groups as
compact rows (label — value — ▲/▼ delta vs previous non-empty segment;
direction-aware colors, gray for direction 0; "–" when NULL), fetched lazily
for the segment and its previous segment, cached like games; (2) a nested
**"Games (N) ▸"** expander containing the existing games table (one level
deeper).

**Trends view**: third entry in the main view switcher (`#trends` hash).
Controls: bucket toggle (Day / Week / **Month** default), champion select
(default All), queue select. Content:
- **Graph grid**: one small line chart per metric, grouped under headings —
  "Core" (games, winrate, KDA, CS/min, gold/min, DMG/min) then the four
  metric groups. Hand-rolled SVG: 2px blue line (--series-1), dots, y
  min/max labels, first/last x labels, winrate chart gets a dashed 50% ref
  line; shared tooltip on hover (bucket + value); charts with no data
  omitted.
- **Breakdown table** at the bottom: rows = buckets (newest first), columns
  = Core + all metrics with a group header row; horizontal scroll inside
  table-wrap.

## Testing

TDD: registry-driven DDL/parsing (fixture challenges), crawler metric insert
+ backfill (FakeClient), segment_metrics NULL handling + pct/per-min math,
trend bucketing (month/week/day edges), API shapes incl. meta. Screenshots:
expanded period with metric groups + nested games; trends view graphs+table.

## Out of scope

Timeline endpoint (per-minute curves), opponent metrics, CSV export of
trends, custom metric selection UI.
