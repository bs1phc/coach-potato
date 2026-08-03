"""Guards for the damage calculator's champion data.

Two halves: the pure formula-flattening in scripts/refresh_spelldata.py (which
turns Riot's nested calculation trees into flat per-rank numbers, and is where a
silent mistake would produce plausible-but-wrong damage), and the shape of the
generated static/spelldata.json that the frontend reads.

No network — the generator's fetching is not exercised here, only its parsing.
"""
import importlib.util
import json
from collections import Counter
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SPELLDATA = ROOT / "static" / "spelldata.json"


def _load_generator():
    spec = importlib.util.spec_from_file_location(
        "refresh_spelldata", ROOT / "scripts" / "refresh_spelldata.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gen = _load_generator()


def ctx(values=None, calcs=None, effects=None):
    return {"values": {k.lower(): v for k, v in (values or {}).items()},
            "calcs": calcs or {}, "effects": effects or []}


def flatten(node, **kwargs):
    return gen.eval_calc(node, ctx(**kwargs), Counter())


# ---------- formula flattening ----------

def test_flat_base_damage_and_ap_ratio():
    """The common shape: a per-rank base plus a ratio off a named data value."""
    node = {"__type": "GameCalculation", "mFormulaParts": [
        {"__type": "NamedDataValueCalculationPart", "mDataValue": "BaseDamage"},
        {"__type": "StatByNamedDataValueCalculationPart", "mDataValue": "APRatio"},
    ]}
    result = flatten(node, values={"BaseDamage": [0, 70, 120, 170, 220, 270, 320],
                                   "APRatio": [0.6] * 7})
    assert result["flat"][1:6] == [70, 120, 170, 220, 270]
    assert result["ratios"] == [{"stat": "ap", "of": "total", "coeff": [0.6] * 7}]


def test_data_value_lookup_is_case_insensitive():
    node = {"__type": "GameCalculation", "mFormulaParts": [
        {"__type": "NamedDataValueCalculationPart", "mDataValue": "tADRatio"}]}
    assert flatten(node, values={"TADRATIO": [1] * 7})["flat"] == [1] * 7


def test_stat_formula_maps_to_total_base_bonus():
    def ratio_of(formula):
        node = {"__type": "GameCalculation", "mFormulaParts": [
            {"__type": "StatByCoefficientCalculationPart", "mStat": 2,
             "mStatFormula": formula, "mCoefficient": 1.4}]}
        return flatten(node)["ratios"][0]["of"]

    assert ratio_of(0) == "total"
    assert ratio_of(2) == "bonus"


def test_unknown_stat_is_dropped_not_guessed():
    """A stat enum we have not verified must discard the calculation — a wrong
    ratio is worse than a missing one."""
    node = {"__type": "GameCalculation", "mFormulaParts": [
        {"__type": "StatByCoefficientCalculationPart", "mStat": 999, "mCoefficient": 1.0}]}
    with pytest.raises(gen.Unresolved):
        flatten(node)


def test_unknown_node_type_is_dropped():
    node = {"__type": "GameCalculation", "mFormulaParts": [
        {"__type": "SomeFutureCalculationPart"}]}
    with pytest.raises(gen.Unresolved):
        flatten(node)


def test_product_scales_a_variable_by_a_constant():
    node = {"__type": "GameCalculation", "mFormulaParts": [{
        "__type": "ProductOfSubPartsCalculationPart",
        "mPart1": {"__type": "NamedDataValueCalculationPart", "mDataValue": "Base"},
        "mPart2": {"__type": "NumberCalculationPart", "mNumber": 0.5},
    }]}
    assert flatten(node, values={"Base": [10] * 7})["flat"] == [5] * 7


def test_modified_calculation_multiplies_the_one_it_references():
    calcs = {"TotalDamage": {"__type": "GameCalculation", "mFormulaParts": [
        {"__type": "NamedDataValueCalculationPart", "mDataValue": "Base"},
        {"__type": "StatByCoefficientCalculationPart", "mCoefficient": 0.1}]}}
    node = {"__type": "GameCalculationModified", "mModifiedGameCalculation": "TotalDamage",
            "mMultiplier": {"__type": "NumberCalculationPart", "mNumber": 3.0}}
    result = flatten(node, values={"Base": [10] * 7}, calcs=calcs)
    assert result["flat"] == [30] * 7
    # the ratio has to be tripled too, not just the flat part
    assert result["ratios"][0]["coeff"] == pytest.approx([0.3] * 7)


def test_effect_value_part_reads_the_positional_effect_slots():
    node = {"__type": "GameCalculation", "mFormulaParts": [
        {"__type": "EffectValueCalculationPart", "mEffectIndex": 2}]}
    result = flatten(node, effects=[[1] * 7, [80, 100, 120, 140, 160, 180, 200]])
    assert result["flat"] == [80, 100, 120, 140, 160, 180, 200]


def test_empty_effect_slot_is_dropped():
    node = {"__type": "GameCalculation", "mFormulaParts": [
        {"__type": "EffectValueCalculationPart", "mEffectIndex": 1}]}
    with pytest.raises(gen.Unresolved):
        flatten(node, effects=[None])


def test_char_level_breakpoints_build_an_18_entry_table():
    node = {"mLevel1Value": 30.0, "mInitialBonusPerLevel": 5.0, "mBreakpoints": [
        {"mLevel": 11, "mBonusPerLevelAtAndAfter": 10.0}]}
    table = gen.level_breakpoints(node)
    assert len(table) == 18
    assert table[0] == 30.0
    assert table[9] == 30.0 + 9 * 5.0          # levels 2-10 at +5
    assert table[10] == table[9] + 10.0        # level 11 switches to +10


# ---------- interpretation rules ----------

def test_health_ratios_split_target_from_caster():
    """% of TOTAL health is the target's (Vayne W, Nasus R); % of BONUS health
    is the caster's own (Zac, Ornn). Same enum, opposite meaning."""
    assert gen.resolve_health({"stat": "hp", "of": "total"})["stat"] == "targetMaxHp"
    caster = gen.resolve_health({"stat": "hp", "of": "bonus"})
    assert caster["stat"] == "hp" and caster["of"] == "bonus"


def test_merge_ratios_sums_the_same_stat():
    merged = gen.merge_ratios([
        {"stat": "ap", "of": "total", "coeff": [0.35] * 5},
        {"stat": "ap", "of": "total", "coeff": [0.25] * 5},
        {"stat": "ad", "of": "bonus", "coeff": [1.0] * 5},
    ])
    assert len(merged) == 2
    assert merged[0]["coeff"] == pytest.approx([0.6] * 5)


def test_merge_ratios_drops_all_zero_coefficients():
    assert gen.merge_ratios([{"stat": "ap", "of": "total", "coeff": [0] * 5}]) == []


def test_damage_calcs_are_told_apart_from_heals_and_shields():
    assert gen.looks_like_damage("TotalDamage")
    assert gen.looks_like_damage("BladeDamage")
    assert not gen.looks_like_damage("ShieldAmount")
    assert not gen.looks_like_damage("HealDamageTooltip")   # a heal, not damage
    assert not gen.looks_like_damage("DamageReduction")
    assert not gen.looks_like_damage("MonsterDamage")       # vs champions only
    assert not gen.looks_like_damage("Cooldown")


def test_damage_type_comes_from_the_tooltip_markup():
    assert gen.damage_type_from_tooltip("deals <magicDamage>50</magicDamage>") == "magic"
    assert gen.damage_type_from_tooltip("<trueDamage>x</trueDamage>") == "true"
    assert gen.damage_type_from_tooltip("no markup here") is None


# ---------- the generated asset ----------

@pytest.fixture(scope="module")
def spelldata():
    if not SPELLDATA.exists():
        pytest.skip("static/spelldata.json not generated")
    return json.loads(SPELLDATA.read_text(encoding="utf-8"))


def test_every_roster_champion_has_base_stats(spelldata):
    roster = {c["id"] for c in json.loads(
        (ROOT / "static" / "champions.json").read_text(encoding="utf-8"))["champions"]}
    missing = roster - set(spelldata["champions"])
    assert not missing, f"champions with no calculator data: {sorted(missing)}"


def test_no_alternate_game_mode_duplicates(spelldata):
    """championFull.json also ships "Jade_Ahri"-style copies; they are not
    selectable in the app and only bloat the asset."""
    assert not [c for c in spelldata["champions"] if "_" in c]


def test_base_stats_are_complete(spelldata):
    required = {"hp", "hpPerLevel", "ad", "adPerLevel", "armor", "armorPerLevel",
                "mr", "mrPerLevel", "as", "asPerLevel", "mp", "mpPerLevel"}
    for name, champion in spelldata["champions"].items():
        assert required <= set(champion["base"]), name


def test_calc_shapes_are_consistent(spelldata):
    """Each ratio's per-rank coefficients must line up with the base values, or
    the frontend would index past the end of the array."""
    known_stats = set(gen.STAT.values()) | {"targetMaxHp", "targetCurrentHp",
                                            "stacks", "mana"}
    for name, champion in spelldata["champions"].items():
        for key, spell in (champion.get("spells") or {}).items():
            assert spell["maxRank"] in (3, 5), (name, key)
            for calc in spell["calcs"]:
                where = f"{name} {key} {calc['key']}"
                assert len(calc["flat"]) == spell["maxRank"], where
                assert calc["flat"] or calc["ratios"] or calc.get("flatByLevel"), where
                for ratio in calc["ratios"]:
                    assert ratio["stat"] in known_stats, f"{where}: {ratio['stat']}"
                    assert ratio["of"] in ("total", "base", "bonus"), where
                    assert len(ratio["coeff"]) == spell["maxRank"], where
                if "flatByLevel" in calc:
                    assert len(calc["flatByLevel"]) == 18, where


def test_known_champion_values_are_right(spelldata):
    """Spot-checks against values that can be read off the game client. These
    caught a rank off-by-one: the data-value arrays are indexed by spell rank,
    so index 0 holds the rank-0 (unlearned) value."""
    malphite_e = spelldata["champions"]["Malphite"]["spells"]["E"]["calcs"]
    ground_slam = next(c for c in malphite_e if c["key"] == "EDamageCalc")
    assert ground_slam["flat"] == [60, 95, 130, 165, 200]

    darius_r = spelldata["champions"]["Darius"]["spells"]["R"]
    assert darius_r["damageType"] == "true"
    guillotine = next(c for c in darius_r["calcs"] if c["key"] == "Damage")
    assert guillotine["flat"] == [125, 250, 375]
    ad_ratio = next(r for r in guillotine["ratios"] if r["stat"] == "ad")
    assert ad_ratio["of"] == "bonus"
