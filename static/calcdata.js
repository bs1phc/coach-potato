"use strict";
/* Damage-calculator reference data: how an item's or rune's text becomes
   numbers. Three kinds of thing live here.

   1. ITEM_STAT_LABELS — DDragon writes every item's stat line as
      `<attention>75</attention> Attack Damage` inside a <stats> block, so the
      raw stats (including ability haste, lethality and penetration, which the
      machine-readable `stats` object omits) are parsed straight out of the
      description. This table just maps the human label to our stat key.

   2. ITEM_EFFECTS — the part no data source gives us: passives that convert
      one stat into another (Manamune's AD from mana, Rabadon's +30% total AP)
      or add damage on a cast/hit (Muramana's Shock, Lich Bane, Nashor's).
      HAND-MAINTAINED, hence PASSIVE_DATA_PATCH below — an item not listed here
      still contributes all of its raw stats, it just has no modelled passive,
      and the UI marks which items are modelled so a gap is visible rather than
      silent.

   3. RUNE_EFFECTS / SHARD_EFFECTS — same idea for runes. runes.json carries
      names, icons and ids but no numbers.

   Values are per-patch. When they drift, update them here and bump
   PASSIVE_DATA_PATCH; nothing else needs to change. */

// The patch these hand-entered passive/rune numbers were last checked against.
// Shown in the calculator so a stale table is visible rather than trusted.
const PASSIVE_DATA_PATCH = "16.15";

// ---------- raw item stats (parsed from DDragon descriptions) ----------

// label as written in an item's <stats> block -> [stat key, "flat" | "percent"]
const ITEM_STAT_LABELS = {
  "Attack Damage": ["ad", "flat"],
  "Ability Power": ["ap", "flat"],
  "Armor": ["armor", "flat"],
  "Magic Resist": ["mr", "flat"],
  "Magic Resistance": ["mr", "flat"],
  "Health": ["hp", "flat"],
  "Mana": ["mana", "flat"],
  "Ability Haste": ["haste", "flat"],
  "Attack Speed": ["as", "percent"],
  "Critical Strike Chance": ["crit", "percent"],
  "Critical Strike Damage": ["critDmg", "percent"],
  "Lethality": ["lethality", "flat"],
  "Armor Penetration": ["armorPenPct", "percent"],
  "Magic Penetration": ["magicPenFlat", "flat"], // "%" variant handled below
  "Move Speed": ["ms", "flat"],
  "Life Steal": ["lifesteal", "percent"],
  "Omnivamp": ["omnivamp", "percent"],
  "Heal and Shield Power": ["healShield", "percent"],
};
// stats whose percent form is a different stat than their flat form
const PERCENT_STAT_OVERRIDES = { magicPenFlat: "magicPenPct", ms: "msPct" };

// ---------- champion / stat model constants ----------

// Riot's per-level growth curve: a stat gains `growth` per level, scaled by
// this factor, so level 18 is worth ~17x growth rather than a flat 17.
function growthFactor(level) {
  const n = level - 1;
  return n * (0.7025 + 0.0175 * n);
}

// 1 point of adaptive force is worth this much of whichever the champion is
// currently favouring. Adaptive picks AD when bonus AD is strictly greater
// than bonus AP, and defaults to AD when they tie (both zero at level 1).
const ADAPTIVE_AD = 0.6;
const ADAPTIVE_AP = 1.0;

// ---------- item passives ----------

/* Shape of an entry (every field optional):
     stats:   flat stat additions the description doesn't spell out
     derived: [{stat, from, of: "total"|"bonus", coeff}] — a stat computed from
              another stat, applied after all flat stats are summed
     mult:    {stat: factor} — multiplies the finished total (Deathcap)
     amp:     {kind: "damage"|"magic"|"physical", pct} — output damage amp
     procs:   [{name, trigger: "ability"|"hit", type: "magic"|"physical"|"true",
                flat, scale: [{from, of, coeff}], note}]
     note:    caveat shown in the UI (conditional passives we model at full
              value, stacking ramps, etc.) */
const ITEM_EFFECTS = {
  "Rabadon's Deathcap": {
    label: "Magical Opus",
    mult: { ap: 1.3 },
  },
  "Manamune": {
    label: "Awe",
    derived: [{ stat: "ad", from: "mana", of: "total", coeff: 0.025 }],
    note: "Assumes Manamune is fully stacked.",
  },
  "Muramana": {
    label: "Awe / Shock",
    derived: [{ stat: "ad", from: "mana", of: "total", coeff: 0.025 }],
    procs: [{
      name: "Shock (on ability)", trigger: "ability", type: "physical",
      scale: [{ from: "mana", of: "total", coeff: 0.027 }],
      note: "Melee value; ranged champions deal less.",
    }],
  },
  "Archangel's Staff": {
    label: "Awe",
    derived: [{ stat: "ap", from: "mana", of: "total", coeff: 0.01 }],
  },
  "Seraph's Embrace": {
    label: "Awe",
    derived: [{ stat: "ap", from: "mana", of: "total", coeff: 0.02 }],
  },
  "Winter's Approach": {
    label: "Awe",
    derived: [{ stat: "hp", from: "mana", of: "total", coeff: 0.15 }],
  },
  "Fimbulwinter": {
    label: "Awe",
    derived: [{ stat: "hp", from: "mana", of: "total", coeff: 0.15 }],
  },
  "Riftmaker": {
    label: "Void Corruption / Void Infusion",
    derived: [{ stat: "ap", from: "hp", of: "bonus", coeff: 0.02 }],
    amp: { kind: "damage", pct: 8 },
    note: "Void Corruption modelled at its 8% cap (4s in combat).",
  },
  "Lich Bane": {
    label: "Spellblade",
    procs: [{
      name: "Spellblade (next attack)", trigger: "hit", type: "magic",
      scale: [{ from: "ad", of: "base", coeff: 0.75 },
               { from: "ap", of: "total", coeff: 0.45 }],
    }],
  },
  "Nashor's Tooth": {
    label: "Icathian Bite",
    procs: [{
      name: "Icathian Bite (on-hit)", trigger: "hit", type: "magic",
      flat: 15, scale: [{ from: "ap", of: "total", coeff: 0.2 }],
    }],
  },
  "Wit's End": {
    label: "Fray",
    procs: [{ name: "Fray (on-hit)", trigger: "hit", type: "magic", flat: 40 }],
  },
  "Blade of the Ruined King": {
    label: "Mist's Edge",
    procs: [{
      name: "Mist's Edge (on-hit)", trigger: "hit", type: "physical",
      scale: [{ from: "targetCurrentHp", of: "total", coeff: 0.06 }],
      note: "Melee value, % of the target's current health.",
    }],
  },
  "Sheen": {
    label: "Spellblade",
    procs: [{
      name: "Spellblade (next attack)", trigger: "hit", type: "physical",
      scale: [{ from: "ad", of: "base", coeff: 1.0 }],
    }],
  },
  "Trinity Force": {
    label: "Spellblade",
    procs: [{
      name: "Spellblade (next attack)", trigger: "hit", type: "physical",
      scale: [{ from: "ad", of: "base", coeff: 2.0 }],
    }],
  },
  "Iceborn Gauntlet": {
    label: "Spellblade",
    procs: [{
      name: "Spellblade (next attack)", trigger: "hit", type: "magic",
      scale: [{ from: "ad", of: "base", coeff: 1.0 }],
    }],
  },
  "Essence Reaver": {
    label: "Spellblade",
    procs: [{
      name: "Spellblade (next attack)", trigger: "hit", type: "physical",
      scale: [{ from: "ad", of: "base", coeff: 1.0 }],
    }],
  },
  "Luden's Companion": {
    label: "Fire",
    procs: [{
      name: "Fire (on ability)", trigger: "ability", type: "magic",
      flat: 60, scale: [{ from: "ap", of: "total", coeff: 0.04 }],
    }],
  },
  "Malignance": {
    label: "Hatefog",
    procs: [{
      name: "Hatefog (ultimate)", trigger: "ability", type: "magic",
      flat: 0, scale: [{ from: "ap", of: "total", coeff: 0.0 }],
      note: "Burn over time; per-tick damage not modelled.",
    }],
  },
  "Stormsurge": {
    label: "Stormraider",
    procs: [{
      name: "Squall (burst)", trigger: "ability", type: "magic",
      flat: 140, scale: [{ from: "ap", of: "total", coeff: 0.2 }],
      note: "Only procs on hitting a champion below 30% health.",
    }],
  },
  "Shadowflame": {
    label: "Cinderbloom",
    amp: { kind: "magic", pct: 20 },
    note: "Cinderbloom's bonus only applies below 35% target health.",
  },
  "Horizon Focus": {
    label: "Hypershot",
    amp: { kind: "magic", pct: 10 },
    note: "Requires a long-range ability hit.",
  },
  "Void Staff": { label: "Dissolve" },        // % pen already in its stats
  "Cryptbloom": { label: "Life From Death" }, // ditto
  "Serylda's Grudge": { label: "Bitter Cold" },
  "Lord Dominik's Regards": { label: "Giant Slayer" },
  "Black Cleaver": {
    label: "Carve",
    note: "Carve's armour shred (up to 30%) is not modelled — add it as a "
      + "manual armour reduction on the target.",
  },
  "Infinity Edge": { label: "Infinite Precision" },
};

// ---------- rune effects ----------

/* Same shape as ITEM_EFFECTS plus:
     perLevel: {stat: [atLevel1, atLevel18]} — linearly interpolated
     stacks:   {stat, per, max} — a stacking stat the UI exposes a count for */
const RUNE_EFFECTS = {
  // --- Precision ---
  "Press the Attack": {
    amp: { kind: "damage", pct: 8 },
    procs: [{ name: "Press the Attack (3rd hit)", trigger: "hit", type: "adaptive",
              perLevel: [40, 180] }],
    note: "Needs 3 hits on the same target; the 8% amp then applies to all damage.",
  },
  "Conqueror": {
    stacks: { stat: "adaptiveForce", per: 1.8, max: 12 },
    note: "1.8 adaptive force per stack (melee), 12 stacks max.",
  },
  "Fleet Footwork": {},
  "Lethal Tempo": { stats: { as: 0.0 }, note: "Attack-speed ramp not modelled." },
  "Legend: Alacrity": {},
  "Legend: Haste": { stats: { haste: 10 }, note: "At 10 Legend stacks." },
  "Legend: Bloodline": {},
  "Coup de Grace": {
    amp: { kind: "damage", pct: 8 },
    note: "Only below 40% target health.",
  },
  "Cut Down": {
    amp: { kind: "damage", pct: 8 },
    note: "Scales 4-12% with the target's bonus health; 8% shown.",
  },
  "Last Stand": {
    amp: { kind: "damage", pct: 11 },
    note: "Only when you are low; 5-11% by your own missing health.",
  },
  "Triumph": {},
  "Presence of Mind": {},
  "Absorb Life": {},
  // --- Domination ---
  "Electrocute": {
    procs: [{ name: "Electrocute", trigger: "ability", type: "adaptive",
              perLevel: [30, 180],
              scale: [{ from: "ad", of: "bonus", coeff: 0.4 },
                      { from: "ap", of: "total", coeff: 0.25 }] }],
    note: "Needs 3 separate attacks or abilities within 3s.",
  },
  "Dark Harvest": {
    procs: [{ name: "Dark Harvest", trigger: "ability", type: "adaptive",
              flat: 20,
              scale: [{ from: "ad", of: "bonus", coeff: 0.25 },
                      { from: "ap", of: "total", coeff: 0.15 }] }],
    note: "Base 20 + 9 per soul; souls not modelled. Below 50% target health.",
  },
  "Hail of Blades": {},
  "Cheap Shot": {
    procs: [{ name: "Cheap Shot", trigger: "ability", type: "true",
              perLevel: [10, 45] }],
    note: "Requires the target to be impaired (slow, stun, ...).",
  },
  "Sudden Impact": { stats: { lethality: 10, magicPenFlat: 7 },
                     note: "After a dash, blink or stealth exit." },
  "Eyeball Collection": { stats: { adaptiveForce: 6 }, note: "At full stacks." },
  "Treasure Hunter": {},
  "Ultimate Hunter": { stats: { ultHaste: 25 }, note: "At full stacks." },
  "Relentless Hunter": {},
  // --- Sorcery ---
  "Summon Aery": {
    procs: [{ name: "Summon Aery", trigger: "ability", type: "adaptive",
              perLevel: [30, 60],
              scale: [{ from: "ad", of: "bonus", coeff: 0.15 },
                      { from: "ap", of: "total", coeff: 0.1 }] }],
  },
  "Arcane Comet": {
    procs: [{ name: "Arcane Comet", trigger: "ability", type: "adaptive",
              perLevel: [30, 100],
              scale: [{ from: "ad", of: "bonus", coeff: 0.35 },
                      { from: "ap", of: "total", coeff: 0.2 }] }],
    note: "Only on a hit that is not already a comet cooldown.",
  },
  "Phase Rush": {},
  "Nimbus Cloak": {},
  "Transcendence": { stats: { haste: 10 }, note: "At level 11+." },
  "Celerity": {},
  "Absolute Focus": { stats: { adaptiveForce: 18 },
                      note: "Only above 70% of your own health; value at level 18." },
  "Scorch": {
    procs: [{ name: "Scorch", trigger: "ability", type: "magic", perLevel: [15, 35] }],
  },
  "Gathering Storm": { stats: { adaptiveForce: 24 },
                       note: "Ramps with game time; ~30 minutes shown." },
  "Manaflow Band": { stats: { mana: 250 } },
  "Nullifying Orb": {},
  "Waterwalking": {},
  // --- Resolve ---
  "Grasp of the Undying": {
    procs: [{ name: "Grasp of the Undying", trigger: "hit", type: "magic",
              scale: [{ from: "hp", of: "total", coeff: 0.035 }] }],
    note: "Melee value, every 4s in combat.",
  },
  "Aftershock": {
    procs: [{ name: "Aftershock", trigger: "ability", type: "magic",
              perLevel: [25, 120],
              scale: [{ from: "hp", of: "bonus", coeff: 0.08 }] }],
    note: "Requires an immobilising effect.",
  },
  "Guardian": {},
  "Font of Life": {},
  "Second Wind": {},
  "Bone Plating": {},
  "Conditioning": { stats: { armor: 8, mr: 8 }, note: "After 12 minutes." },
  "Overgrowth": { stats: { hp: 120 }, note: "Grows with minions killed." },
  "Revitalize": {},
  "Unflinching": {},
  "Demolish": {},
  // --- Inspiration ---
  "First Strike": {
    amp: { kind: "damage", pct: 9 },
    note: "Only while First Strike is active.",
  },
  "Cosmic Insight": { stats: { haste: 0 }, note: "Summoner/item haste only." },
  "Triple Tonic": {},
  "Magical Footwear": {},
  "Biscuit Delivery": {},
  "Time Warp Tonic": {},
  "Approach Velocity": {},
  "Jack Of All Trades": {},
  "Glacial Augment": {},
  "Hextech Flashtraption": {},
  "Perfect Timing": {},
  "Future's Market": {},
  "Minion Dematerializer": {},
  "Cash Back": {},
};

// stat shards (runes.json's shardRows) -> what they actually give. Same effect
// shape as ITEM_EFFECTS/RUNE_EFFECTS so one evaluator handles all three.
const SHARD_EFFECTS = {
  "Adaptive Force": { stats: { adaptiveForce: 5.4 } },
  "Attack Speed": { stats: { as: 0.1 } },
  "Ability Haste": { stats: { haste: 8 } },
  "Armor": { stats: { armor: 6 } },
  "Magic Resist": { stats: { mr: 8 } },
  "Health": { stats: { hp: 65 } },
  "Health Scaling": { perLevel: { hp: [10, 180] } },
  "Tenacity and Slow Resist": {},
};

// Every stat the calculator tracks, with how it is displayed. Order is the
// order they appear in the stat block.
const STAT_META = [
  { key: "ad", label: "Attack damage" },
  { key: "ap", label: "Ability power" },
  { key: "hp", label: "Health" },
  { key: "mana", label: "Mana" },
  { key: "armor", label: "Armor" },
  { key: "mr", label: "Magic resist" },
  { key: "as", label: "Attack speed", kind: "as" },
  { key: "crit", label: "Crit chance", kind: "percent" },
  { key: "critDmg", label: "Crit damage", kind: "percent", bonus: true },
  { key: "haste", label: "Ability haste" },
  { key: "ultHaste", label: "Ultimate haste" },
  { key: "lethality", label: "Lethality" },
  { key: "armorPenPct", label: "Armor pen", kind: "percent" },
  { key: "magicPenFlat", label: "Magic pen" },
  { key: "magicPenPct", label: "Magic pen", kind: "percent" },
  { key: "ms", label: "Move speed" },
  { key: "lifesteal", label: "Life steal", kind: "percent" },
  { key: "omnivamp", label: "Omnivamp", kind: "percent" },
];
