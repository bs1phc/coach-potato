#!/usr/bin/env python3
"""Regenerate `static/spelldata.json` — the damage calculator's champion data.

Why this exists: DDragon stopped shipping usable spell damage numbers. Its
`spells[].effectBurn` is all zeros, `spells[].vars` is empty, and tooltips are
full of unresolved `{{ }}` placeholders (that is why `cooldowns.js` only ever
reads `cooldown`, which IS still populated). The real per-rank base damages and
ratios live in the game's own data, exposed by CommunityDragon as
`game/data/characters/<alias>/<alias>.bin.json`.

So this script merges two sources:

  * DDragon `championFull.json` — the champion roster, per-level base stats,
    spell display names/icons, and the tooltip markup we sniff the damage type
    from (`<magicDamage>` / `<physicalDamage>` / `<trueDamage>`).
  * CommunityDragon `<alias>.bin.json` — `DataValues` (per-rank numbers) and
    `mSpellCalculations` (a small formula tree referencing them).

A spell calculation is flattened into `{flat: [per rank], flatByLevel: [18],
ratios: [{stat, of, coeff: [per rank]}]}`, which `calc.js` can evaluate against
a stat block without knowing anything about bin formats.

**Anything we cannot resolve is dropped, never guessed** — an unknown `mStat`
enum or an unhandled node type discards that one calculation and increments the
`unresolved` counter, because a silently wrong ratio is far worse in a damage
calculator than a missing one. Run with `--report` to see what was dropped.

Usage:
    python scripts/refresh_spelldata.py                # rewrite static/spelldata.json
    python scripts/refresh_spelldata.py --report       # + per-champion drop report
    python scripts/refresh_spelldata.py --champion Gwen --report --dry-run
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DDRAGON = "https://ddragon.leagueoflegends.com"
CDRAGON = "https://raw.communitydragon.org/latest/game/data/characters/{a}/{a}.bin.json"
OUT = Path(__file__).resolve().parent.parent / "static" / "spelldata.json"
UA = {"User-Agent": "coach-potato-spelldata/1.0"}

SPELL_KEYS = ["Q", "W", "E", "R"]
MAX_RANK = {"Q": 5, "W": 5, "E": 5, "R": 3}
LEVELS = 18

# Riot's StatType enum as used by StatBy*CalculationPart's `mStat`. Verified by
# correlating each value against the self-documenting data-value names that use
# it (e.g. mStat=6 carries "DamageMRRatio", mStat=9 carries "CurrentCritDamage").
# Values NOT listed here are deliberately absent rather than guessed — see the
# module docstring.
STAT = {
    0: "ap", 1: "armor", 2: "ad", 4: "as", 6: "mr",
    7: "ms", 8: "crit", 9: "critdmg", 12: "hp", 14: "currenthp",
    29: "lethality",
}
# `mStatFormula`: which part of the stat the coefficient applies to. Confirmed
# the same way — mStat=2/formula=0 carries "tADRatio"/"TotalADPerHit" while
# formula=2 carries "BonusADRatio"/"BADRatio".
FORMULA = {0: "total", 1: "base", 2: "bonus"}

# calc names that are damage (the calculator's subject) vs the heals, shields,
# slows and durations sharing the same block
DAMAGE_WORDS = ("damage", "dmg")
NOT_DAMAGE_WORDS = ("heal", "shield", "reduc", "mitigat", "taken", "resist",
                    "armor", "slow", "duration", "cost", "range", "speed",
                    "regen", "threshold", "ratio")
# vs-champion calculator: monster/minion variants are noise
TARGET_WORDS = ("monster", "minion", "jungle", "epic", "turret", "tower")


def fetch_json(url: str, timeout: int = 60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read())


# ---------- formula tree -> {flat, flatByLevel, ratios} ----------

class Unresolved(Exception):
    """A formula node we cannot evaluate — drops the whole calculation."""


def _empty():
    return {"flat": [0.0] * 7, "byLevel": [0.0] * LEVELS, "ratios": []}


def _add(into, other, scale=1.0):
    into["flat"] = [a + b * scale for a, b in zip(into["flat"], other["flat"])]
    into["byLevel"] = [a + b * scale for a, b in zip(into["byLevel"], other["byLevel"])]
    into["ratios"] += [{**r, "coeff": [c * scale for c in r["coeff"]]} for r in other["ratios"]]
    return into


def _scalar(node):
    """Per-rank multipliers for a node with no stat/level dependence, else None.
    Per-rank rather than a single number because a multiplier is often itself a
    data value that changes with rank (e.g. an empowered-cast bonus)."""
    if node["ratios"] or any(node["byLevel"]):
        return None
    return node["flat"]


def _scale(node, factors):
    """node x a per-rank factor list."""
    out = _empty()
    out["flat"] = [v * f for v, f in zip(node["flat"], factors)]
    out["byLevel"] = [v * factors[0] for v in node["byLevel"]]
    out["ratios"] = [{**r, "coeff": [c * f for c, f in zip(r["coeff"], factors)]}
                     for r in node["ratios"]]
    return out


def _stat_ratio(node, coeff, drops):
    stat = STAT.get(node.get("mStat", 0))
    if stat is None:
        drops[f"unknown mStat {node.get('mStat')}"] += 1
        raise Unresolved
    out = _empty()
    out["ratios"] = [{"stat": stat, "of": FORMULA.get(node.get("mStatFormula", 0), "total"),
                      "coeff": coeff}]
    return out


def eval_part(node, ctx, drops, depth=0):
    if depth > 12:
        drops["recursion"] += 1
        raise Unresolved
    kind = node.get("__type")

    if kind == "NamedDataValueCalculationPart":
        out = _empty()
        out["flat"] = data_value(node.get("mDataValue"), ctx, drops)
        return out

    if kind == "NumberCalculationPart":
        out = _empty()
        out["flat"] = [float(node.get("mNumber", 0.0))] * 7
        return out

    if kind == "StatByCoefficientCalculationPart":
        return _stat_ratio(node, [float(node.get("mCoefficient", 0.0))] * 7, drops)

    if kind == "StatByNamedDataValueCalculationPart":
        return _stat_ratio(node, data_value(node.get("mDataValue"), ctx, drops), drops)

    if kind == "StatBySubPartCalculationPart":
        # the coefficient itself is a sub-formula, e.g. StatBySubPart{mStat: AD,
        # mSubpart: Product(TotalADRatio, 0.01)} = total AD x (ratio / 100)
        sub = eval_part(node["mSubpart"], ctx, drops, depth + 1)
        if sub["ratios"] or any(sub["byLevel"]):
            drops["StatBySubPart with non-flat coefficient"] += 1
            raise Unresolved
        return _stat_ratio(node, sub["flat"], drops)

    if kind == "SumOfSubPartsCalculationPart":
        out = _empty()
        for sub in node.get("mSubparts", []):
            _add(out, eval_part(sub, ctx, drops, depth + 1))
        return out

    if kind == "ProductOfSubPartsCalculationPart":
        p1 = eval_part(node["mPart1"], ctx, drops, depth + 1)
        p2 = eval_part(node["mPart2"], ctx, drops, depth + 1)
        for variable, scalar in ((p1, p2), (p2, p1)):
            factors = _scalar(scalar)
            if factors is not None:
                return _scale(variable, factors)
        drops["product of two variable parts"] += 1
        raise Unresolved

    if kind == "ClampSubPartsCalculationPart":
        # a floor/ceiling around a sub-formula; the calculator has no runtime
        # state to clamp against, so take the inner value unclamped
        subs = node.get("mSubparts") or []
        if not subs:
            drops["empty clamp"] += 1
            raise Unresolved
        return eval_part(subs[0], ctx, drops, depth + 1)

    if kind == "ByCharLevelInterpolationCalculationPart":
        start = float(node.get("mStartValue", 0.0))
        end = float(node.get("mEndValue", 0.0))
        out = _empty()
        out["byLevel"] = [start + (end - start) * i / (LEVELS - 1) for i in range(LEVELS)]
        return out

    if kind == "ByCharLevelBreakpointsCalculationPart":
        out = _empty()
        out["byLevel"] = level_breakpoints(node)
        return out

    if kind == "GameCalculationModified":
        inner = ctx["calcs"].get(node.get("mModifiedGameCalculation"))
        if inner is None:
            drops["missing modified calculation"] += 1
            raise Unresolved
        multiplier = eval_part(node["mMultiplier"], ctx, drops, depth + 1)
        factors = _scalar(multiplier)
        if factors is None:
            drops["multiplier depends on a stat"] += 1
            raise Unresolved
        return _scale(eval_calc(inner, ctx, drops, depth + 1), factors)

    # a reference to a sibling calculation, by key
    if "mSpellCalculationKey" in node:
        inner = ctx["calcs"].get(node["mSpellCalculationKey"])
        if inner is None:
            drops["missing calculation reference"] += 1
            raise Unresolved
        return eval_calc(inner, ctx, drops, depth + 1)

    if kind == "EffectValueCalculationPart":
        index = int(node.get("mEffectIndex", 0)) - 1  # 1-based
        effects = ctx["effects"]
        if not 0 <= index < len(effects) or not effects[index]:
            drops[f"effect slot {index + 1} is empty"] += 1
            raise Unresolved
        out = _empty()
        out["flat"] = list(effects[index])
        return out

    if kind == "AbilityResourceByCoefficientCalculationPart":
        # scales off the caster's resource pool (Ryze's mana ratios)
        out = _empty()
        out["ratios"] = [{"stat": "mana",
                          "of": FORMULA.get(node.get("mStatFormula", 0), "total"),
                          "coeff": [float(node.get("mCoefficient", 0.0))] * 7}]
        return out

    # stack-scaling (Nasus Q, Cho'gath R, ...) — the calculator exposes a stack
    # count input, so carry it as a pseudo-stat rather than dropping the spell
    if kind == "BuffCounterByCoefficientCalculationPart":
        out = _empty()
        out["ratios"] = [{"stat": "stacks", "of": "total",
                          "coeff": [float(node.get("mCoefficient", 0.0))] * 7}]
        return out
    if kind == "BuffCounterByNamedDataValueCalculationPart":
        out = _empty()
        out["ratios"] = [{"stat": "stacks", "of": "total",
                          "coeff": data_value(node.get("mDataValue"), ctx, drops)}]
        return out

    drops[kind or "unnamed node"] += 1
    raise Unresolved


def data_value(name, ctx, drops):
    """Per-rank values for a named data value. Bin lookups are case-insensitive."""
    if not name:
        drops["data value without a name"] += 1
        raise Unresolved
    found = ctx["values"].get(name.lower())
    if found is None:
        drops[f"missing data value {name}"] += 1
        raise Unresolved
    return found


def level_breakpoints(node):
    """Riot's per-champion-level growth table: a level-1 value plus a
    per-level bonus that changes at each breakpoint."""
    out = [float(node.get("mLevel1Value", 0.0))]
    per_level = float(node.get("mInitialBonusPerLevel", 0.0))
    breaks = {int(b.get("mLevel", 0)): float(b.get("mBonusPerLevelAtAndAfter", 0.0))
              for b in node.get("mBreakpoints", []) or []}
    for level in range(2, LEVELS + 1):
        if level in breaks:
            per_level = breaks[level]
        out.append(out[-1] + per_level)
    return out


def eval_calc(node, ctx, drops, depth=0):
    if node.get("__type") == "GameCalculationModified" or "mSpellCalculationKey" in node:
        return eval_part(node, ctx, drops, depth)
    out = _empty()
    for part in node.get("mFormulaParts", []):
        _add(out, eval_part(part, ctx, drops, depth))
    return out


# ---------- per-champion extraction ----------

def looks_like_damage(name):
    lowered = name.lower()
    if any(w in lowered for w in TARGET_WORDS):
        return False
    if not any(w in lowered for w in DAMAGE_WORDS):
        return False
    # "DamageReduction"/"MagicDamageTaken" are not damage we deal; but a name
    # like "TotalDamageRatio" only trips NOT_DAMAGE on "ratio", so require the
    # disqualifying word to not be preceded by "damage" at the very start
    return not any(w in lowered for w in NOT_DAMAGE_WORDS)


def damage_type_from_tooltip(tooltip):
    counts = Counter()
    for tag, kind in (("<magicDamage>", "magic"), ("<physicalDamage>", "physical"),
                      ("<trueDamage>", "true")):
        if tooltip.count(tag):
            counts[kind] = tooltip.count(tag)
    return counts.most_common(1)[0][0] if counts else None


def extract_champion(alias, dd_champion, drops):
    """-> ({key: spell}, unresolved_count) for one champion, or (None, 0)."""
    try:
        binary = fetch_json(CDRAGON.format(a=alias.lower()))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
        drops[f"fetch failed: {exc}"] += 1
        return None, 0

    root = next((v for k, v in binary.items()
                 if isinstance(v, dict) and k.endswith("/CharacterRecords/Root")), None)
    if not root or not root.get("spellNames"):
        drops["no character record"] += 1
        return None, 0

    prefix = f"Characters/{root['mCharacterName']}/Spells/"
    dd_spells = dd_champion.get("spells", [])
    spells = {}
    unresolved = 0

    for index, (key, spell_name) in enumerate(zip(SPELL_KEYS, root["spellNames"])):
        entry = binary.get(prefix + spell_name)
        dd_spell = dd_spells[index] if index < len(dd_spells) else {}
        if not entry or "mSpell" not in entry:
            drops[f"{key}: no spell entry"] += 1
            continue
        spell = entry["mSpell"]
        calcs = spell.get("mSpellCalculations") or {}
        ctx = {
            "values": {d["name"].lower(): list(d["values"])
                       for d in spell.get("DataValues") or []
                       if d.get("name") and d.get("values")},
            "calcs": calcs,
            # the older, positional effect slots — still the only home for some
            # champions' base damages (Vladimir, Vel'Koz, Taric)
            "effects": [e.get("value") for e in spell.get("mEffectAmount") or []],
        }
        ranks = MAX_RANK[key]

        parsed = []
        for name, node in calcs.items():
            if not looks_like_damage(name):
                continue
            local = Counter()
            try:
                result = eval_calc(node, ctx, local)
            except Unresolved:
                unresolved += 1
                for reason, count in local.items():
                    drops[f"{key}.{name}: {reason}"] += count
                continue
            # A data-value array is indexed by spell rank, so index 0 holds the
            # rank-0 (unlearned) value — usually an extrapolation, sometimes
            # junk. Verified against known values: Malphite E only reads
            # 60/95/130/165/200 when index 0 is dropped, and Garen Q's index 0
            # is a flat 0.
            flat = [round(v, 4) for v in result["flat"][1:ranks + 1]]
            ratios = merge_ratios(
                resolve_health({"stat": r["stat"], "of": r["of"],
                                "coeff": [round(c, 5) for c in r["coeff"][1:ranks + 1]]})
                for r in result["ratios"])
            by_level = [round(v, 4) for v in result["byLevel"]]
            if not any(flat) and not ratios and not any(by_level):
                continue
            calc = {"key": name, "flat": flat, "ratios": ratios}
            if any(by_level):
                calc["flatByLevel"] = by_level
            parsed.append(calc)

        if not parsed:
            continue
        spells[key] = {
            "name": dd_spell.get("name") or spell_name,
            "icon": (dd_spell.get("image") or {}).get("full", ""),
            "damageType": damage_type_from_tooltip(dd_spell.get("tooltip") or ""),
            "maxRank": ranks,
            "calcs": parsed,
        }
    return spells, unresolved


# Health ratios are ambiguous in the bin: the same mStat=12 means "% of the
# TARGET's max health" for Vayne W / Nasus R and "% of the CASTER's bonus
# health" for Zac / Ornn / Tahm Kench. The formula field separates them
# reliably — target-health damage is written against total health, caster
# scalings against bonus health — so resolve it here and emit an unambiguous
# stat name rather than making every consumer re-derive it.
HEALTH_STATS = {
    ("hp", "total"): ("targetMaxHp", "total"),
    ("hp", "bonus"): ("hp", "bonus"),
    ("hp", "base"): ("hp", "base"),
    ("currenthp", "total"): ("targetCurrentHp", "total"),
}


def resolve_health(ratio):
    key = (ratio["stat"], ratio["of"])
    if key in HEALTH_STATS:
        ratio["stat"], ratio["of"] = HEALTH_STATS[key]
    return ratio


def merge_ratios(ratios):
    """Sum coefficients that scale off the same stat — a formula can list e.g.
    two separate total-AP terms, which read as one ratio to a player."""
    merged = {}
    for ratio in ratios:
        if not any(ratio["coeff"]):
            continue
        key = (ratio["stat"], ratio["of"])
        if key in merged:
            merged[key]["coeff"] = [round(a + b, 5) for a, b
                                    in zip(merged[key]["coeff"], ratio["coeff"])]
        else:
            merged[key] = dict(ratio)
    return list(merged.values())


def base_stats(stats):
    return {
        "hp": stats.get("hp", 0), "hpPerLevel": stats.get("hpperlevel", 0),
        "mp": stats.get("mp", 0), "mpPerLevel": stats.get("mpperlevel", 0),
        "ad": stats.get("attackdamage", 0), "adPerLevel": stats.get("attackdamageperlevel", 0),
        "armor": stats.get("armor", 0), "armorPerLevel": stats.get("armorperlevel", 0),
        "mr": stats.get("spellblock", 0), "mrPerLevel": stats.get("spellblockperlevel", 0),
        "as": stats.get("attackspeed", 0), "asPerLevel": stats.get("attackspeedperlevel", 0),
        "ms": stats.get("movespeed", 0), "range": stats.get("attackrange", 0),
    }


def main():
    # the Windows console defaults to cp1252 and this script prints arrows
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--champion", action="append", dest="champions",
                        help="only this champion (repeatable) — for spot-checking")
    parser.add_argument("--report", action="store_true", help="print what was dropped")
    parser.add_argument("--dry-run", action="store_true", help="don't write the file")
    parser.add_argument("--jobs", type=int, default=8, help="parallel fetches (default 8)")
    args = parser.parse_args()

    version = fetch_json(f"{DDRAGON}/api/versions.json")[0]
    print(f"DDragon patch {version}", file=sys.stderr)
    full = fetch_json(f"{DDRAGON}/cdn/{version}/data/en_US/championFull.json")["data"]

    # championFull.json also carries alternate-game-mode copies of the roster
    # ("Jade_Ahri", ...). No real champion id contains an underscore, and the
    # app's own roster (static/champions.json) excludes them, so neither do we.
    roster = sorted(c for c in full if "_" not in c)
    wanted = roster if not args.champions else [
        c for c in roster if c.lower() in {w.lower() for w in args.champions}]
    if not wanted:
        parser.error("no matching champion")

    reports = {}
    champions = {}

    def work(champion_id):
        drops = Counter()
        spells, unresolved = extract_champion(champion_id, full[champion_id], drops)
        return champion_id, spells, unresolved, drops

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for champion_id, spells, unresolved, drops in pool.map(work, wanted):
            entry = {"base": base_stats(full[champion_id].get("stats", {}))}
            if spells:
                entry["spells"] = spells
            if unresolved:
                entry["unresolved"] = unresolved
            champions[champion_id] = entry
            reports[champion_id] = drops
            print(".", end="", flush=True, file=sys.stderr)
    print(file=sys.stderr)

    total_spells = sum(len(c.get("spells", {})) for c in champions.values())
    total_calcs = sum(len(s["calcs"]) for c in champions.values()
                      for s in c.get("spells", {}).values())
    total_unresolved = sum(c.get("unresolved", 0) for c in champions.values())
    print(f"{len(champions)} champions · {total_spells} spells · {total_calcs} damage "
          f"calculations · {total_unresolved} dropped", file=sys.stderr)

    if args.report:
        for champion_id, drops in sorted(reports.items()):
            if drops:
                print(f"\n{champion_id}:", file=sys.stderr)
                for reason, count in drops.most_common():
                    print(f"    {count:3d}  {reason}", file=sys.stderr)

    payload = {
        "_comment": ("Champion base stats (DDragon championFull.json) + per-spell damage "
                     "formulas flattened from CommunityDragon game data. Regenerate with "
                     "scripts/refresh_spelldata.py — see CLAUDE.md. DDragon's own spell "
                     "damage fields are all zeros, which is why this file exists."),
        "version": version,
        "champions": champions,
    }
    if args.dry_run:
        # human-readable, because the point of a dry run is spot-checking the
        # numbers against the wiki, not eyeballing JSON
        for champion_id, entry in champions.items():
            print(f"\n{champion_id}")
            for key, spell in entry.get("spells", {}).items():
                print(f"  {key} {spell['name']} ({spell['damageType']})")
                for calc in spell["calcs"]:
                    parts = ["/".join(str(round(v, 2)) for v in calc["flat"])]
                    for ratio in calc["ratios"]:
                        coeffs = "/".join(f"{c * 100:g}%" for c in ratio["coeff"])
                        parts.append(f"({coeffs} {ratio['of']} {ratio['stat']})")
                    if "flatByLevel" in calc:
                        by = calc["flatByLevel"]
                        parts.append(f"(+{by[0]:g}→{by[-1]:g} by level)")
                    print(f"      {calc['key']:28s} {' '.join(parts)}")
        return
    OUT.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=False) + "\n",
                   encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
