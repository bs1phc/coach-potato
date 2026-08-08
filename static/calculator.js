"use strict";
/* Damage calculator view (own nav tab). Pick a champion, a level, items and a
   rune page; see the stat block that build actually produces and what every
   ability then hits a target for, before and after the target's resistances.

   Splits three ways: reference data (what items/runes do) in calcdata.js, the
   maths in calc.js, and this file for state, rendering and wiring. Item names
   and rune pages are the same shapes the Matchup guide stores, so a build or
   rune page saved there can be loaded straight in.

   Uses globals from app.js ($, getJSON, escapeHtml, state, championOptions,
   champIcon, champDisplay, displayName), guide.js (ITEMS, loadItemData,
   loadRuneTrees, itemByName, itemIconUrl, itemChip, treePicker,
   primaryRunesPicker, secondaryRunesPicker, shardsPicker, treeByName,
   emptyRunePage, runeIconUrl, RUNE_TREES), cooldowns.js (champGrid,
   ranksAtLevel, SPELL_KEYS) and calc.js/calcdata.js. */

const CALC_STORAGE_KEY = "cp-calc-state";

const calcState = {
  wired: false,
  spellData: null,       // spelldata.json champions map
  spellDataPatch: "",    // the patch that data was generated from
  dataError: null,
  champion: "",
  level: 11,
  ranks: { Q: 5, W: 3, E: 1, R: 2 },
  manualRanks: false,    // ranks edited by hand rather than derived from level
  items: [],             // item names, in build order
  page: null,            // rune page, same shape as the guide's
  runesOpen: false,
  itemPicker: false,
  itemQuery: "",
  stacks: {},            // per-source stack counts (Conqueror, Nasus Q, ...)
  disabled: [],          // amp/proc sources the user switched off
  target: { champion: "", level: 11, bonusArmor: 0, bonusMr: 0, bonusHp: 0, healthPct: 100 },
  combo: [],             // row ids included in the combo total
  loadStatus: "",
};

const MAX_CALC_ITEMS = 6;

// ---------- persistence ----------

function saveCalcState() {
  try {
    localStorage.setItem(CALC_STORAGE_KEY, JSON.stringify({
      champion: calcState.champion, level: calcState.level, ranks: calcState.ranks,
      manualRanks: calcState.manualRanks, items: calcState.items,
      page: calcState.page, stacks: calcState.stacks, disabled: calcState.disabled,
      target: calcState.target, combo: calcState.combo,
    }));
  } catch { /* private mode / quota — the calculator just won't persist */ }
}

function restoreCalcState() {
  try {
    const saved = JSON.parse(localStorage.getItem(CALC_STORAGE_KEY) || "null");
    if (saved && typeof saved === "object") Object.assign(calcState, saved);
  } catch { /* corrupted — start fresh */ }
  if (!calcState.page) calcState.page = emptyRunePage();
}

// ---------- data ----------

async function loadCalcSpellData() {
  if (calcState.spellData) return;
  try {
    const data = await getJSON("/spelldata.json");
    calcState.spellData = data.champions;
    calcState.spellDataPatch = data.version;
  } catch {
    calcState.dataError = "Couldn't load champion spell data (spelldata.json).";
  }
}

function calcChampionData(champ) {
  return (calcState.spellData || {})[champ] || null;
}

// the rune names a page actually selects, for effect lookup
function calcPageRunes(page) {
  if (!page) return [];
  return [page.keystone, ...(page.primary_runes || []), ...(page.secondary_runes || [])]
    .filter(Boolean);
}

function calcBuildItems() {
  return calcState.items.map((name) => {
    const item = itemByName(name);
    return { name, stats: item ? item.stats : null };
  });
}

// ranks derived from the champion's saved skill order (shared with the
// cooldown popup) unless the user has overridden them
function syncCalcRanks() {
  if (calcState.manualRanks || !calcState.champion) return;
  calcState.ranks = ranksAtLevel(calcState.level, champGrid(calcState.champion));
}

/* Everything the output panes need, or null when a champion isn't picked. */
function calcCompute() {
  const champData = calcChampionData(calcState.champion);
  if (!champData) return null;
  const build = {
    champion: calcState.champion, level: calcState.level, ranks: calcState.ranks,
    items: calcBuildItems(), runes: calcPageRunes(calcState.page),
    shards: (calcState.page.shards || []).filter(Boolean), stacks: calcState.stacks,
  };
  const stats = buildStats(build, champData);
  const targetData = calcChampionData(calcState.target.champion);
  const target = targetData
    ? targetStats({ ...calcState.target, healthPct: calcState.target.healthPct / 100 }, targetData)
    : { armor: 0, mr: 0, hp: 0, currentHp: 0 };
  const options = { disabled: calcState.disabled };
  return {
    champData, stats, target, targetData,
    spells: spellDamage(build, champData, target, stats, options),
    procs: procDamage(stats, target, calcState.level, options),
    attack: attackDamage(stats, target),
  };
}

// ---------- formatting ----------

function calcNum(value, digits = 0) {
  if (!isFinite(value)) return "–";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits,
                                           minimumFractionDigits: 0 });
}

function calcStatValue(meta, stats, base) {
  const total = stats[meta.key] || 0;
  if (meta.kind === "as") return total.toFixed(2);
  if (meta.kind === "percent") return `${calcNum(total * 100, 1)}%`;
  const bonus = total - (base[meta.key] || 0);
  if (base[meta.key] && bonus > 0.5) {
    return `${calcNum(total)} <span class="muted calc-stat-split">(${calcNum(base[meta.key])} + ${calcNum(bonus)})</span>`;
  }
  return calcNum(total);
}

const CALC_DAMAGE_CLASS = { magic: "dmg-magic", physical: "dmg-physical", true: "dmg-true" };

function calcTypeChip(type) {
  return `<span class="dmg-type ${CALC_DAMAGE_CLASS[type] || ""}">${type}</span>`;
}

// "FinalSwipeDamage" -> "Final swipe" — the internal calculation names are the
// only labels the game data gives us, so make them readable
function calcCalcLabel(key) {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ")
    .replace(/\b(TT|Tooltip|Calc|Total)\b/gi, "").trim();
  const cleaned = words.replace(/\s+/g, " ").trim() || key;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

// ---------- rendering: build side ----------

function calcItemsCard() {
  const chips = calcState.items.map((name, i) =>
    itemChip(name, true, `data-index="${i}"`)).join("");
  const addBtn = calcState.items.length < MAX_CALC_ITEMS
    ? `<button type="button" class="preset calc-item-add">+ Add item</button>` : "";
  return `<div class="calc-card">
    <div class="calc-card-head">
      <h4>Items</h4>
      <button type="button" class="preset icon-btn-sm calc-load-build"
        title="Load this champion's item build from the Matchup guide">⤓ From guide</button>
    </div>
    <div class="item-build-icons calc-items">${chips || `<span class="muted">No items yet.</span>`}${addBtn}</div>
    ${calcState.itemPicker ? calcItemPickerHtml() : ""}
    <span class="muted calc-load-status">${escapeHtml(calcState.loadStatus)}</span>
  </div>`;
}

function calcItemResultsHtml() {
  const query = calcState.itemQuery.toLowerCase();
  const results = (query ? ITEMS.filter((i) => i.name.toLowerCase().includes(query)) : ITEMS)
    .slice(0, 30);
  if (!results.length) {
    return `<p class="muted">${ITEMS.length ? "No matching items." : "Item list unavailable (offline?)."}</p>`;
  }
  return results.map((i) => {
    const modelled = ITEM_EFFECTS[i.name];
    return `<button class="preset item-picker-result calc-item-result" type="button"
      data-name="${escapeHtml(i.name)}" data-item-name="${escapeHtml(i.name)}">
      <img src="${itemIconUrl(i.icon)}" alt="" width="20" height="20">${escapeHtml(i.name)}
      ${modelled ? `<span class="calc-modelled-dot" aria-hidden="true"
        title="Passive modelled by the calculator">•</span>` : ""}</button>`;
  }).join("");
}

function calcItemPickerHtml() {
  return `<div class="item-picker">
    <input type="text" id="calc-item-search" placeholder="Search items…"
      value="${escapeHtml(calcState.itemQuery)}">
    <div class="item-picker-results">${calcItemResultsHtml()}</div>
    <button class="preset calc-item-picker-close" type="button">Cancel</button>
  </div>`;
}

function calcRunesCard() {
  const page = calcState.page;
  const primaryTree = treeByName(page.primary_tree);
  const icons = calcPageRunes(page).map((name) => {
    const tree = [primaryTree, treeByName(page.secondary_tree)]
      .find((t) => t && t.rows.some((r) => r.runes.some((x) => x.name === name)));
    const icon = tree ? runeIcon(name, tree) : "";
    return icon ? `<img src="${runeIconUrl(icon)}" alt="${escapeHtml(name)}"
      title="${escapeHtml(name)}" width="24" height="24">` : "";
  }).join("");
  const shards = (page.shards || []).filter(Boolean).join(" · ");
  return `<div class="calc-card">
    <div class="calc-card-head">
      <h4>Runes</h4>
      <button type="button" class="preset icon-btn-sm calc-load-runes"
        title="Load a saved rune page from the Matchup guide">⤓ From guide</button>
      <button type="button" class="preset icon-btn-sm calc-runes-toggle"
        aria-expanded="${calcState.runesOpen}">${calcState.runesOpen ? "▾" : "▸"} Edit</button>
    </div>
    <div class="calc-rune-summary">${icons || `<span class="muted">No runes picked.</span>`}
      ${shards ? `<span class="muted calc-shard-line">${escapeHtml(shards)}</span>` : ""}</div>
    ${calcState.runesOpen ? `<div class="rune-page-editor calc-rune-editor">
      <div class="rune-page-cols">
        <div class="rune-tree-col"><h5>Primary tree</h5>
          ${treePicker("primary", page.primary_tree, page.secondary_tree)}
          ${primaryRunesPicker(page)}</div>
        <div class="rune-tree-col"><h5>Secondary tree</h5>
          ${treePicker("secondary", page.secondary_tree, page.primary_tree)}
          ${secondaryRunesPicker(page)}</div>
      </div>
      <h5>Stat shards</h5>
      ${shardsPicker(page)}
    </div>` : ""}
  </div>`;
}

function calcRanksCard() {
  const champData = calcChampionData(calcState.champion);
  const rows = SPELL_KEYS.map((key) => {
    const spell = (champData && champData.spells && champData.spells[key]) || null;
    const max = spell ? spell.maxRank : (key === "R" ? 3 : 5);
    const options = Array.from({ length: max + 1 }, (_, r) =>
      `<option value="${r}" ${calcState.ranks[key] === r ? "selected" : ""}>${r}</option>`).join("");
    return `<label class="calc-rank">
      <span class="calc-rank-key">${key}</span>
      <select class="calc-rank-select" data-key="${key}" aria-label="${key} rank">${options}</select>
    </label>`;
  }).join("");
  return `<div class="calc-card">
    <div class="calc-card-head"><h4>Ability ranks</h4>
      <span class="muted">${calcState.manualRanks
        ? `<button type="button" class="link-btn calc-ranks-auto">follow skill order</button>`
        : "from your saved skill order"}</span>
    </div>
    <div class="calc-ranks">${rows}</div>
  </div>`;
}

function calcStacksCard(stats) {
  const stackable = (stats.modelled || []).filter((m) => (RUNE_EFFECTS[m.name] || {}).stacks);
  const hasAbilityStacks = (calcChampionData(calcState.champion)?.spells
    ? Object.values(calcChampionData(calcState.champion).spells)
      .some((s) => s.calcs.some((c) => c.ratios.some((r) => r.stat === "stacks")))
    : false);
  if (!stackable.length && !hasAbilityStacks) return "";
  const rows = stackable.map((m) => {
    const spec = RUNE_EFFECTS[m.name].stacks;
    const value = calcState.stacks[m.name] ?? spec.max;
    return `<label class="calc-stack-row"><span>${escapeHtml(m.name)}</span>
      <input type="number" class="calc-stack" data-name="${escapeHtml(m.name)}"
        min="0" max="${spec.max}" value="${value}"></label>`;
  }).join("");
  const abilityRow = hasAbilityStacks
    ? `<label class="calc-stack-row"><span>Ability stacks</span>
       <input type="number" class="calc-stack" data-name="ability" min="0" max="2000"
         value="${calcState.stacks.ability ?? 0}"></label>` : "";
  return `<div class="calc-card">
    <div class="calc-card-head"><h4>Stacks</h4></div>
    <div class="calc-stacks">${rows}${abilityRow}</div>
  </div>`;
}

// ---------- rendering: stat block ----------

function calcStatsCard(stats) {
  const rows = STAT_META.map((meta) => {
    const value = stats.total[meta.key] || 0;
    if (!value) return "";
    return `<div class="calc-stat">
      <span class="calc-stat-label">${meta.label}</span>
      <span class="calc-stat-value">${calcStatValue(meta, stats.total, stats.base)}</span>
    </div>`;
  }).join("");
  const adaptive = stats.adaptiveTo === "ap" ? "ability power" : "attack damage";
  return `<div class="calc-card calc-stats-card">
    <div class="calc-card-head"><h4>Stats at level ${stats.level}</h4>
      <span class="muted">adaptive → ${adaptive}</span></div>
    <div class="calc-stat-grid">${rows}</div>
  </div>`;
}

function calcModelledCard(stats) {
  if (!stats.modelled.length) return "";
  const rows = stats.modelled.map((m) => {
    const off = calcState.disabled.includes(m.name);
    return `<label class="calc-modelled-row ${off ? "calc-off" : ""}">
      <input type="checkbox" class="calc-toggle-source" data-name="${escapeHtml(m.name)}"
        ${off ? "" : "checked"}>
      <span class="calc-modelled-name">${escapeHtml(m.name)}</span>
      ${m.label ? `<span class="muted">${escapeHtml(m.label)}</span>` : ""}
      ${m.note ? `<span class="muted calc-note" title="${escapeHtml(m.note)}">ⓘ</span>` : ""}
    </label>`;
  }).join("");
  return `<div class="calc-card">
    <div class="calc-card-head"><h4>Modelled passives</h4>
      <span class="muted">checked against patch ${PASSIVE_DATA_PATCH}</span></div>
    <p class="muted">Items and runes not listed here still contribute their raw
      stats — they just have no extra passive modelled. Untick one to exclude it.</p>
    <div class="calc-modelled">${rows}</div>
  </div>`;
}

// ---------- rendering: output ----------

function calcRowId(row) {
  return row.spell ? `spell:${row.spell}:${row.calc}` : `proc:${row.from}:${row.name}`;
}

function calcBreakdown(parts) {
  return parts.map((p) => `${escapeHtml(p.label)} ${calcNum(p.value, 1)}`).join(" + ");
}

function calcDamageRow(row, id, label, icon) {
  const inCombo = calcState.combo.includes(id);
  return `<tr class="${inCombo ? "calc-in-combo" : ""}">
    <td class="calc-row-name">
      <label>
        <input type="checkbox" class="calc-combo-toggle" data-id="${escapeHtml(id)}"
          ${inCombo ? "checked" : ""} aria-label="Add to combo">
        ${icon}<span>${label}</span>
      </label>
    </td>
    <td>${calcTypeChip(row.type)}</td>
    <td class="num" title="${escapeHtml(calcBreakdown(row.parts))}">${calcNum(row.amped)}</td>
    <td class="num"><strong>${calcNum(row.post)}</strong></td>
  </tr>`;
}

function calcSpellIcon(row) {
  if (!row.icon || !state.ddragonVersion) return "";
  return `<img class="calc-spell-icon"
    src="https://ddragon.leagueoflegends.com/cdn/${state.ddragonVersion}/img/spell/${row.icon}"
    alt="" width="22" height="22" loading="lazy" onerror="this.style.display='none'">`;
}

function calcOutputHtml(result) {
  if (!result) {
    return `<p class="muted">Pick your champion to see its damage.</p>`;
  }
  if (!result.targetData) {
    return `<p class="muted">Pick a target champion to see damage after resistances.</p>`;
  }
  const spellRows = result.spells.filter((r) => r.rank > 0);
  const bySpell = SPELL_KEYS.map((key) => {
    const rows = spellRows.filter((r) => r.spell === key);
    if (!rows.length) return "";
    const head = `<tr class="calc-spell-head"><td colspan="4">
      <strong>${key}</strong> ${escapeHtml(rows[0].spellName)}
      <span class="muted">rank ${rows[0].rank}/${rows[0].maxRank}</span></td></tr>`;
    return head + rows.map((row) => calcDamageRow(row, calcRowId(row),
      escapeHtml(calcCalcLabel(row.calc)), calcSpellIcon(row))).join("");
  }).join("");

  const attackId = "attack";
  const attackRow = calcDamageRow(
    { ...result.attack, type: "physical", parts: [{ label: "AD", value: result.stats.total.ad }] },
    attackId, "Basic attack", "");

  const procRows = result.procs.map((proc) => calcDamageRow(proc, calcRowId(proc),
    `${escapeHtml(proc.name)} <span class="muted">${escapeHtml(proc.from)}</span>`, ""));

  const combo = calcComboTotal(result);
  return `
    <div class="table-wrap">
      <table class="calc-damage">
        <thead><tr>
          <th>Ability</th><th>Type</th><th class="num">Raw</th>
          <th class="num">After resists</th>
        </tr></thead>
        <tbody>
          ${bySpell || `<tr><td colspan="4" class="muted">No ranked abilities.</td></tr>`}
          <tr class="calc-spell-head"><td colspan="4"><strong>Attacks &amp; procs</strong></td></tr>
          ${attackRow}
          ${procRows.join("") || `<tr><td colspan="4" class="muted">No modelled procs in this build.</td></tr>`}
        </tbody>
      </table>
    </div>
    ${calcComboHtml(combo, result)}`;
}

function calcComboTotal(result) {
  const all = [
    ...result.spells.map((r) => ({ id: calcRowId(r), post: r.post, type: r.type })),
    ...result.procs.map((r) => ({ id: calcRowId(r), post: r.post, type: r.type })),
    { id: "attack", post: result.attack.post, type: "physical" },
  ];
  const picked = all.filter((r) => calcState.combo.includes(r.id));
  return { total: picked.reduce((sum, r) => sum + r.post, 0), count: picked.length };
}

function calcComboHtml(combo, result) {
  if (!combo.count) {
    return `<p class="muted calc-combo-empty">Tick abilities above to add them to a combo total.</p>`;
  }
  const hp = result.target.hp;
  const pct = hp ? (combo.total / hp) * 100 : 0;
  const kills = hp && combo.total >= result.target.currentHp;
  return `<div class="calc-combo">
    <div class="calc-combo-main">
      <span class="calc-combo-label">Combo (${combo.count})</span>
      <strong class="calc-combo-total">${calcNum(combo.total)}</strong>
      <span class="muted">after resists</span>
    </div>
    <div class="calc-combo-bar" role="img"
      aria-label="${calcNum(pct, 1)} percent of the target's health">
      <div class="calc-combo-fill ${kills ? "calc-combo-lethal" : ""}"
        style="width: ${Math.min(100, pct)}%"></div>
    </div>
    <div class="calc-combo-foot muted">
      ${calcNum(pct, 1)}% of ${escapeHtml(champDisplay(calcState.target.champion))}'s
      ${calcNum(hp)} HP${kills ? ` — <strong class="calc-lethal">lethal</strong>` : ""}
      <button type="button" class="link-btn calc-combo-clear">clear</button>
    </div>
  </div>`;
}

function calcTargetCard(result) {
  const t = calcState.target;
  const resists = result && result.targetData
    ? `<span class="muted">${calcNum(result.target.armor)} armor ·
       ${calcNum(result.target.mr)} MR · ${calcNum(result.target.hp)} HP</span>` : "";
  const field = (key, label, max) => `<label class="calc-field">
    <span class="filter-label">${label}</span>
    <input type="number" class="calc-target-num" data-key="${key}" min="0" max="${max}"
      value="${t[key]}"></label>`;
  return `<div class="calc-card">
    <div class="calc-card-head"><h4>Target</h4>${resists}</div>
    <div class="calc-target-row">
      <label class="calc-field"><span class="filter-label">Champion</span>
        <select id="calc-target-champion"></select></label>
      <label class="calc-field"><span class="filter-label">Level</span>
        <input type="number" id="calc-target-level" min="1" max="18" value="${t.level}"></label>
      ${field("bonusArmor", "Bonus armor", 500)}
      ${field("bonusMr", "Bonus MR", 500)}
      ${field("bonusHp", "Bonus HP", 6000)}
      ${field("healthPct", "Health %", 100)}
    </div>
  </div>`;
}

function renderCalculator() {
  const view = $("#calc-view");
  if (calcState.dataError) {
    view.innerHTML = `<h2>Damage calculator</h2>
      <p class="muted">${escapeHtml(calcState.dataError)}</p>`;
    return;
  }
  syncCalcRanks();
  const result = calcCompute();
  view.innerHTML = `
    <h2>Damage calculator</h2>
    <p class="muted calc-intro">Mix items and runes to see the stats they give and
      what each ability then hits for. Champion numbers come from patch
      ${escapeHtml(calcState.spellDataPatch || "?")} game data; item and rune
      passives are hand-modelled (patch ${PASSIVE_DATA_PATCH}).</p>
    <section class="filter-row calc-top">
      <div class="filter-group">
        <span class="filter-label">Your champion</span>
        <span class="calc-champ-pick">${champIcon(calcState.champion)}
          <select id="calc-champion"></select></span>
      </div>
      <div class="filter-group">
        <span class="filter-label">Level <strong id="calc-level-value">${calcState.level}</strong></span>
        <input type="range" id="calc-level" min="1" max="18" value="${calcState.level}">
      </div>
    </section>
    <div class="calc-grid">
      <div class="calc-col">
        ${calcItemsCard()}
        ${calcRunesCard()}
        ${calcRanksCard()}
        ${result ? calcStacksCard(result.stats) : ""}
      </div>
      <div class="calc-col">
        ${result ? calcStatsCard(result.stats) : `<div class="calc-card"><p class="muted">Pick a champion.</p></div>`}
        ${calcTargetCard(result)}
        <div class="calc-card">
          <div class="calc-card-head"><h4>Damage</h4></div>
          <div id="calc-output">${calcOutputHtml(result)}</div>
        </div>
        ${result ? calcModelledCard(result.stats) : ""}
      </div>
    </div>`;
  fillCalcChampionSelects();
  wireCalculator(view);
}

// re-render only the parts that depend on the numbers, so typing in a number
// field doesn't lose focus mid-edit
function updateCalcOutputs() {
  syncCalcRanks();
  const result = calcCompute();
  const output = $("#calc-output");
  if (output) {
    output.innerHTML = calcOutputHtml(result);
    wireCalcOutput($("#calc-view")); // innerHTML dropped the combo handlers
  }
  const stats = document.querySelector(".calc-stats-card");
  if (stats && result) stats.outerHTML = calcStatsCard(result.stats);
  saveCalcState();
}

async function fillCalcChampionSelects() {
  const mine = $("#calc-champion");
  const target = $("#calc-target-champion");
  if (mine) mine.innerHTML = await championOptions(calcState.champion, "– pick a champion –");
  if (target) {
    target.innerHTML = await championOptions(calcState.target.champion, "– pick a target –");
  }
}

// ---------- loading a build / runes from the Matchup guide ----------

async function calcLoadGuideBuild() {
  if (!calcState.champion) return;
  calcState.loadStatus = "Loading…";
  renderCalculator();
  try {
    const build = await getJSON(
      `/api/champions/item-build/${encodeURIComponent(calcState.champion)}`);
    const sections = build.sections || [];
    const items = sections.flatMap((s) => s.items || []);
    if (!items.length) {
      calcState.loadStatus = "No item build saved for this champion.";
    } else {
      calcState.items = items.slice(0, MAX_CALC_ITEMS);
      calcState.loadStatus = `Loaded ${calcState.items.length} items from the guide.`;
    }
  } catch {
    calcState.loadStatus = "Couldn't load the guide's item build.";
  }
  renderCalculator();
}

async function calcLoadGuideRunes() {
  if (!calcState.champion) return;
  calcState.loadStatus = "Loading…";
  renderCalculator();
  try {
    // champion-level pages first (runes_mode "general"), then any matchup page
    const general = await getJSON(
      `/api/champions/notes/${encodeURIComponent(calcState.champion)}`);
    let page = (general.runes || [])[0];
    if (!page) {
      const guide = await getJSON(
        `/api/matchups/notes?my_champion=${encodeURIComponent(calcState.champion)}`);
      const forTarget = guide[calcState.target.champion];
      const any = forTarget || Object.values(guide).find((g) => (g.runes || []).length);
      page = ((any || {}).runes || [])[0];
    }
    if (!page) {
      calcState.loadStatus = "No rune page saved for this champion.";
    } else {
      calcState.page = { ...emptyRunePage(), ...page };
      calcState.loadStatus = `Loaded rune page${page.label ? ` “${page.label}”` : ""}.`;
    }
  } catch {
    calcState.loadStatus = "Couldn't load the guide's rune pages.";
  }
  renderCalculator();
}

// ---------- wiring ----------

function wireCalculator(view) {
  const rerender = () => { saveCalcState(); renderCalculator(); };

  view.querySelector("#calc-champion").addEventListener("change", (e) => {
    calcState.champion = e.target.value;
    calcState.manualRanks = false;
    rerender();
  });
  const level = view.querySelector("#calc-level");
  level.addEventListener("input", () => {
    calcState.level = +level.value;
    $("#calc-level-value").textContent = calcState.level;
    updateCalcOutputs();
  });
  level.addEventListener("change", rerender); // ranks may change with level

  view.querySelectorAll(".calc-rank-select").forEach((select) =>
    select.addEventListener("change", () => {
      calcState.ranks = { ...calcState.ranks, [select.dataset.key]: +select.value };
      calcState.manualRanks = true;
      rerender();
    }));
  const auto = view.querySelector(".calc-ranks-auto");
  if (auto) auto.addEventListener("click", () => {
    calcState.manualRanks = false;
    rerender();
  });

  // --- items ---
  const addItem = view.querySelector(".calc-item-add");
  if (addItem) addItem.addEventListener("click", () => {
    calcState.itemPicker = true;
    calcState.itemQuery = "";
    renderCalculator();
    const search = $("#calc-item-search");
    if (search) search.focus();
  });
  const search = view.querySelector("#calc-item-search");
  if (search) search.addEventListener("input", () => {
    calcState.itemQuery = search.value;
    const results = view.querySelector(".item-picker-results");
    if (!results) return;
    results.innerHTML = calcItemResultsHtml(); // typing must not lose focus
    wireCalcItemResults(view);
  });
  wireCalcItemResults(view);
  const closePicker = view.querySelector(".calc-item-picker-close");
  if (closePicker) closePicker.addEventListener("click", () => {
    calcState.itemPicker = false;
    renderCalculator();
  });
  view.querySelectorAll(".calc-items .item-chip-remove").forEach((btn) =>
    btn.addEventListener("click", () => {
      calcState.items.splice(+btn.closest(".item-chip").dataset.index, 1);
      rerender();
    }));
  const loadBuild = view.querySelector(".calc-load-build");
  if (loadBuild) loadBuild.addEventListener("click", calcLoadGuideBuild);
  const loadRunes = view.querySelector(".calc-load-runes");
  if (loadRunes) loadRunes.addEventListener("click", calcLoadGuideRunes);

  // --- runes ---
  const runesToggle = view.querySelector(".calc-runes-toggle");
  if (runesToggle) runesToggle.addEventListener("click", () => {
    calcState.runesOpen = !calcState.runesOpen;
    rerender();
  });
  view.querySelectorAll(".calc-rune-editor [data-role]").forEach((btn) =>
    btn.addEventListener("click", () => {
      applyCalcRunePick(btn.dataset);
      rerender();
    }));

  // --- stacks / toggles ---
  view.querySelectorAll(".calc-stack").forEach((input) =>
    input.addEventListener("input", () => {
      calcState.stacks = { ...calcState.stacks, [input.dataset.name]: +input.value || 0 };
      updateCalcOutputs();
    }));
  view.querySelectorAll(".calc-toggle-source").forEach((box) =>
    box.addEventListener("change", () => {
      const name = box.dataset.name;
      calcState.disabled = box.checked
        ? calcState.disabled.filter((n) => n !== name)
        : [...calcState.disabled, name];
      rerender();
    }));

  // --- target ---
  const targetSelect = view.querySelector("#calc-target-champion");
  targetSelect.addEventListener("change", () => {
    calcState.target.champion = targetSelect.value;
    rerender();
  });
  const targetLevel = view.querySelector("#calc-target-level");
  targetLevel.addEventListener("input", () => {
    calcState.target.level = Math.max(1, Math.min(18, +targetLevel.value || 1));
    updateCalcOutputs();
  });
  view.querySelectorAll(".calc-target-num").forEach((input) =>
    input.addEventListener("input", () => {
      calcState.target[input.dataset.key] = +input.value || 0;
      updateCalcOutputs();
    }));

  wireCalcOutput(view);
}

// the output pane re-renders on its own, so its handlers are (re)bound apart
function wireCalcOutput(root) {
  root.querySelectorAll(".calc-combo-toggle").forEach((box) =>
    box.addEventListener("change", () => {
      const id = box.dataset.id;
      calcState.combo = box.checked
        ? [...calcState.combo, id]
        : calcState.combo.filter((x) => x !== id);
      saveCalcState();
      const result = calcCompute();
      $("#calc-output").innerHTML = calcOutputHtml(result);
      wireCalcOutput($("#calc-view"));
    }));
  const clear = root.querySelector(".calc-combo-clear");
  if (clear) clear.addEventListener("click", () => {
    calcState.combo = [];
    saveCalcState();
    $("#calc-output").innerHTML = calcOutputHtml(calcCompute());
    wireCalcOutput($("#calc-view"));
  });
}

function wireCalcItemResults(view) {
  view.querySelectorAll(".calc-item-result").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (calcState.items.length < MAX_CALC_ITEMS) calcState.items.push(btn.dataset.name);
      calcState.itemPicker = false;
      saveCalcState();
      renderCalculator();
    }));
}

// mirrors the guide's rune-picker click rules (2 secondaries from different rows)
function applyCalcRunePick(data) {
  const page = calcState.page;
  const role = data.role;
  if (role === "primary-tree") {
    page.primary_tree = data.tree;
    page.keystone = "";
    page.primary_runes = ["", "", ""];
    if (page.secondary_tree === data.tree) { page.secondary_tree = ""; page.secondary_runes = []; }
  } else if (role === "secondary-tree") {
    page.secondary_tree = data.tree;
    page.secondary_runes = [];
  } else if (role === "keystone") {
    page.keystone = page.keystone === data.rune ? "" : data.rune;
  } else if (role === "primary-rune") {
    const row = +data.row - 1;
    page.primary_runes[row] = page.primary_runes[row] === data.rune ? "" : data.rune;
  } else if (role === "secondary-rune") {
    const tree = treeByName(page.secondary_tree);
    const has = page.secondary_runes.includes(data.rune);
    if (has) {
      page.secondary_runes = page.secondary_runes.filter((r) => r !== data.rune);
    } else {
      // one per row, at most two
      const sameRow = page.secondary_runes.filter((r) => rowIndexOf(tree, r) === +data.row);
      let next = page.secondary_runes.filter((r) => !sameRow.includes(r));
      if (next.length >= 2) next = next.slice(1);
      page.secondary_runes = [...next, data.rune];
    }
  } else if (role === "shard") {
    const row = +data.row;
    page.shards[row] = page.shards[row] === data.shard ? "" : data.shard;
  }
}

// ---------- entry point ----------

async function initCalculator() {
  if (!calcState.wired) {
    calcState.wired = true;
    restoreCalcState();
  }
  $("#calc-view").innerHTML = `<h2>Damage calculator</h2><p class="muted">Loading…</p>`;
  await Promise.all([loadCalcSpellData(), loadRuneTrees(), loadItemData()]);
  if (!calcState.champion) {
    calcState.champion = (await poolChampionOrder())[0] || "";
  }
  renderCalculator();
}
