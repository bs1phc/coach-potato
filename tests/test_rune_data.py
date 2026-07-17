from server import rune_data


def test_decode_perks_full_page():
    perks = {
        "statPerks": {"offense": 5008, "flex": 5002, "defense": 5011},
        "styles": [
            {"description": "primaryStyle", "style": 8000, "selections": [
                {"perk": 8010}, {"perk": 9111}, {"perk": 9104}, {"perk": 8299}]},
            {"description": "subStyle", "style": 8400, "selections": [
                {"perk": 8473}, {"perk": 8451}]},
        ],
    }
    decoded = rune_data.decode_perks(perks)
    assert decoded == {
        "label": "",
        "primary_tree": "Precision",
        "keystone": "Conqueror",
        "primary_runes": ["Triumph", "Legend: Alacrity", "Last Stand"],
        "secondary_tree": "Resolve",
        "secondary_runes": ["Bone Plating", "Overgrowth"],
        "shards": ["Adaptive Force", "Armor", "Health"],
    }


def test_decode_perks_none_and_malformed():
    assert rune_data.decode_perks(None) is None
    assert rune_data.decode_perks({}) is None
    assert rune_data.decode_perks({"styles": []}) is None
    assert rune_data.decode_perks({"styles": [
        {"description": "primaryStyle", "style": 8000, "selections": []},
    ]}) is None  # missing subStyle


def test_decode_perks_unknown_ids_become_blank():
    perks = {
        "statPerks": {"offense": 99999, "flex": 5002, "defense": 5011},
        "styles": [
            {"description": "primaryStyle", "style": 8000, "selections": [
                {"perk": 99999}, {"perk": 9111}, {"perk": 9104}, {"perk": 8299}]},
            {"description": "subStyle", "style": 8400, "selections": [
                {"perk": 8473}, {"perk": 8451}]},
        ],
    }
    decoded = rune_data.decode_perks(perks)
    assert decoded["keystone"] == ""
    assert decoded["shards"][0] == ""


def test_name_sets_are_populated():
    assert "Precision" in rune_data.TREE_NAMES
    assert "Conqueror" in rune_data.RUNE_NAMES
    assert "Adaptive Force" in rune_data.SHARD_NAMES
