"""Registry of coaching metrics extracted from match-v5 payloads.

The registry drives the participant_metrics DDL, payload parsing, SQL
aggregation and the metadata the frontend uses for labels/grouping/deltas.

agg kinds:
  avg      — AVG(col)
  pct01    — 100 * AVG(col)          (0..1 ratios and 0/1 flags)
  per_min  — 60 * SUM(col) / SUM(duration of rows where col present)
  pct_time — 100 * SUM(col) / SUM(duration of rows where col present)

direction: 1 = higher is better, -1 = lower is better, 0 = neutral.
"""


def _metric(key, label, group, field, source="challenges", agg="avg",
            direction=1, decimals=1, suffix="", default_hidden=False, signed=False):
    return {"key": key, "label": label, "group": group, "field": field,
            "source": source, "agg": agg, "direction": direction,
            "decimals": decimals, "suffix": suffix,
            # default_hidden: off in each view's column picker until ticked.
            # signed: show a leading + for positive values (deltas).
            "default_hidden": default_hidden, "signed": signed}


METRICS = [
    # --- Laning ---
    _metric("cs_at_10", "CS @ 10 min", "Laning", "laneMinionsFirst10Minutes"),
    _metric("lane_adv_early", "Ahead in lane @ ~7 min", "Laning",
            "earlyLaningPhaseGoldExpAdvantage", agg="pct01", decimals=0, suffix="%"),
    _metric("lane_adv_late", "Ahead in lane @ ~14 min", "Laning",
            "laningPhaseGoldExpAdvantage", agg="pct01", decimals=0, suffix="%"),
    _metric("max_cs_lead", "Max CS lead on opponent", "Laning",
            "maxCsAdvantageOnLaneOpponent"),
    _metric("max_level_lead", "Max level lead on opponent", "Laning",
            "maxLevelLeadLaneOpponent", decimals=2),
    _metric("plates", "Turret plates taken", "Laning", "turretPlatesTaken", decimals=2),
    _metric("solo_kills", "Solo kills", "Laning", "soloKills", decimals=2),
    _metric("early_takedowns", "Takedowns before ~15 min", "Laning",
            "takedownsFirstXMinutes", decimals=2),
    # --- Lane deltas vs the direct lane opponent, from the match timeline
    # (source="timeline"): my value minus theirs at the frame nearest 7/14
    # min. Hidden by default; None when there's no lane opponent or the game
    # ended before the mark. See metrics.parse_timeline_deltas / crawler. ---
    _metric("cs_diff_7", "ΔCS (7m)", "Laning", "cs_diff_7", source="timeline",
            decimals=1, default_hidden=True, signed=True),
    _metric("level_diff_7", "ΔLevel (7m)", "Laning", "level_diff_7", source="timeline",
            decimals=2, default_hidden=True, signed=True),
    _metric("gold_diff_7", "ΔGold (7m)", "Laning", "gold_diff_7", source="timeline",
            decimals=0, default_hidden=True, signed=True),
    _metric("cs_diff_14", "ΔCS (14m)", "Laning", "cs_diff_14", source="timeline",
            decimals=1, default_hidden=True, signed=True),
    _metric("level_diff_14", "ΔLevel (14m)", "Laning", "level_diff_14", source="timeline",
            decimals=2, default_hidden=True, signed=True),
    _metric("gold_diff_14", "ΔGold (14m)", "Laning", "gold_diff_14", source="timeline",
            decimals=0, default_hidden=True, signed=True),
    # --- Damage & fighting ---
    _metric("team_dmg_pct", "Share of team's damage", "Damage & fighting",
            "teamDamagePercentage", agg="pct01", suffix="%"),
    _metric("kill_participation", "Kill participation", "Damage & fighting",
            "killParticipation", agg="pct01", decimals=0, suffix="%"),
    _metric("dmg_taken_team_pct", "Share of team's damage taken", "Damage & fighting",
            "damageTakenOnTeamPercentage", agg="pct01", direction=0, suffix="%"),
    _metric("skillshots_dodged", "Skillshots dodged", "Damage & fighting",
            "skillshotsDodged"),
    _metric("self_mitigated", "Damage self-mitigated / min", "Damage & fighting",
            "damageSelfMitigated", source="participant", agg="per_min", decimals=0),
    # --- Objectives & map ---
    _metric("turret_takedowns", "Turret takedowns", "Objectives & map",
            "turretTakedowns", decimals=2),
    _metric("turret_damage", "Damage to turrets", "Objectives & map",
            "damageDealtToTurrets", source="participant", decimals=0),
    _metric("tp_takedowns", "Teleport takedowns", "Objectives & map",
            "teleportTakedowns", decimals=2),
    _metric("herald_takedowns", "Rift Herald takedowns", "Objectives & map",
            "riftHeraldTakedowns", decimals=2),
    # --- Vision & survival ---
    _metric("vision_per_min", "Vision score / min", "Vision & survival",
            "visionScorePerMinute", decimals=2),
    _metric("vision_adv", "Vision advantage vs opponent", "Vision & survival",
            "visionScoreAdvantageLaneOpponent", decimals=2),
    _metric("control_wards", "Control wards placed", "Vision & survival",
            "controlWardsPlaced", decimals=2),
    _metric("ward_takedowns", "Ward takedowns", "Vision & survival",
            "wardTakedowns", decimals=2),
    _metric("time_dead", "Time dead (% of game)", "Vision & survival",
            "totalTimeSpentDead", source="participant", agg="pct_time",
            direction=-1, suffix="%"),
]

GROUPS = ["Laning", "Damage & fighting", "Objectives & map", "Vision & survival"]


def metric_keys():
    return [m["key"] for m in METRICS]


def parse_metrics(match_json, puuid):
    """Extract raw metric values for one participant. None if puuid absent."""
    participant = next(
        (p for p in match_json["info"]["participants"] if p["puuid"] == puuid), None)
    if participant is None:
        return None
    challenges = participant.get("challenges") or {}
    values = {"has_challenges": int(bool(challenges))}
    for m in METRICS:
        if m["source"] == "timeline":
            values[m["key"]] = None  # filled separately from the match timeline
        elif m["source"] == "participant":
            values[m["key"]] = participant.get(m["field"])
        else:
            values[m["key"]] = challenges.get(m["field"])
    return values


# frame timestamps (ms) we sample the timeline at; a frame must land within
# FRAME_TOLERANCE_MS of the mark (games that ended earlier yield None)
LANE_DELTA_MARKS = {7: 420_000, 14: 840_000}
FRAME_TOLERANCE_MS = 90_000
TIMELINE_KEYS = [m["key"] for m in METRICS if m["source"] == "timeline"]


def _frame_near(frames, target_ms):
    """Frame whose timestamp is closest to target_ms, or None if none is
    within FRAME_TOLERANCE_MS (e.g. the game ended before the mark)."""
    best, best_gap = None, None
    for f in frames:
        gap = abs(f.get("timestamp", 0) - target_ms)
        if best_gap is None or gap < best_gap:
            best, best_gap = f, gap
    if best is None or best_gap > FRAME_TOLERANCE_MS:
        return None
    return best


def _cs(pf):
    return (pf.get("minionsKilled") or 0) + (pf.get("jungleMinionsKilled") or 0)


def parse_timeline_deltas(timeline_json, me_puuid, opp_puuid):
    """CS/level/gold advantage of me_puuid over opp_puuid at ~7 and ~14 min,
    read from the match-v5 timeline. Returns {timeline metric key: value},
    each None when the opponent is unknown or the frame is missing."""
    blank = {k: None for k in TIMELINE_KEYS}
    if not timeline_json or not opp_puuid:
        return blank
    info = timeline_json.get("info") or {}
    pid_by_puuid = {p.get("puuid"): p.get("participantId")
                    for p in info.get("participants") or []}
    me_pid, opp_pid = pid_by_puuid.get(me_puuid), pid_by_puuid.get(opp_puuid)
    frames = info.get("frames") or []
    if me_pid is None or opp_pid is None or not frames:
        return blank
    out = dict(blank)
    for minute, target in LANE_DELTA_MARKS.items():
        frame = _frame_near(frames, target)
        if not frame:
            continue
        pf = frame.get("participantFrames") or {}
        mine, theirs = pf.get(str(me_pid)), pf.get(str(opp_pid))
        if not mine or not theirs:
            continue
        out[f"cs_diff_{minute}"] = _cs(mine) - _cs(theirs)
        out[f"level_diff_{minute}"] = (mine.get("level") or 0) - (theirs.get("level") or 0)
        out[f"gold_diff_{minute}"] = (mine.get("totalGold") or 0) - (theirs.get("totalGold") or 0)
    return out
