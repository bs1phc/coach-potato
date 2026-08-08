"use strict";
/* Damage-calculator engine: pure functions, no DOM. Given a champion, a level,
   a list of item names, a rune page and a target, produce (a) the full stat
   block a build actually yields and (b) what each ability then hits for.

   Kept separate from calculator.js so the maths stays readable and free of DOM
   concerns. Reference data — what each item and rune does — lives in
   calcdata.js; champion base stats and per-rank ability scaling come from
   spelldata.json (see scripts/refresh_spelldata.py, whose flattening is covered
   by tests/test_spelldata.py; there is no JS test runner in this repo, so the
   functions below are not unit-tested).

   Uses globals from calcdata.js: ITEM_STAT_LABELS, PERCENT_STAT_OVERRIDES,
   ITEM_EFFECTS, RUNE_EFFECTS, SHARD_EFFECTS, ADAPTIVE_AD, ADAPTIVE_AP,
   growthFactor. */

// stats that are summed as flat numbers; everything else needs its own rule
const FLAT_STATS = ["ad", "ap", "hp", "mana", "armor", "mr", "haste", "ultHaste",
                    "lethality", "magicPenFlat", "ms", "adaptiveForce"];
// stats stored as fractions (0.25 = 25%)
const PCT_STATS = ["as", "crit", "critDmg", "armorPenPct", "magicPenPct",
                   "lifesteal", "omnivamp", "msPct", "healShield"];

function emptyStats() {
  const stats = {};
  for (const key of FLAT_STATS) stats[key] = 0;
  for (const key of PCT_STATS) stats[key] = 0;
  return stats;
}

// ---------- item stats from DDragon description text ----------

/* DDragon exposes an item's stat line only as markup:
     <stats><attention>75</attention> Attack Damage<br>
            <attention>25%</attention> Critical Strike Chance</stats>
   The machine-readable `stats` object next to it silently omits ability haste,
   lethality and penetration, so the description is the more complete source. */
function parseItemStats(description) {
  const stats = emptyStats();
  const block = /<stats>([\s\S]*?)<\/stats>/.exec(description || "");
  if (!block) return stats;
  const entry = /<attention>\s*([\d.]+)\s*(%?)\s*<\/attention>\s*([^<]+)/g;
  let match;
  while ((match = entry.exec(block[1])) !== null) {
    const amount = parseFloat(match[1]);
    const isPercent = match[2] === "%";
    const label = match[3].replace(/&nbsp;/g, " ").trim();
    const mapped = ITEM_STAT_LABELS[label];
    if (!mapped || !isFinite(amount)) continue;
    let [key, form] = mapped;
    if (isPercent && PERCENT_STAT_OVERRIDES[key]) key = PERCENT_STAT_OVERRIDES[key];
    stats[key] = (stats[key] || 0) + (form === "percent" || isPercent ? amount / 100 : amount);
  }
  return stats;
}

// ---------- champion base stats at a level ----------

function championStatsAtLevel(base, level) {
  const grow = growthFactor(level);
  return {
    hp: base.hp + base.hpPerLevel * grow,
    mana: base.mp + base.mpPerLevel * grow,
    ad: base.ad + base.adPerLevel * grow,
    armor: base.armor + base.armorPerLevel * grow,
    mr: base.mr + base.mrPerLevel * grow,
    // attack speed grows as a percentage of the champion's own base
    as: base.as * (1 + (base.asPerLevel / 100) * grow),
    ms: base.ms,
  };
}

// ---------- assembling a build ----------

function addInto(target, source, scale = 1) {
  for (const [key, value] of Object.entries(source || {})) {
    if (typeof value === "number") target[key] = (target[key] || 0) + value * scale;
  }
  return target;
}

function perLevelValue(range, level) {
  if (!Array.isArray(range)) return range || 0;
  const [start, end] = range;
  return start + (end - start) * ((level - 1) / 17);
}

// effects (items or runes) contribute plain stats, per-level stats and stacks
function effectStats(effect, level, stackCount) {
  const stats = {};
  addInto(stats, effect.stats);
  for (const [key, range] of Object.entries(effect.perLevel || {})) {
    stats[key] = (stats[key] || 0) + perLevelValue(range, level);
  }
  if (effect.stacks) {
    const count = Math.min(stackCount ?? effect.stacks.max, effect.stacks.max);
    stats[effect.stacks.stat] = (stats[effect.stacks.stat] || 0)
      + effect.stacks.per * count;
  }
  return stats;
}

/* Resolve adaptive force into AD or AP. Adaptive follows whichever the
   champion already has more BONUS of, defaulting to AD when they tie (which
   they do at level 1 with an empty build). */
function applyAdaptive(bonus) {
  const force = bonus.adaptiveForce || 0;
  if (!force) return bonus;
  if ((bonus.ap || 0) > (bonus.ad || 0)) bonus.ap += force * ADAPTIVE_AP;
  else bonus.ad += force * ADAPTIVE_AD;
  bonus.adaptiveForce = 0;
  return bonus;
}

/* The whole build -> a stat block.

   `build` is {champion, level, items: [{name, description}], runes: [names],
   shards: [names], stacks: {runeName: n}}. `spellData` is one champion entry
   from spelldata.json.

   Returns {base, bonus, total, adaptiveTo, amps, procs, modelled} where base
   is the champion's own level stats, bonus is everything the build adds, and
   total is the sum after multiplicative passives (Deathcap). */
function buildStats(build, spellData) {
  const level = build.level;
  const base = championStatsAtLevel(spellData.base, level);
  const bonus = emptyStats();
  const amps = [];
  const procs = [];
  const modelled = [];

  const collect = (name, effect, source) => {
    if (!effect) return;
    addInto(bonus, effectStats(effect, level, (build.stacks || {})[name]));
    if (effect.amp) amps.push({ ...effect.amp, from: name, note: effect.note });
    for (const proc of effect.procs || []) {
      procs.push({ ...proc, from: name, note: proc.note || effect.note });
    }
    if (effect.amp || effect.procs || effect.derived || effect.mult
        || effect.stats || effect.stacks || effect.perLevel) {
      modelled.push({ name, source, label: effect.label, note: effect.note });
    }
  };

  for (const item of build.items || []) {
    // items arrive pre-parsed from guide.js's ITEMS cache; fall back to
    // parsing raw description markup so the engine stands alone in tests
    addInto(bonus, item.stats || parseItemStats(item.description));
    collect(item.name, ITEM_EFFECTS[item.name], "item");
  }
  for (const rune of build.runes || []) collect(rune, RUNE_EFFECTS[rune], "rune");
  for (const shard of build.shards || []) {
    if (SHARD_EFFECTS[shard]) addInto(bonus, effectStats(SHARD_EFFECTS[shard], level));
  }

  applyAdaptive(bonus);

  // derived stats read the totals as they stand, so they see flat item stats
  // (Manamune's AD from mana counts the mana its own item gave)
  const preTotal = totalOf(base, bonus);
  for (const item of build.items || []) {
    for (const derived of (ITEM_EFFECTS[item.name] || {}).derived || []) {
      const from = derived.of === "bonus" ? (bonus[derived.from] || 0)
        : derived.of === "base" ? (base[derived.from] || 0)
          : (preTotal[derived.from] || 0);
      bonus[derived.stat] = (bonus[derived.stat] || 0) + from * derived.coeff;
    }
  }

  const total = totalOf(base, bonus);
  // multiplicative passives apply last, to the finished total
  for (const item of build.items || []) {
    for (const [stat, factor] of Object.entries((ITEM_EFFECTS[item.name] || {}).mult || {})) {
      total[stat] *= factor;
      bonus[stat] = total[stat] - (base[stat] || 0);
    }
  }

  return { base, bonus, total, adaptiveTo: (bonus.ap > bonus.ad ? "ap" : "ad"),
           amps, procs, modelled, level };
}

function totalOf(base, bonus) {
  const total = { ...bonus };
  for (const [key, value] of Object.entries(base)) {
    total[key] = (total[key] || 0) + value;
  }
  // attack speed bonus is a percentage of base, not a flat add
  total.as = base.as * (1 + (bonus.as || 0));
  return total;
}

// ---------- target / mitigation ----------

/* A target is {champion, level, bonusArmor, bonusMr, bonusHp} — its own base
   stats at its level plus whatever the user says it has bought. */
function targetStats(target, spellData) {
  const base = championStatsAtLevel(spellData.base, target.level);
  return {
    armor: Math.max(0, base.armor + (target.bonusArmor || 0)),
    mr: Math.max(0, base.mr + (target.bonusMr || 0)),
    hp: base.hp + (target.bonusHp || 0),
    currentHp: (base.hp + (target.bonusHp || 0)) * (target.healthPct ?? 1),
  };
}

/* Resistance is reduced by percentage penetration first, then flat
   penetration/lethality, and never goes below zero from penetration alone. */
function effectiveResist(resist, flatPen, pctPen) {
  return Math.max(0, resist * (1 - (pctPen || 0)) - (flatPen || 0));
}

function mitigate(amount, type, stats, target) {
  if (type === "true") return amount;
  const resist = type === "magic"
    ? effectiveResist(target.mr, stats.magicPenFlat, stats.magicPenPct)
    : effectiveResist(target.armor, stats.lethality, stats.armorPenPct);
  return amount * (100 / (100 + resist));
}

// ---------- spell damage ----------

/* Coefficient sources a ratio can name. Caster stats read from the build's
   stat block; target-scaling reads the target instead. */
function ratioValue(ratio, stats, base, target) {
  const stat = ratio.stat;
  if (stat === "targetMaxHp") return target.hp;
  if (stat === "targetCurrentHp") return target.currentHp;
  if (stat === "stacks") return 1; // multiplied by the caller's stack count
  const source = ratio.of === "bonus" ? subtract(stats, base)
    : ratio.of === "base" ? base : stats;
  return source[stat] || 0;
}

function subtract(total, base) {
  const out = {};
  for (const key of Object.keys(total)) out[key] = total[key] - (base[key] || 0);
  return out;
}

/* One damage calculation at a given rank -> its pre-mitigation amount plus a
   breakdown of where the number came from. */
function calcAmount(calc, rank, stats, base, target, level, stackCount) {
  const index = Math.max(0, Math.min(rank, calc.flat.length) - 1);
  const parts = [];
  let amount = 0;
  if (rank > 0 && calc.flat[index]) {
    amount += calc.flat[index];
    parts.push({ label: "base", value: calc.flat[index] });
  }
  if (calc.flatByLevel) {
    const byLevel = calc.flatByLevel[Math.max(0, Math.min(17, level - 1))];
    if (byLevel) {
      amount += byLevel;
      parts.push({ label: `level ${level}`, value: byLevel });
    }
  }
  for (const ratio of calc.ratios || []) {
    const coeff = ratio.coeff[Math.max(0, Math.min(rank, ratio.coeff.length) - 1)];
    if (!coeff) continue;
    const multiplier = ratio.stat === "stacks" ? (stackCount || 0) : 1;
    const value = ratioValue(ratio, stats, base, target) * coeff * multiplier;
    amount += value;
    parts.push({ label: ratioLabel(ratio), value });
  }
  return { amount, parts };
}

function ratioLabel(ratio) {
  const pct = (coeff) => `${+(coeff * 100).toFixed(1)}%`;
  const names = {
    ap: "AP", ad: "AD", armor: "armor", mr: "MR", hp: "HP", mana: "mana",
    as: "attack speed", crit: "crit", critdmg: "crit damage", ms: "move speed",
    lethality: "lethality", targetMaxHp: "target max HP",
    targetCurrentHp: "target current HP", stacks: "per stack",
  };
  const name = names[ratio.stat] || ratio.stat;
  if (ratio.stat === "stacks") return `${pct(1)} ${name}`;
  const of = ratio.of === "total" ? "" : `${ratio.of} `;
  return `${of}${name}`;
}

/* Output amps stack multiplicatively; a magic-only amp applies to magic
   damage only. */
function ampMultiplier(amps, type) {
  return (amps || []).reduce((acc, amp) => {
    if (amp.kind !== "damage" && amp.kind !== type) return acc;
    return acc * (1 + amp.pct / 100);
  }, 1);
}

/* Every ability of the build's champion, at its current rank, against the
   target. Returns one row per damage calculation. */
function spellDamage(build, spellData, target, statBlock, options = {}) {
  const rows = [];
  const enabledAmps = (statBlock.amps || []).filter((a) => !options.disabled
    || !options.disabled.includes(a.from));
  for (const [key, spell] of Object.entries(spellData.spells || {})) {
    const rank = (build.ranks || {})[key] ?? 0;
    for (const calc of spell.calcs) {
      const type = spell.damageType || "magic";
      const { amount, parts } = calcAmount(calc, rank, statBlock.total,
        statBlock.base, target, build.level, (build.stacks || {}).ability);
      const amped = amount * ampMultiplier(enabledAmps, type);
      rows.push({
        spell: key, spellName: spell.name, icon: spell.icon, calc: calc.key,
        rank, maxRank: spell.maxRank, type, raw: amount, amped,
        post: mitigate(amped, type, statBlock.total, target), parts,
      });
    }
  }
  return rows;
}

/* Item/rune procs (Muramana's Shock, Electrocute, Lich Bane, ...) evaluated
   against the same stat block. `adaptive` procs follow the build's adaptive
   type, matching how they behave in game. */
function procDamage(statBlock, target, level, options = {}) {
  return (statBlock.procs || [])
    .filter((proc) => !options.disabled || !options.disabled.includes(proc.from))
    .map((proc) => {
      let amount = proc.flat || 0;
      const parts = [];
      if (proc.flat) parts.push({ label: "base", value: proc.flat });
      if (proc.perLevel) {
        const byLevel = perLevelValue(proc.perLevel, level);
        amount += byLevel;
        parts.push({ label: `level ${level}`, value: byLevel });
      }
      for (const ratio of proc.scale || []) {
        const value = ratioValue({ stat: ratio.from, of: ratio.of },
          statBlock.total, statBlock.base, target) * ratio.coeff;
        amount += value;
        parts.push({ label: ratioLabel({ stat: ratio.from, of: ratio.of }), value });
      }
      const type = proc.type === "adaptive"
        ? (statBlock.adaptiveTo === "ap" ? "magic" : "physical") : proc.type;
      const amped = amount * ampMultiplier(statBlock.amps, type);
      return { ...proc, type, raw: amount, amped,
               post: mitigate(amped, type, statBlock.total, target), parts };
    });
}

/* A basic attack, including crit and any on-hit procs, so a combo can mix
   autos with abilities. */
function attackDamage(statBlock, target, options = {}) {
  const ad = statBlock.total.ad;
  const critMultiplier = options.crit ? 1.75 + (statBlock.total.critDmg || 0) : 1;
  const raw = ad * critMultiplier;
  const amped = raw * ampMultiplier(statBlock.amps, "physical");
  return { raw, amped, post: mitigate(amped, "physical", statBlock.total, target) };
}

if (typeof module !== "undefined") {
  module.exports = { parseItemStats, championStatsAtLevel, buildStats, targetStats,
                     effectiveResist, mitigate, spellDamage, procDamage,
                     attackDamage, calcAmount, emptyStats };
}
