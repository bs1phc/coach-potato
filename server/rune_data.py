"""Loads static/runes.json once. Provides name-set lookups for loose champ-
guide validation (see app.py) and numeric id->name lookups + a decoder for
turning a match-v5 participant's `perks` payload into our rune-page shape
(see crawler.py, which stores the decoded result per tracked participant).
"""
import json

from .config import PROJECT_ROOT


def _load():
    try:
        return json.loads((PROJECT_ROOT / "static" / "runes.json").read_text())
    except (OSError, ValueError):
        return {"trees": [], "shardRows": []}  # data file missing/corrupt


_DATA = _load()
_ALL_RUNES = [r for t in _DATA["trees"] for row in t["rows"] for r in row["runes"]]
_ALL_SHARDS = [s for row in _DATA["shardRows"] for s in row["shards"]]

TREE_NAMES = {t["name"] for t in _DATA["trees"]}
RUNE_NAMES = {r["name"] for r in _ALL_RUNES}
SHARD_NAMES = {s["name"] for s in _ALL_SHARDS}

TREE_ID_TO_NAME = {t["id"]: t["name"] for t in _DATA["trees"]}
RUNE_ID_TO_NAME = {r["id"]: r["name"] for r in _ALL_RUNES}
SHARD_ID_TO_NAME = {s["id"]: s["name"] for s in _ALL_SHARDS}

# name -> icon path, for server-side rendering (e.g. pdf_export.py) that
# needs the same icons the frontend hotlinks via runeIconUrl/shardIconUrl
# in guide.js (ddragon for trees/runes, CommunityDragon for shards).
TREE_ICON = {t["name"]: t["icon"] for t in _DATA["trees"]}
RUNE_ICON = {r["name"]: r["icon"] for r in _ALL_RUNES}
SHARD_ICON = {s["name"]: s["icon"] for s in _ALL_SHARDS}


def _padded(names, length):
    names = list(names)[:length]
    return names + [""] * (length - len(names))


def decode_perks(perks):
    """match-v5 participant["perks"] -> our rune-page shape (label always
    ''), or None if perks is missing/malformed."""
    if not perks:
        return None
    styles = perks.get("styles") or []
    primary = next((s for s in styles if s.get("description") == "primaryStyle"), None)
    secondary = next((s for s in styles if s.get("description") == "subStyle"), None)
    if not primary or not secondary:
        return None
    primary_sel = primary.get("selections") or []
    secondary_sel = secondary.get("selections") or []
    stat_perks = perks.get("statPerks") or {}
    return {
        "label": "",
        "primary_tree": TREE_ID_TO_NAME.get(primary.get("style"), ""),
        "keystone": RUNE_ID_TO_NAME.get(primary_sel[0]["perk"], "") if primary_sel else "",
        "primary_runes": _padded(
            [RUNE_ID_TO_NAME.get(s["perk"], "") for s in primary_sel[1:4]], 3),
        "secondary_tree": TREE_ID_TO_NAME.get(secondary.get("style"), ""),
        "secondary_runes": _padded(
            [RUNE_ID_TO_NAME.get(s["perk"], "") for s in secondary_sel[:2]], 2),
        "shards": [
            SHARD_ID_TO_NAME.get(stat_perks.get("offense"), ""),
            SHARD_ID_TO_NAME.get(stat_perks.get("flex"), ""),
            SHARD_ID_TO_NAME.get(stat_perks.get("defense"), ""),
        ],
    }
