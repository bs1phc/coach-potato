"use strict";

const state = {
  players: [],
  accounts: null, // null = all tracked accounts; else array of selected puuids
  range: "all",
  from: null,
  to: null,
  champion: "",
  queue: "",
  side: "", // "" all | blue | red
  roleFilter: "mine", // "mine" (main+secondary) | "" (all) | a team_position
  mainRole: "",       // from settings
  secondaryRole: "",
  profiles: [],
  activeProfileId: null,
  rankTier: "",
  minGames: 1,
  mainView: "overview", // overview | matchups | progress | trends | blocks | settings
  progressChampion: null, // null = not initialized yet (defaults to Gwen)
  progressQueue: "",
  progressSide: "",
  ddragonVersion: null,
  ddragonVersions: [], // recent DDragon versions, newest first (patch picker)
  poolOrder: null, // champion pool flattened in priority order; null = not fetched
  dateFormat: "iso", // iso | us | eu — drives fmtDate/fmtTime
  championByKey: null, // numeric championId -> champion id (live-game lookup)
};

const QUEUE_NAMES = { 400: "Normal Draft", 420: "Ranked Solo", 430: "Normal Blind",
                      440: "Ranked Flex", 490: "Quickplay", 700: "Clash" };
const DISPLAY_NAME_FIXES = { MonkeyKing: "Wukong", FiddleSticks: "Fiddlesticks" };

const $ = (sel) => document.querySelector(sel);

function selectedPuuids() {
  return state.accounts ?? state.players.map((p) => p.puuid);
}

// append the account scope to a query; no params = all tracked (server default)
function accountParams(params = new URLSearchParams()) {
  if (state.accounts) for (const p of state.accounts) params.append("puuid", p);
  return params;
}

function displayName(champ) { return DISPLAY_NAME_FIXES[champ] || champ; }

// match-v5 spellings that differ from the DDragon id used in icon URLs
const ICON_NAME_FIXES = { FiddleSticks: "Fiddlesticks" };

// numeric championId (from spectator/live-game) -> DDragon champion id, built
// from DDragon champion.json once and cached
async function loadChampionKeyMap() {
  if (state.championByKey) return state.championByKey;
  const map = {};
  try {
    const data = await getJSON(
      `https://ddragon.leagueoflegends.com/cdn/${state.ddragonVersion}/data/en_US/champion.json`);
    for (const c of Object.values(data.data || {})) map[+c.key] = c.id;
  } catch { /* offline — live lookup can't map ids, handled by caller */ }
  state.championByKey = map;
  return map;
}

function champIcon(champ) {
  if (!state.ddragonVersion || !champ) return "";
  const id = ICON_NAME_FIXES[champ] || champ;
  const url = `https://ddragon.leagueoflegends.com/cdn/${state.ddragonVersion}/img/champion/${id}.png`;
  return `<img src="${url}" alt="" loading="lazy" onerror="this.style.display='none'">`;
}

function fmt(value, digits = 1) {
  return value == null ? "–" : Number(value).toFixed(digits);
}

function pct(value) {
  return value == null ? "–" : (100 * value).toFixed(0) + "%";
}

function fmtDuration(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds) % 60).padStart(2, "0")}`;
}

// date/time rendering honours the user's date_format setting
// (state.dateFormat: "iso" YYYY-MM-DD / "us" M/D/YYYY / "eu" D/M/YYYY;
// iso & eu use 24h time, us uses 12h). Full year — blocks now show dates.
function fmtDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  if (state.dateFormat === "us") return `${m}/${day}/${y}`;
  if (state.dateFormat === "eu") return `${day}/${m}/${y}`;
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`; // iso (default)
}

function fmtTime(ms) {
  const d = new Date(ms);
  if (state.dateFormat === "us") {
    const h = d.getHours(), am = h < 12 ? "AM" : "PM", h12 = h % 12 || 12;
    return `${h12}:${String(d.getMinutes()).padStart(2, "0")} ${am}`;
  }
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtDateTime(ms) {
  return `${fmtDate(ms)} ${fmtTime(ms)}`;
}

function titleCase(tier) {
  return tier === "UNKNOWN" ? "Unknown rank" : tier.charAt(0) + tier.slice(1).toLowerCase();
}

const TIER_SHORT = { IRON: "Iron", BRONZE: "Bronze", SILVER: "Silver", GOLD: "Gold",
  PLATINUM: "Plat", EMERALD: "Em", DIAMOND: "Dia", MASTER: "Master",
  GRANDMASTER: "GM", CHALLENGER: "Chal" };

function fmtRank(entry) {
  if (!entry || !entry.tier) return "Unranked";
  const division = ["MASTER", "GRANDMASTER", "CHALLENGER"].includes(entry.tier)
    ? "" : ` ${entry.division}`;
  return `${TIER_SHORT[entry.tier] || entry.tier}${division} ${entry.lp ?? 0}LP`;
}

function fmtRankList(ranks) {
  if (!ranks || !ranks.length) return "–";
  return ranks.map((r) =>
    `${escapeHtml(r.account.split("#")[0])} ${fmtRank(r)}`).join("<br>");
}

// ---------- persisted column choices ----------

function colPrefs(storageKey, allKeys, defaultKeys = allKeys) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(saved)) return new Set(saved.filter((k) => allKeys.includes(k)));
  } catch { /* fall through to defaults */ }
  return new Set(defaultKeys);
}

function renderColPicker(target, storageKey, columns, visible, onChange) {
  target.innerHTML = `<details class="col-picker"><summary class="preset">Columns ▾</summary>
    <div class="col-menu">` + columns.map((c) =>
      `<label><input type="checkbox" data-col="${c.key}"
         ${visible.has(c.key) ? "checked" : ""}> ${c.label}</label>`).join("") +
    `</div></details>`;
  target.querySelectorAll("input").forEach((cb) =>
    cb.addEventListener("change", () => {
      cb.checked ? visible.add(cb.dataset.col) : visible.delete(cb.dataset.col);
      localStorage.setItem(storageKey, JSON.stringify([...visible]));
      onChange();
    }));
}

// ---------- shared table sorting ----------
// Column spec entry: {key, label, type: "num"|"text", get?(row), sortable?,
// cls?}. sortState is {key, dir} (dir 1 asc / -1 desc) held in a view's state.
// Rank tiers order low→high; UNKNOWN sorts last.
const RANK_ORDINAL = { IRON: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4,
  EMERALD: 5, DIAMOND: 6, MASTER: 7, GRANDMASTER: 8, CHALLENGER: 9, UNKNOWN: -1 };

function defaultSortDir(col) {
  return col.type === "text" ? 1 : -1; // names A→Z, stats high→low
}

// a <thead> where sortable columns carry click-to-sort affordances.
// `leading`/`trailing` are raw <th> strings for non-data columns (toggles).
function sortableThead(columns, sortState, leading = "", trailing = "") {
  const cells = columns.map((c) => {
    if (c.sortable === false) return `<th class="${c.cls || ""}">${c.label}</th>`;
    const active = sortState.key === c.key;
    const arrow = active ? (sortState.dir === 1 ? "▲" : "▼") : "";
    const ariaSort = active ? (sortState.dir === 1 ? "ascending" : "descending") : "none";
    return `<th class="sortable ${c.cls || ""}${active ? " sorted" : ""}"
      data-sort="${c.key}" aria-sort="${ariaSort}" title="Sort by ${escapeHtml(c.label)}"
      >${c.label}<span class="sort-arrow">${arrow}</span></th>`;
  }).join("");
  return `<thead><tr>${leading}${cells}${trailing}</tr></thead>`;
}

function sortRows(rows, sortState, columns) {
  const col = columns.find((c) => c.key === sortState.key);
  if (!col) return rows.slice();
  const get = col.get || ((r) => r[col.key]);
  const dir = sortState.dir;
  return rows.slice().sort((a, b) => {
    const va = get(a), vb = get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;   // nulls always last, regardless of direction
    if (vb == null) return -1;
    const cmp = (typeof va === "string" || typeof vb === "string")
      ? String(va).localeCompare(String(vb)) : va - vb;
    return dir * cmp;
  });
}

// wire click-to-sort on a rendered table; toggles direction on the active
// column, else switches to the clicked column at its natural default
function wireSortable(container, sortState, columns, rerender) {
  container.querySelectorAll("th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortState.key === key) {
        sortState.dir *= -1;
      } else {
        sortState.key = key;
        sortState.dir = defaultSortDir(columns.find((c) => c.key === key) || {});
      }
      rerender();
    }));
}

// team_position value -> label, in lane order
const ROLE_OPTS = [["TOP", "Top"], ["JUNGLE", "Jungle"], ["MIDDLE", "Mid"],
                   ["BOTTOM", "Bot"], ["UTILITY", "Support"]];
function roleSettingOptions(sel) { // Settings: None + each role
  return `<option value="">None</option>`
    + ROLE_OPTS.map(([v, l]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${l}</option>`).join("");
}
function roleFilterOptions() { // filter rows: My roles / All / each role
  return `<option value="mine">My roles</option><option value="">All roles</option>`
    + ROLE_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
}
// the team_position(s) the current role filter maps to ([] = all roles)
function roleParamList() {
  if (state.roleFilter === "mine") return [state.mainRole, state.secondaryRole].filter(Boolean);
  return state.roleFilter ? [state.roleFilter] : [];
}
function addRoleParams(params) { roleParamList().forEach((r) => params.append("role", r)); }
// keep all filter dropdowns showing the shared role filter
function syncRoleSelects() {
  ["#role-select", "#mu-role", "#trend-role"].forEach((id) => { const el = $(id); if (el) el.value = state.roleFilter; });
}
// ---------- profiles: switch role/champion focus + research players ----------
async function loadProfiles(applyActive = false) {
  let data;
  try { data = await getJSON("/api/profiles"); } catch { return; }
  state.profiles = data.profiles || [];
  state.activeProfileId = data.active_id;
  renderProfileSelect();
  renderProfilesManager();
  if (applyActive) {
    const active = state.profiles.find((p) => p.id === state.activeProfileId);
    if (active) applyProfile(active, false); // set focus without a redundant refresh
  }
}
function renderProfileSelect() {
  const sel = $("#profile-select");
  if (!sel) return;
  sel.innerHTML = state.profiles.map((p) =>
    `<option value="${p.id}" ${p.id === state.activeProfileId ? "selected" : ""}>${escapeHtml(p.name)}</option>`)
    .join("");
}
// apply a profile's role + champion to the filters (roleFilter "" = all roles)
function applyProfile(prof, doRefresh = true) {
  state.roleFilter = prof.role || "";
  syncRoleSelects();
  if (prof.champion) {
    state.champion = prof.champion;
    const cs = $("#champion-select"); if (cs) cs.value = prof.champion;
    if (typeof muState !== "undefined") { muState.champion = prof.champion; }
    const mc = $("#mu-champion"); if (mc) mc.value = prof.champion;
    if (typeof guideState !== "undefined") guideState.myChampion = prof.champion;
  }
  loadComparisonPlayers();               // now scoped to this profile
  if (doRefresh) refresh();
}
async function switchProfile(id) {
  let prof;
  try {
    prof = await (await fetch(`/api/profiles/${id}/activate`, { method: "POST" })).json();
  } catch { return; }
  state.activeProfileId = Number(id);
  applyProfile(prof);
}
// Settings manager: one row per profile with role + champion + activate/delete
function renderProfilesManager() {
  const box = $("#profiles-list");
  if (!box) return;
  const roleOpts = (sel) => `<option value="">All roles</option>`
    + `<option value="mine" ${sel === "mine" ? "selected" : ""}>My roles</option>`
    + ROLE_OPTS.map(([v, l]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${l}</option>`).join("");
  box.innerHTML = state.profiles.map((p) => `<div class="profile-row" data-id="${p.id}">
      <span class="profile-name ${p.id === state.activeProfileId ? "active" : ""}">${escapeHtml(p.name)}</span>
      ${p.id === state.activeProfileId ? `<span class="profile-badge">active</span>`
        : `<button class="preset profile-activate" data-id="${p.id}">Switch to</button>`}
      <select class="profile-role" data-id="${p.id}" title="Role focus">${roleOpts(p.role)}</select>
      <input class="profile-champ" data-id="${p.id}" list="champ-list" value="${escapeHtml(p.champion || "")}"
        placeholder="Champion" style="width:9em">
      <button class="preset icon-btn profile-del" data-id="${p.id}" title="Delete profile"
        ${state.profiles.length <= 1 ? "disabled" : ""}>🗑</button>
    </div>`).join("");
}
async function saveProfileField(id, patch) {
  try {
    const prof = await (await fetch(`/api/profiles/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    })).json();
    const i = state.profiles.findIndex((p) => p.id === id);
    if (i >= 0) state.profiles[i] = prof;
    if (id === state.activeProfileId) applyProfile(prof);
  } catch { /* ignore */ }
}

// apply main/secondary role from settings, default the filter, fill the dropdowns
function applyRoleSettings(settings) {
  state.mainRole = settings.main_role || "";
  state.secondaryRole = settings.secondary_role || "";
  state.roleFilter = state.mainRole ? "mine" : ""; // no main set -> show all roles
  ["#role-select", "#mu-role", "#trend-role"].forEach((id) => {
    const el = $(id);
    if (el && !el.options.length) el.innerHTML = roleFilterOptions();
  });
  syncRoleSelects();
}

function queryString() {
  const params = accountParams();
  if (state.range === "custom") {
    if (state.from) params.set("from", state.from);
    if (state.to) params.set("to", state.to);
  } else if (state.range !== "all") {
    params.set("range", state.range);
  }
  if (state.champion) params.set("champion", state.champion);
  if (state.queue) params.set("queue", state.queue);
  if (state.side) params.set("side", state.side);
  addRoleParams(params);
  if (state.rankTier) params.set("rank_tier", state.rankTier);
  if (state.minGames > 1) params.set("min_games", state.minGames);
  return params.toString();
}

async function getJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

// ---------- rendering ----------

function wrCell(winrate) {
  const width = winrate == null ? 0 : Math.round(100 * winrate);
  return `<span class="wr-cell">
      <span class="wr-bar"><span class="fill" style="width:${width}%"></span><span class="tick"></span></span>
      <span class="wr-num">${pct(winrate)}</span>
    </span>`;
}

// per-game "standard metrics" panel (same groups as the coaching/blocks views)
function metricGroupsPanel(data, storageKey) {
  if (data === undefined) return `<div class="muted">Loading…</div>`;
  if (data === null) return `<div class="muted">No detailed metrics recorded for this game.</div>`;
  const vis = storageKey ? visibleMetricKeys(storageKey) : null;
  const meta = vis ? data.meta.filter((m) => vis.has(m.key)) : data.meta;
  const groups = [...new Set(meta.map((m) => m.group))];
  return `<div class="metric-groups">` + groups.map((g) =>
    `<div class="metric-group"><h4>${g}</h4>` +
    meta.filter((m) => m.group === g).map((m) => `<div class="metric-row">
        <span class="metric-label">${m.label}</span>
        <span class="metric-value">${fmtMetric(data.metrics[m.key], m)}</span>
      </div>`).join("") + `</div>`).join("") + `</div>`;
}

function renderSummary(s) {
  const selected = state.players.filter((p) => selectedPuuids().includes(p.puuid));
  let rank;
  if (state.hideMyRank) {
    rank = "Hidden";
  } else if (selected.length === 1) {
    const p = selected[0];
    rank = p.solo_tier
      ? `${titleCase(p.solo_tier)} ${p.solo_division ?? ""} ${p.solo_lp ?? 0} LP`
      : "Unranked / unknown";
  } else {
    rank = selected.map((p) => `${escapeHtml(p.game_name)}: ${p.solo_tier
      ? fmtRank({ tier: p.solo_tier, division: p.solo_division, lp: p.solo_lp })
      : "–"}`).join("<br>") || "–";
  }
  $("#summary-tiles").innerHTML = `
    <div class="tile"><div class="label">Games</div><div class="value">${s.games}</div>
      <div class="sub">${s.wins ?? 0}W ${s.games - (s.wins ?? 0)}L</div></div>
    <div class="tile"><div class="label">Winrate</div><div class="value">${pct(s.winrate)}</div>
      <div class="sub">50% reference on bars</div></div>
    <div class="tile"><div class="label">KDA</div><div class="value">${fmt(s.kda, 2)}</div>
      <div class="sub">${fmt(s.kills)}/${fmt(s.deaths)}/${fmt(s.assists)}</div></div>
    <div class="tile"><div class="label">CS/min</div><div class="value">${fmt(s.cs_min)}</div>
      <div class="sub">gold/min ${fmt(s.gold_min, 0)}</div></div>
    <div class="tile"><div class="label">Current rank</div><div class="value" style="font-size:18px">${rank}</div>
      <div class="sub">solo queue</div></div>`;
}

// ---------- coaching-session nudge ----------

const COACHING_NUDGE_OVERDUE_DAYS = 14; // warm color past this many days

function renderCoachingNudge(settings) {
  const el = $("#coaching-nudge");
  if (!el) return;
  const days = settings.days_since_last_session;
  if (days === null || days === undefined) {
    el.textContent = "No coaching sessions yet — click to add one";
    el.classList.remove("overdue");
  } else {
    const ago = days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
    el.textContent = `Last coaching session: ${ago}`;
    el.classList.toggle("overdue", days >= COACHING_NUDGE_OVERDUE_DAYS);
  }
  el.classList.remove("hidden");
}

async function refreshCoachingNudge() {
  renderCoachingNudge(await getJSON("/api/settings"));
}

// ---------- rank-over-time chart ----------

// tier -> base absolute LP (mirror of stats._TIER_BASE); apex tiers collapse
const RANK_TIER_BASES = [
  ["IRON", 0], ["BRONZE", 400], ["SILVER", 800], ["GOLD", 1200],
  ["PLATINUM", 1600], ["EMERALD", 2000], ["DIAMOND", 2400], ["MASTER", 2800],
];
const RANK_SERIES_COLORS = ["var(--series-1)", "#e08a3c", "#3aa876", "#b06fd8", "#d05c5c"];

const RANK_W = 860, RANK_H = 260;
const RK_PAD = { l: 58, r: 12, t: 12, b: 24 };

function overviewRangeBounds() {
  // mirrors the server's period filter for the overview
  const now = Date.now();
  if (state.range === "custom") {
    const from = state.from ? Date.parse(state.from + "T00:00:00Z") : null;
    const to = state.to ? Date.parse(state.to + "T00:00:00Z") + 86_400_000 - 1 : now;
    return [from, Math.min(to, now)];
  }
  if (state.range !== "all") return [now - parseInt(state.range, 10) * 86_400_000, now];
  return [null, now];
}

// clip a series to [fromMs, toMs]: carry the last point before the window in
// at the left edge, and extend the last value to the right edge ("now")
function rankWindow(points, fromMs, toMs) {
  const inWin = points.filter((p) => p.t >= fromMs && p.t <= toMs)
    .map((p) => ({ ...p, x: p.t }));
  const before = points.filter((p) => p.t < fromMs).pop();
  if (before) inWin.unshift({ ...before, x: fromMs, carried: true });
  if (inWin.length) {
    const last = inWin[inWin.length - 1];
    if (last.x < toMs) inWin.push({ ...last, x: toMs, carried: true });
  }
  return inWin;
}

function renderRankChart() {
  let data = state.rankHistory;
  const target = $("#rank-chart");
  const legend = $("#rank-legend");
  $("#rank-section").classList.toggle("hidden", Boolean(state.hideMyRank));
  if (state.hideMyRank) return;
  if (data) data = { ...data, series: data.series.filter((s) => selectedPuuids().includes(s.puuid)) };
  if (!data || !data.series.some((s) => s.points.length)) {
    legend.innerHTML = "";
    target.innerHTML = `<div class="table-wrap"><div class="empty">
      No rank history yet — a snapshot is stored on every data update.</div></div>`;
    return;
  }
  let [fromMs, toMs] = overviewRangeBounds();
  if (fromMs == null) {
    fromMs = Math.min(...data.series.flatMap((s) => s.points.map((p) => p.t)));
  }
  const series = data.series
    .map((s, i) => ({ ...s, color: RANK_SERIES_COLORS[i % RANK_SERIES_COLORS.length],
                      pts: rankWindow(s.points, fromMs, toMs) }))
    .filter((s) => s.pts.length);

  legend.innerHTML = data.series.map((s, i) => {
    const player = state.players.find((p) => p.puuid === s.puuid);
    const current = player && player.solo_tier
      ? fmtRank({ tier: player.solo_tier, division: player.solo_division, lp: player.solo_lp })
      : "Unranked";
    return `<span><span class="swatch" style="background:${RANK_SERIES_COLORS[i % RANK_SERIES_COLORS.length]}"></span>
      ${escapeHtml(s.account.split("#")[0])} · ${current}</span>`;
  }).join("");

  if (!series.length) {
    target.innerHTML = `<div class="table-wrap"><div class="empty">
      No rank snapshots in this period.</div></div>`;
    return;
  }

  const values = series.flatMap((s) => s.pts.map((p) => p.value));
  let lo = Math.floor(Math.min(...values) / 100) * 100;
  let hi = Math.ceil(Math.max(...values) / 100) * 100;
  if (lo === hi) hi += 100;
  while (hi - lo < 200) { lo = Math.max(0, lo - 100); hi += 100; }

  const iw = RANK_W - RK_PAD.l - RK_PAD.r, ih = RANK_H - RK_PAD.t - RK_PAD.b;
  const x = (t) => RK_PAD.l + ((t - fromMs) / Math.max(1, toMs - fromMs)) * iw;
  const y = (v) => RK_PAD.t + ih - ((v - lo) / (hi - lo)) * ih;

  // horizontal gridlines: tier boundaries (labelled) + divisions when zoomed in
  let grid = "";
  const minor = hi - lo <= 1000;
  for (let v = lo; v <= hi; v += 100) {
    const boundary = RANK_TIER_BASES.find(([, base]) => base === v);
    if (boundary) {
      grid += `<line class="rk-grid" x1="${RK_PAD.l}" x2="${RANK_W - RK_PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
    } else if (minor) {
      grid += `<line class="rk-grid rk-grid-minor" x1="${RK_PAD.l}" x2="${RANK_W - RK_PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
    }
  }
  // tier band labels, centred in the visible part of each band
  for (const [tier, base] of RANK_TIER_BASES) {
    const top = tier === "MASTER" ? Infinity : base + 400;
    const a = Math.max(lo, base), b = Math.min(hi, top);
    if (b - a >= 60) {
      grid += `<text class="rk-tier-label" x="${RK_PAD.l - 6}" y="${(y((a + b) / 2) + 3).toFixed(1)}"
        text-anchor="end">${TIER_SHORT[tier]}</text>`;
    }
  }

  // coaching sessions as dashed vertical lines
  let sessionLines = "";
  for (const s of data.sessions || []) {
    const t = Date.parse(s.date + "T00:00:00Z");
    if (isNaN(t) || t < fromMs || t > toMs) continue;
    const sx = x(t).toFixed(1);
    sessionLines += `<line class="rk-session" x1="${sx}" x2="${sx}" y1="${RK_PAD.t}" y2="${RANK_H - RK_PAD.b}"/>
      <line class="rk-session-hit" x1="${sx}" x2="${sx}" y1="${RK_PAD.t}" y2="${RANK_H - RK_PAD.b}"
        data-tip="${escapeHtml(`${s.date}: ${s.title || "coaching session"}`)}"/>`;
  }

  // estimated stretches (from win/loss walks) draw fainter than real snapshots
  let anyEstimated = false;
  const lines = series.map((s) => {
    // split the line into runs of segments that are real–real vs touching an
    // estimated point, so estimated stretches can render fainter
    const pairEst = (k) => Boolean(s.pts[k].estimated || s.pts[k + 1].estimated);
    let segments = "";
    for (let i = 0; i < s.pts.length - 1;) {
      const est = pairEst(i);
      let j = i + 1;
      while (j < s.pts.length - 1 && pairEst(j) === est) j++;
      const pts = s.pts.slice(i, j + 1)
        .map((p) => `${x(p.x).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
      segments += `<polyline class="rk-line${est ? " rk-est" : ""}" style="stroke:${s.color}" points="${pts}"/>`;
      i = j;
    }
    if (s.pts.some((p) => p.estimated)) anyEstimated = true;
    const shown = s.pts.filter((p) => !p.carried);
    const estCount = shown.filter((p) => p.estimated).length;
    const dots = shown.map((p) => {
      if (p.estimated && estCount > 300) return ""; // keep the DOM sane on long histories
      const cx = x(p.x).toFixed(1), cy = y(p.value).toFixed(1);
      const tip = `${fmtDate(p.t)} · ${s.account.split("#")[0]}: ` +
        (p.estimated ? `≈ ${fmtRank(p)} (est.)` : fmtRank(p));
      return `<circle class="rk-dot${p.estimated ? " rk-est" : ""}" cx="${cx}" cy="${cy}"
          r="${p.estimated ? 2 : 3}" style="fill:${s.color}"/>
        <circle class="tl-hit" cx="${cx}" cy="${cy}" r="${p.estimated ? 5 : 8}"
          data-tip="${escapeHtml(tip)}"/>`;
    }).join("");
    return segments + dots;
  }).join("");

  target.innerHTML = `<div class="rank-chart-box">
    <svg viewBox="0 0 ${RANK_W} ${RANK_H}" role="img" aria-label="Rank over time">
      ${grid}${sessionLines}${lines}
      <line class="tl-axis" x1="${RK_PAD.l}" x2="${RANK_W - RK_PAD.r}" y1="${RANK_H - RK_PAD.b}" y2="${RANK_H - RK_PAD.b}"/>
      <text class="rk-xlab" x="${RK_PAD.l}" y="${RANK_H - 6}">${escapeHtml(fmtDate(fromMs))}</text>
      <text class="rk-xlab" x="${RANK_W - RK_PAD.r}" y="${RANK_H - 6}" text-anchor="end">${escapeHtml(fmtDate(toMs))}</text>
    </svg>
    ${anyEstimated ? `<div class="muted rk-note">Faint = estimated from ranked
      wins/losses (±20 LP per game); solid = recorded rank snapshots.</div>` : ""}
  </div>`;

  const tip = $("#chart-tip");
  target.querySelectorAll("[data-tip]").forEach((el) => {
    el.addEventListener("mouseenter", () => {
      tip.textContent = el.dataset.tip;
      tip.classList.remove("hidden");
      const r = el.getBoundingClientRect();
      tip.style.left = `${r.left + window.scrollX + 12}px`;
      tip.style.top = `${r.top + window.scrollY - 30}px`;
    });
    el.addEventListener("mouseleave", () => tip.classList.add("hidden"));
  });
}

const CHAMP_SORT_COLS = [
  { key: "champion", label: "Champion", type: "text", get: (r) => displayName(r.champion) },
  { key: "games", label: "Games", type: "num" },
  { key: "wins", label: "W–L", type: "num", get: (r) => r.wins },
  { key: "winrate", label: "Winrate", type: "num", cls: "wr-col" },
  { key: "kda", label: "KDA", type: "num" },
  { key: "cs_min", label: "CS/min", type: "num" },
];
const champSort = { key: "games", dir: -1 };

function renderChampionTable(byChampion) {
  const target = $("#champion-table");
  if (!byChampion.length) {
    target.innerHTML = `<div class="table-wrap"><div class="empty">No games.</div></div>`;
    return;
  }
  state.byChampion = byChampion;
  const body = sortRows(byChampion, champSort, CHAMP_SORT_COLS).map((row) => `<tr>
      <td><span class="champ-cell">${champIcon(row.champion)}${displayName(row.champion)}</span></td>
      <td>${row.games}</td>
      <td>${row.wins}–${row.games - row.wins}</td>
      <td class="wr-col">${wrCell(row.winrate)}</td>
      <td>${fmt(row.kda, 2)}</td>
      <td>${fmt(row.cs_min)}</td>
    </tr>`).join("");
  target.innerHTML = `<div class="table-wrap"><table>
    ${sortableThead(CHAMP_SORT_COLS, champSort)}
    <tbody>${body}</tbody></table></div>`;
  wireSortable(target, champSort, CHAMP_SORT_COLS, () => renderChampionTable(state.byChampion));
}

const recentUi = { runesOpen: new Set(), reflectOpen: new Set(), sort: { key: "date", dir: -1 } };
// Full-game curve: separate from recentUi.runesOpen since curve data needs an
// async fetch (runes are already inline on the game row) — cache is per
// gkey, cleared never (recent games don't change once loaded for this view).
const curveUi = { open: new Set(), cache: new Map() };

function kdaRatio(g) { return (g.kills + g.assists) / Math.max(1, g.deaths); }

// ---------- lane-win verdict ----------
// A transparent, graded replacement for Riot's opaque earlyLaningPhaseGoldExp-
// Advantage / laningPhaseGoldExpAdvantage flags (which could show a red "lost
// lane" on a game you were +32 CS / +611 gold ahead). We score lane outcome
// ourselves from the ΔCS / ΔGold / ΔLevel we already store vs the DIRECT lane
// opponent at the ~7 and ~14 min timeline frames. Several "ways of doing the
// math" are offered; the user picks one (stored in localStorage, shared by the
// Blocks table and the comparison pop-out). Thresholds are fixed and shown in a
// legend so the verdict is never a black box. Gold already bundles CS + kills +
// plates, so it's the default lens; the others exist because no single number
// is right for every lane.
const LANE_METHODS = [
  { key: "combined", label: "Gold + XP", blurb: "Gold lead, confirmed by XP" },
  { key: "gold", label: "Gold", blurb: "Gold lead vs lane opponent (includes CS, kills, plates)" },
  { key: "cs", label: "CS", blurb: "Creep-score lead vs lane opponent" },
  { key: "xp", label: "XP / level", blurb: "Level lead vs lane opponent" },
];
// won / stomp cutoffs (absolute Δ) per method per mark. even = |Δ| < won;
// lost/stomped mirror won/stomp negatively.
const LANE_THRESHOLDS = {
  gold:     { 7: { won: 250, stomp: 700 }, 14: { won: 500, stomp: 1200 } },
  combined: { 7: { won: 250, stomp: 700 }, 14: { won: 500, stomp: 1200 } },
  cs:       { 7: { won: 12,  stomp: 25 },  14: { won: 18,  stomp: 40 } },
  xp:       { 7: { won: 150, stomp: 450 }, 14: { won: 300, stomp: 800 } }, // raw XP
};
// fallback when a game predates ΔXP capture (run ./crawl.sh --recompute-lane-deltas)
const LANE_LEVEL_THRESHOLDS = { 7: { won: 1, stomp: 2 }, 14: { won: 1, stomp: 2 } };
const LANE_TIERS = {
  stomp:   { symbol: "⇈", cls: "lane-stomp",   rank: 2 },
  won:     { symbol: "✓", cls: "lane-won",     rank: 1 },
  even:    { symbol: "=", cls: "lane-even",    rank: 0 },
  lost:    { symbol: "✗", cls: "lane-lost",    rank: -1 },
  stomped: { symbol: "⇊", cls: "lane-stomped", rank: -2 },
};
// Two grading modes. "absolute" = ahead/behind vs 0 (a raw lead). "relative" =
// ahead/behind vs what THIS matchup normally produces (the coach's definition:
// winning lane = beating your champion's expected outcome in the pairing, so a
// scaler playing even vs a bully can still be "ahead of curve"). Tiers get
// matchup-aware labels in relative mode; "on plan" (met expectation) is neutral,
// not a loss.
const LANE_TIER_LABELS = {
  absolute: { stomp: "Stomp", won: "Won", even: "Even", lost: "Lost", stomped: "Stomped" },
  relative: { stomp: "Crushed", won: "Ahead of curve", even: "On plan",
              lost: "Behind curve", stomped: "Well behind" },
};

function laneWinMethod() {
  const m = localStorage.getItem("cp-lane-metric");
  return LANE_THRESHOLDS[m] ? m : "combined";
}
function setLaneWinMethod(m) {
  if (LANE_THRESHOLDS[m]) localStorage.setItem("cp-lane-metric", m);
}
function laneGradeMode() {
  return localStorage.getItem("cp-lane-grade") === "absolute" ? "absolute" : "relative";
}
function setLaneGradeMode(m) {
  localStorage.setItem("cp-lane-grade", m === "absolute" ? "absolute" : "relative");
}

const LANE_METRIC_BASES = ["gold", "cs", "xp"];
const LANE_UNIT = { gold: "g", cs: "CS", xp: "XP" };
const laneDeltaFor = (g, metric, mark) => g[`${metric}_diff_${mark}`];
function laneGoalFor(g) {
  return (state.laneGoals && state.laneGoals[`${g.my_champion}|${g.opp_champion}`]) || null;
}
// The data baseline (expected delta, shrunk toward 0 by sample size) for a
// game's matchup — used to re-center in relative mode; 0 when unknown.
function laneBaseline(g, metricBase, mark) {
  const base = state.laneBaselines && state.laneBaselines[`${g.my_champion}|${g.opp_champion}`];
  const bv = base && base[`${metricBase}_diff_${mark}`];
  return bv != null ? bv : 0;
}

// Per-game stats a win condition can grade on (label + default op + input step).
// Order = the editor's dropdown order.
const LANE_CONDITION_METRICS = [
  { key: "gold_diff_14", label: "ΔGold @14", op: ">=", step: 50, dec: 0 },
  { key: "gold_diff_7", label: "ΔGold @7", op: ">=", step: 50, dec: 0 },
  { key: "cs_diff_14", label: "ΔCS @14", op: ">=", step: 1, dec: 1 },
  { key: "cs_diff_7", label: "ΔCS @7", op: ">=", step: 1, dec: 1 },
  { key: "xp_diff_14", label: "ΔXP @14", op: ">=", step: 50, dec: 0 },
  { key: "xp_diff_7", label: "ΔXP @7", op: ">=", step: 50, dec: 0 },
  { key: "level_diff_14", label: "ΔLevel @14", op: ">=", step: 1, dec: 0 },
  { key: "cs_at_10", label: "CS @10", op: ">=", step: 1, dec: 0 },
  { key: "plates", label: "Turret plates", op: ">=", step: 1, dec: 0 },
  { key: "solo_kills", label: "Solo kills", op: ">=", step: 1, dec: 0 },
  { key: "max_cs_lead", label: "Max CS lead", op: ">=", step: 1, dec: 0 },
  { key: "max_level_lead", label: "Max level lead", op: ">=", step: 1, dec: 0 },
  { key: "early_takedowns", label: "Takedowns <15m", op: ">=", step: 1, dec: 0 },
  { key: "kills", label: "Kills", op: ">=", step: 1, dec: 0 },
  { key: "deaths", label: "Deaths", op: "<=", step: 1, dec: 0 },
  { key: "assists", label: "Assists", op: ">=", step: 1, dec: 0 },
];
const LANE_CONDITION_META = Object.fromEntries(LANE_CONDITION_METRICS.map((m) => [m.key, m]));
function conditionMetricLabel(key) { return (LANE_CONDITION_META[key] || {}).label || key; }
function conditionFmt(key, v) {
  const dec = (LANE_CONDITION_META[key] || {}).dec || 0;
  const s = v > 0 && String(key).includes("_diff_") ? "+" : "";
  return v == null ? "—" : s + Number(v).toFixed(dec);
}
// verdict tiers for condition grading (adds a softer "mostly" between won/partial)
const CONDITION_TIERS = {
  won: { symbol: "✓", cls: "lane-won" },
  mostly: { symbol: "↗", cls: "lane-mostly" },
  partial: { symbol: "=", cls: "lane-even" },
  lost: { symbol: "✗", cls: "lane-lost" },
};
// the win conditions for a matchup, tolerant of the legacy <metric>_<mark> shape
function goalConditions(goal) {
  if (!goal) return [];
  if (Array.isArray(goal.conditions)) return goal.conditions;
  const map = { gold: "gold_diff", cs: "cs_diff", xp: "xp_diff" };
  const out = [];
  for (const base of ["gold", "cs", "xp"]) {
    for (const mk of [7, 14]) {
      const v = goal[`${base}_${mk}`];
      if (v != null) out.push({ metric: `${map[base]}_${mk}`, op: ">=", value: v });
    }
  }
  return out;
}

// Game-level win-condition verdict: fraction of the (evaluable) conditions the
// game met, graded softly — Won (all) / Mostly (≥⅔) / Partial (≥⅓) / Lost.
// Unknown stats (metric missing on this game) are ignored, not counted against.
// Returns null when none of the conditions can be evaluated.
function laneConditionOutcome(g, conditions) {
  const evals = conditions.map((c) => {
    const val = g[c.metric];
    const met = val == null ? null : (c.op === "<=" ? val <= c.value : val >= c.value);
    return { ...c, val, met };
  });
  const known = evals.filter((e) => e.met !== null);
  if (!known.length) return null;
  const metCount = known.filter((e) => e.met).length;
  const frac = metCount / known.length;
  let name = metCount === known.length ? "won"
    : frac >= 2 / 3 ? "mostly" : frac >= 1 / 3 ? "partial" : "lost";
  const label = `${{ won: "Won", mostly: "Mostly", partial: "Partial", lost: "Lost" }[name]} (${metCount}/${known.length})`;
  const parts = evals.map((e) => {
    const m = e.met === null ? "?" : (e.met ? "✓" : "✗");
    return `${m} ${conditionMetricLabel(e.metric)} ${e.op} ${e.value} (${conditionFmt(e.metric, e.val)})`;
  });
  return { tier: name, symbol: CONDITION_TIERS[name].symbol, cls: CONDITION_TIERS[name].cls,
           label, tooltip: `Win conditions: ${parts.join(" · ")}` };
}

// Returns {tier, symbol, label, cls, tooltip, ...} or null when this mark's
// deltas aren't available. If the matchup has explicit win-condition targets at
// this mark, grade by those (all/any); otherwise grade the picked method's delta
// vs 0 (absolute) or vs the matchup baseline (relative).
function laneOutcome(g, mark, method = laneWinMethod(), mode = laneGradeMode()) {
  // explicit win conditions grade per lane column: a *_7 delta condition lands
  // on the 7m pill, everything else (14m deltas + game stats like plates/deaths)
  // on the 14m pill — so the two columns match their labels.
  const conds = goalConditions(laneGoalFor(g));
  if (conds.length) {
    const sub = conds.filter((c) => (String(c.metric).endsWith("_7") ? mark === 7 : mark === 14));
    return sub.length ? laneConditionOutcome(g, sub) : null;
  }
  let t = LANE_THRESHOLDS[method][mark];
  const xp = g[`xp_diff_${mark}`], lvl = g[`level_diff_${mark}`];
  let value, unit, metricBase = method === "cs" ? "cs" : method === "xp" ? "xp" : "gold";
  if (method === "cs") { value = g[`cs_diff_${mark}`]; unit = "CS"; }
  else if (method === "xp") {
    // prefer raw XP; fall back to whole levels for games captured before ΔXP
    if (xp != null) { value = xp; unit = "XP"; }
    else { value = lvl; unit = "lvl"; t = LANE_LEVEL_THRESHOLDS[mark]; }
  } else { value = g[`gold_diff_${mark}`]; unit = "g"; }   // gold + combined
  if (value == null) return null;
  // level-fallback games have no baseline in level units → grade absolute
  const relative = mode === "relative" && !(method === "xp" && xp == null);
  const expected = relative ? laneBaseline(g, metricBase, mark) : 0;
  const residual = value - expected;
  const mag = Math.abs(residual);
  let name = mag >= t.stomp ? "stomp" : mag >= t.won ? "won" : "even";
  if (name !== "even" && residual < 0) name = name === "stomp" ? "stomped" : "lost";
  // "combined" gates a gold win/loss on XP agreeing with the residual's sign —
  // a gold edge with XP going the other way is only "even". Prefer raw XP.
  if (method === "combined" && name !== "even") {
    const agree = xp != null ? xp : lvl;
    if (agree != null && Math.sign(agree) !== 0 && Math.sign(agree) !== Math.sign(residual)) name = "even";
  }
  // relative labels only make sense when we actually have a baseline to beat
  const hasBaseline = relative && expected !== 0;
  const sign = value > 0 ? "+" : "";
  const val = unit === "CS" ? value.toFixed(1) : Math.round(value);
  const exp = hasBaseline
    ? ` (matchup usually ${expected > 0 ? "+" : ""}${Math.round(expected)})`
    : (relative ? " · no matchup data yet" : "");
  const label = LANE_TIER_LABELS[hasBaseline ? "relative" : "absolute"][name];
  return { tier: name, value, unit, expected, residual,
           symbol: LANE_TIERS[name].symbol, cls: LANE_TIERS[name].cls, label,
           tooltip: `${label} @${mark}m · ${sign}${val} ${unit} vs opponent${exp}` };
}
async function loadLaneBaselines() {
  try {
    const d = await getJSON("/api/stats/lane-baselines");
    state.laneBaselines = d.baselines || {};
    state.laneGoals = d.goals || {};
  } catch { state.laneBaselines = state.laneBaselines || {}; state.laneGoals = state.laneGoals || {}; }
}

// A little "method: thresholds" legend for the current method + grade mode.
function laneLegendText(method = laneWinMethod(), mode = laneGradeMode()) {
  const u = method === "cs" ? "CS" : method === "xp" ? "XP" : "gold";
  const g = u === "gold" ? "g" : " " + u;
  const t7 = LANE_THRESHOLDS[method][7], t14 = LANE_THRESHOLDS[method][14];
  const basis = mode === "relative"
    ? "vs this matchup's expected outcome (your goal, else the data baseline)"
    : "vs your lane opponent (a raw lead)";
  const win = mode === "relative" ? "Ahead" : "Won";
  return `${basis} · ${win} = ±${t7.won}${g} @7 / ±${t14.won}${g} @14 `
    + `· big = ±${t7.stomp}/${t14.stomp}`
    + (method === "combined" ? " · needs XP to agree" : "");
}

// ---------- full-game gold/CS/XP/level curve chart ----------
// Gold and CS are the two most immediately useful reads for lane/game
// review; XP and level are available from the same endpoint if a future
// pass wants to add a metric switcher.
const GC_METRICS = [
  { key: "gold", label: "Gold", decimals: 0 },
  { key: "cs", label: "CS", decimals: 0 },
];
const GC_CHART_W = 260, GC_CHART_H = 100;
const GC_PAD = { l: 34, r: 8, t: 8, b: 18 };

function gcChartSVG(def, minutes, meValues, oppValues) {
  const mePts = minutes.map((m, i) => ({ x: m, v: meValues[i] })).filter((p) => p.v != null);
  const oppPts = oppValues
    ? minutes.map((m, i) => ({ x: m, v: oppValues[i] })).filter((p) => p.v != null)
    : [];
  const allVals = [...mePts.map((p) => p.v), ...oppPts.map((p) => p.v)];
  if (!allVals.length) return "";
  let lo = Math.min(...allVals), hi = Math.max(...allVals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;
  lo -= span * 0.08; hi += span * 0.08;
  const maxX = Math.max(...minutes, 1);
  const iw = GC_CHART_W - GC_PAD.l - GC_PAD.r, ih = GC_CHART_H - GC_PAD.t - GC_PAD.b;
  const x = (m) => GC_PAD.l + (m / maxX) * iw;
  const y = (v) => GC_PAD.t + ih - ((v - lo) / (hi - lo)) * ih;
  const fmt = (v) => v.toFixed(def.decimals) + (def.suffix || "");
  const line = (pts, cls) => pts.length > 1
    ? `<polyline class="${cls}" points="${
        pts.map((p) => `${x(p.x).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}"/>`
    : "";
  const maxV = Math.max(...allVals), minV = Math.min(...allVals);
  return `<figure class="trend-chart game-curve-chart">
    <figcaption>${def.label}</figcaption>
    <svg viewBox="0 0 ${GC_CHART_W} ${GC_CHART_H}" role="img"
         aria-label="${def.label} over the game">
      <line class="tl-axis" x1="${GC_PAD.l}" x2="${GC_CHART_W - GC_PAD.r}"
            y1="${GC_CHART_H - GC_PAD.b}" y2="${GC_CHART_H - GC_PAD.b}"/>
      <text class="tl-ylab" x="${GC_PAD.l - 4}" y="${y(maxV) + 3}" text-anchor="end">${fmt(maxV)}</text>
      <text class="tl-ylab" x="${GC_PAD.l - 4}" y="${y(minV) + 3}" text-anchor="end">${fmt(minV)}</text>
      ${line(mePts, "gc-line-me")}${line(oppPts, "gc-line-opp")}
      <text class="tl-xlab" x="${GC_PAD.l}" y="${GC_CHART_H - 4}">0m</text>
      <text class="tl-xlab" x="${GC_CHART_W - GC_PAD.r}" y="${GC_CHART_H - 4}" text-anchor="end">${maxX}m</text>
    </svg>
  </figure>`;
}

function gameCurveSection(gkey) {
  if (!curveUi.cache.has(gkey)) return `<p class="muted">Loading…</p>`;
  const curve = curveUi.cache.get(gkey);
  if (!curve) {
    return `<p class="muted">No full-game curve recorded — crawl again or run
      <code>./crawl.sh --backfill-frame-series</code>.</p>`;
  }
  const charts = GC_METRICS.map((def) =>
    gcChartSVG(def, curve.minutes, curve.me[def.key], curve.opp ? curve.opp[def.key] : null)
  ).join("");
  return `<div class="game-curve">
    <div class="game-curve-legend">
      <span class="gc-legend-me">● You</span>
      ${curve.opp ? `<span class="gc-legend-opp">● Opponent</span>` : ""}
    </div>
    <div class="chart-grid">${charts}</div>
  </div>`;
}

async function toggleGameCurve(gkey, matchId, myPuuid, oppPuuid, recent) {
  if (curveUi.open.has(gkey)) {
    curveUi.open.delete(gkey);
  } else {
    curveUi.open.add(gkey);
    if (!curveUi.cache.has(gkey)) {
      const params = new URLSearchParams({ match_id: matchId, puuid: myPuuid });
      if (oppPuuid) params.set("opp_puuid", oppPuuid);
      try {
        curveUi.cache.set(gkey, await getJSON(`/api/stats/game-curve?${params}`));
      } catch {
        curveUi.cache.set(gkey, null);
      }
      renderRecent(recent);  // reflect the "Loading…" -> fetched state
    }
  }
  renderRecent(recent);
}

function runesCompareCol(champ, runes, whose) {
  const body = runes
    ? `<div class="recent-runes-cell-inner">${
        runePageIcons(runes, { keystoneSize: 22, minorSize: 16, treeSize: 18, shardSize: 13 })}</div>`
    : `<p class="muted">Not recorded — crawl again or run
        <code>./crawl.sh --backfill-runes</code>.</p>`;
  return `<div class="runes-compare-col">
    <h5>${champIcon(champ)}${displayName(champ)} <span class="muted">(${whose})</span></h5>
    ${body}
  </div>`;
}

function renderRecent(recent) {
  const target = $("#recent-list");
  if (!recent.length) {
    target.innerHTML = `<div class="table-wrap"><div class="empty">No games.</div></div>`;
    return;
  }
  const multi = selectedPuuids().length > 1;
  const colCount = 12 + (multi ? 1 : 0);
  const names = new Map(state.players.map((p) => [p.puuid, p.game_name]));
  const cols = [
    { key: "date", label: "Date", type: "num", get: (g) => g.game_creation_ms },
    ...(multi ? [{ key: "account", label: "Account", type: "text",
                   get: (g) => names.get(g.my_puuid) ?? "?" }] : []),
    { key: "queue", label: "Queue", type: "text", get: (g) => QUEUE_NAMES[g.queue_id] ?? String(g.queue_id) },
    { key: "me", label: "Me", type: "text", get: (g) => displayName(g.my_champion) },
    { key: "opponent", label: "Opponent", type: "text",
      get: (g) => (g.opp_champion ? displayName(g.opp_champion) : null) },
    { key: "opp_rank", label: "Opp. rank", type: "num",
      get: (g) => (g.opp_champion ? RANK_ORDINAL[g.rank_tier] : null) },
    { key: "result", label: "Result", type: "num", get: (g) => (g.win ? 1 : 0) },
    { key: "kda", label: "K/D/A", type: "num", get: kdaRatio },
    { key: "length", label: "Length", type: "num", get: (g) => g.game_duration_s },
    { key: "runes", label: "Runes", sortable: false },
    { key: "curve", label: "Curve", sortable: false },
    { key: "reflect", label: "Reflection", sortable: false },
    { key: "block", label: "", sortable: false },
  ];
  const body = sortRows(recent, recentUi.sort, cols).map((g) => {
    const gkey = `${g.match_id}:${g.my_puuid}`;
    const runesOpen = recentUi.runesOpen.has(gkey);
    const reflectOpen = recentUi.reflectOpen.has(gkey);
    const hasRunes = g.runes || g.opp_runes;
    const curveOpen = curveUi.open.has(gkey);
    const tagCount = reflectionTagCount(g.match_id, g.my_puuid);
    let html = `<tr>
      <td>${fmtDateTime(g.game_creation_ms)}</td>
      ${multi ? `<td>${escapeHtml(names.get(g.my_puuid) ?? "?")}</td>` : ""}
      <td>${QUEUE_NAMES[g.queue_id] ?? g.queue_id}</td>
      <td><span class="champ-cell">${champIcon(g.my_champion)}${displayName(g.my_champion)}</span></td>
      <td><span class="champ-cell">${g.opp_champion ? champIcon(g.opp_champion) + "vs " + displayName(g.opp_champion) : "–"}</span></td>
      <td>${g.opp_champion ? titleCase(g.rank_tier) : "–"}</td>
      <td><span class="result-pill ${g.win ? "win" : "loss"}">${g.win ? "W" : "L"}</span></td>
      <td>${g.kills}/${g.deaths}/${g.assists}</td>
      <td>${fmtDuration(g.game_duration_s)}</td>
      <td>${hasRunes
        ? `<button class="preset seg-toggle runes-toggle" data-gkey="${gkey}"
             aria-expanded="${runesOpen}" title="Runes">${runesOpen ? "▾" : "▸"} Runes</button>`
        : `<span class="muted">–</span>`}</td>
      <td><button class="preset seg-toggle curve-toggle" data-gkey="${gkey}"
             data-match="${g.match_id}" data-puuid="${g.my_puuid}" data-opp="${g.opp_puuid ?? ""}"
             aria-expanded="${curveOpen}" title="Full-game gold/CS curve">${curveOpen ? "▾" : "▸"} Curve</button></td>
      <td><button class="preset seg-toggle reflect-toggle" data-gkey="${gkey}"
        data-match="${g.match_id}" data-puuid="${g.my_puuid}" aria-expanded="${reflectOpen}"
        title="Reflection">${reflectOpen ? "▾" : "▸"} Reflect${tagCount ? ` (${tagCount})` : ""}</button></td>
      <td><button class="preset promote-btn" data-match="${g.match_id}"
        data-puuid="${g.my_puuid}" title="Add to current block">+ Block</button></td>
    </tr>`;
    if (runesOpen || reflectOpen) {
      html += `<tr class="games-row"><td colspan="${colCount}">
        ${runesOpen ? `<div class="runes-compare">${
          runesCompareCol(g.my_champion, g.runes, "you")}${
          g.opp_champion ? runesCompareCol(g.opp_champion, g.opp_runes, "opponent") : ""
        }</div>` : ""}
        ${reflectOpen ? reflectionSection(g.match_id, g.my_puuid) : ""}
      </td></tr>`;
    }
    if (curveOpen) {
      html += `<tr class="games-row"><td colspan="${colCount}">${gameCurveSection(gkey)}</td></tr>`;
    }
    return html;
  }).join("");
  target.innerHTML = `<div class="table-wrap"><table>
    ${sortableThead(cols, recentUi.sort)}
    <tbody>${body}</tbody></table></div>`;
  wireSortable(target, recentUi.sort, cols, () => renderRecent(recent));
  wirePromoteButtons(target);
  target.querySelectorAll(".curve-toggle").forEach((btn) =>
    btn.addEventListener("click", () =>
      toggleGameCurve(btn.dataset.gkey, btn.dataset.match, btn.dataset.puuid,
        btn.dataset.opp || null, recent)));
  target.querySelectorAll(".runes-toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      const gkey = btn.dataset.gkey;
      recentUi.runesOpen.has(gkey) ? recentUi.runesOpen.delete(gkey) : recentUi.runesOpen.add(gkey);
      renderRecent(recent);
    }));
  target.querySelectorAll(".reflect-toggle").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const gkey = btn.dataset.gkey;
      if (recentUi.reflectOpen.has(gkey)) {
        recentUi.reflectOpen.delete(gkey);
        renderRecent(recent);
        return;
      }
      recentUi.reflectOpen.add(gkey);
      renderRecent(recent); // show "Loading…" immediately
      await ensureReflection(btn.dataset.match, btn.dataset.puuid);
      renderRecent(recent);
    }));
  wireReflectionSection(target, async (matchId, puuid) => {
    reflectionUi.cache.delete(reflectionKey(matchId, puuid));
    await ensureReflection(matchId, puuid);
    renderRecent(recent);
  }, () => renderRecent(recent));
}

function wirePromoteButtons(container) {
  container.querySelectorAll(".promote-btn").forEach((btn) =>
    btn.addEventListener("click", () =>
      promoteGame(btn.dataset.match, btn.dataset.puuid, btn)));
}

function tierClass(player) {
  // no class when unranked or when the rank is hidden (server nulls solo_tier)
  return player && player.solo_tier ? ` tier-${player.solo_tier.toLowerCase()}` : "";
}

function renderAccountSelector() {
  const box = $("#account-select");
  box.classList.toggle("hidden", state.players.length < 2);
  if (state.players.length < 2) return;
  const btn = $("#account-select-btn");
  const selected = selectedPuuids();
  let label, cls = "";
  if (state.accounts === null) {
    label = "All accounts";
  } else if (selected.length === 1) {
    const p = state.players.find((q) => q.puuid === selected[0]);
    label = p ? p.game_name : "1 account";
    cls = tierClass(p);
  } else {
    label = `${selected.length} accounts`;
  }
  btn.innerHTML = `${escapeHtml(label)} ▾`;
  btn.className = `preset${cls}`;
  $("#account-select-menu").innerHTML =
    `<label><input type="checkbox" data-all ${state.accounts === null ? "checked" : ""}>
       All accounts</label>` +
    state.players.map((p) => `<label class="${tierClass(p).trim()}">
        <input type="checkbox" data-puuid="${p.puuid}"
          ${state.accounts !== null && state.accounts.includes(p.puuid) ? "checked" : ""}>
        ${escapeHtml(p.game_name)}#${escapeHtml(p.tag_line)}</label>`).join("");
  $("#account-select-menu").querySelectorAll("input").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.dataset.all !== undefined) {
        state.accounts = null;
      } else {
        const checked = [...$("#account-select-menu")
          .querySelectorAll("input[data-puuid]:checked")].map((c) => c.dataset.puuid);
        // none or every account selected collapses back to "all"
        state.accounts = checked.length && checked.length < state.players.length
          ? checked : null;
      }
      accountSelectionChanged();
    }));
}

function accountSelectionChanged() {
  renderAccountSelector();
  // overview is always refreshed (it doesn't reload on nav); the active
  // stats view reloads its own data. Blocks/settings aren't account-scoped.
  loadFilterOptions().then(refresh);
  if (state.mainView === "matchups") initMatchups();
  else if (state.mainView === "progress") loadProgressFilterOptions().then(loadProgress);
  else if (state.mainView === "trends") initTrends(); // rebuilds filter options too
  else if (state.mainView === "guide") loadGuide(); // refresh matchup game counts for the new scope
}

// ---------- data loading ----------

async function loadFilterOptions() {
  const opts = await getJSON(`/api/filters?${accountParams()}`);
  // a filter value the new account scope can't produce silently zeroes all
  // stats while the dropdown shows "All" — reset instead
  if (state.champion && !opts.champions.includes(state.champion)) state.champion = "";
  if (state.queue && !opts.queues.map(String).includes(state.queue)) state.queue = "";
  if (state.rankTier && !opts.rank_tiers.includes(state.rankTier)) state.rankTier = "";
  $("#champion-select").innerHTML = `<option value="">All</option>` +
    opts.champions.map((c) => `<option value="${c}" ${c === state.champion ? "selected" : ""}>${displayName(c)}</option>`).join("");
  $("#queue-select").innerHTML = `<option value="">All</option>` +
    opts.queues.map((q) => `<option value="${q}" ${String(q) === state.queue ? "selected" : ""}>${QUEUE_NAMES[q] ?? q}</option>`).join("");
  $("#rank-select").innerHTML = `<option value="">All</option>` +
    opts.rank_tiers.map((t) => `<option value="${t}" ${t === state.rankTier ? "selected" : ""}>${titleCase(t)}</option>`).join("");
}

let refreshSeq = 0;

async function refresh() {
  const seq = ++refreshSeq;
  const qs = queryString();
  const [summary, rankHistory, reviewQueue] = await Promise.all([
    getJSON(`/api/stats/summary?${qs}`),
    getJSON("/api/stats/rank-history"),
    getJSON(`/api/stats/review-queue?${accountParams()}`),
  ]);
  if (seq !== refreshSeq) return; // superseded by a newer refresh
  state.rankHistory = rankHistory;
  renderSummary(summary);
  renderChampionTable(summary.by_champion ?? []);
  renderRecent(summary.recent ?? []);
  renderRankChart();
  renderReviewQueue(reviewQueue);
}

// ---------- "review before queue" nudge ----------

function reviewQueueRow(row) {
  const badge = row.notes_updated_ms == null
    ? `<span class="block-badge">never reviewed</span>`
    : `<span class="block-badge block-closed">${row.games_since_review} game${row.games_since_review === 1 ? "" : "s"} since review</span>`;
  return `<div class="review-queue-row">
    <span class="champ-cell">${champIcon(row.my_champion)}${displayName(row.my_champion)}
      <span class="muted">vs</span> ${champIcon(row.opp_champion)}${displayName(row.opp_champion)}</span>
    <span class="muted">last played ${fmtDate(row.last_played_ms)}</span>
    ${badge}
    <button class="link-btn review-queue-open" data-my="${escapeHtml(row.my_champion)}"
      data-opp="${escapeHtml(row.opp_champion)}">Review in guide →</button>
  </div>`;
}

function renderReviewQueue(rows) {
  const section = $("#review-queue-section");
  if (!rows.length) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  $("#review-queue-list").innerHTML = rows.map(reviewQueueRow).join("");
  section.querySelectorAll(".review-queue-open").forEach((btn) =>
    btn.addEventListener("click", () => openGuide(btn.dataset.my, btn.dataset.opp)));
}

// ---------- coaching progress ----------

function fmtSegmentDates(segment) {
  return `${fmtDate(segment.from_ms)} – ${fmtDate(segment.to_ms)}`;
}

function delta(current, previous, key, digits, suffix = "") {
  if (!current.games || !previous || !previous.games) return "";
  const diff = (current[key] ?? 0) - (previous[key] ?? 0);
  if (!isFinite(diff)) return "";
  const cls = diff >= 0 ? "delta-up" : "delta-down";
  const arrow = diff >= 0 ? "▲" : "▼";
  return `<span class="${cls}">${arrow} ${Math.abs(diff).toFixed(digits)}${suffix}</span>`;
}

const segmentUi = { expanded: new Set(), expandedGames: new Set(), cache: new Map(), segments: [] };

function segKey(segment) {
  return `${segment.from_ms}:${segment.to_ms}`;
}

function progressFilterParams(segment) {
  const params = accountParams(
    new URLSearchParams({ from_ms: segment.from_ms, to_ms: segment.to_ms - 1 }));
  if (state.progressChampion) params.set("champion", state.progressChampion);
  if (state.progressQueue) params.set("queue", state.progressQueue);
  if (state.progressSide) params.set("side", state.progressSide);
  return params;
}

function prevNonEmpty(segment) {
  const i = segmentUi.segments.indexOf(segment);
  return segmentUi.segments.slice(0, i).reverse().find((s) => s.games > 0) || null;
}

async function ensureSegmentMetrics(segment) {
  const targets = [segment];
  const prev = prevNonEmpty(segment);
  if (prev) targets.push(prev);
  await Promise.all(targets.map(async (s) => {
    const cacheKey = "metrics:" + segKey(s);
    if (segmentUi.cache.has(cacheKey)) return;
    const data = await getJSON(`/api/stats/metrics?${progressFilterParams(s)}`);
    if (!state.metricsMeta) state.metricsMeta = data.meta;
    segmentUi.cache.set(cacheKey, data);
  }));
}

function fmtMetric(value, m) {
  if (value == null) return "–";
  const sign = m.signed && value > 0 ? "+" : "";
  return sign + value.toFixed(m.decimals) + (m.suffix || "");
}

// ---------- per-view metric column pickers ----------
// All metric panels render from the shared registry meta; each view keeps its
// own visible set (default_hidden metrics — e.g. the lane Δ's — start off).

async function ensureMetricsMeta() {
  if (!state.metricsMeta) state.metricsMeta = (await getJSON("/api/metrics/meta")).meta;
  return state.metricsMeta;
}

// visible metric keys for a view, honouring default_hidden and saved prefs
function visibleMetricKeys(storageKey) {
  const meta = state.metricsMeta || [];
  return colPrefs(storageKey, meta.map((m) => m.key),
                  meta.filter((m) => !m.default_hidden).map((m) => m.key));
}

// meta filtered to a view's visible metrics, for a panel to render
function visibleMeta(storageKey) {
  const vis = visibleMetricKeys(storageKey);
  return (state.metricsMeta || []).filter((m) => vis.has(m.key));
}

function renderMetricColPicker(target, storageKey, onChange) {
  const meta = state.metricsMeta || [];
  renderColPicker(target, storageKey, meta.map((m) => ({ key: m.key, label: m.label })),
                  visibleMetricKeys(storageKey), onChange);
}

function metricDelta(current, previous, m) {
  if (current == null || previous == null) return "";
  const diff = current - previous;
  if (Number(Math.abs(diff).toFixed(m.decimals)) === 0) return ""; // no visible change
  const arrow = diff >= 0 ? "▲" : "▼";
  const cls = m.direction === 0 ? "delta-neutral"
    : (diff * m.direction >= 0 ? "delta-up" : "delta-down");
  return `<span class="${cls}">${arrow} ${Math.abs(diff).toFixed(m.decimals)}${m.suffix || ""}</span>`;
}

function segmentMetricsPanel(segment) {
  const key = segKey(segment);
  const data = segmentUi.cache.get("metrics:" + key);
  if (!data) return `<div class="muted">Loading…</div>`;
  const prev = prevNonEmpty(segment);
  const prevData = prev ? segmentUi.cache.get("metrics:" + segKey(prev)) : null;
  const meta = state.metricsMeta || [];  // expanded panel shows every metric
  const groups = [...new Set(meta.map((m) => m.group))];
  const coverage = data.metrics_games < data.games
    ? `<div class="muted" style="margin-bottom:8px">Detailed metrics available for
       ${data.metrics_games} of ${data.games} games in this period.</div>` : "";
  const groupHtml = groups.map((g) => {
    const rows = meta.filter((m) => m.group === g).map((m) => `
      <div class="metric-row">
        <span class="metric-label">${m.label}</span>
        <span class="metric-value">${fmtMetric(data.metrics[m.key], m)}
          <span class="delta-slot">${prevData ? metricDelta(data.metrics[m.key], prevData.metrics[m.key], m) : ""}</span>
        </span>
      </div>`).join("");
    return `<div class="metric-group"><h4>${g}</h4>${rows}</div>`;
  }).join("");
  const gamesOpen = segmentUi.expandedGames.has(key);
  return `${coverage}<div class="metric-groups">${groupHtml}</div>
    <button class="preset games-toggle" data-key="${key}" aria-expanded="${gamesOpen}">
      ${gamesOpen ? "▾" : "▸"} Games (${segment.games})</button>
    ${gamesOpen ? `<div class="nested-games">${segmentGamesTable(segmentUi.cache.get("games:" + key))}</div>` : ""}`;
}

async function toggleSegmentGames(segment) {
  const key = segKey(segment);
  if (segmentUi.expandedGames.has(key)) {
    segmentUi.expandedGames.delete(key);
  } else {
    segmentUi.expandedGames.add(key);
    const cacheKey = "games:" + key;
    if (!segmentUi.cache.has(cacheKey)) {
      segmentUi.cache.set(cacheKey, await getJSON(`/api/stats/games?${progressFilterParams(segment)}`));
    }
  }
  renderProgress(segmentUi.segments);
}

function segmentGamesTable(games) {
  if (!games) return `<div class="muted">Loading…</div>`;
  if (!games.length) return `<div class="muted">No games in this period.</div>`;
  const rows = games.map((g) => `<tr>
      <td>${fmtDate(g.game_creation_ms)}</td>
      <td>${escapeHtml(g.account)}</td>
      <td><span class="champ-cell">${champIcon(g.my_champion)}${displayName(g.my_champion)}</span></td>
      <td><span class="champ-cell">${g.opp_champion ? champIcon(g.opp_champion) + "vs " + displayName(g.opp_champion) : "–"}</span></td>
      <td>${g.opp_champion ? titleCase(g.rank_tier) : "–"}</td>
      <td><span class="result-pill ${g.win ? "win" : "loss"}">${g.win ? "W" : "L"}</span></td>
      <td>${g.kills}/${g.deaths}/${g.assists}</td>
      <td>${(g.cs * 60 / g.game_duration_s).toFixed(1)}</td>
      <td>${fmtDuration(g.game_duration_s)}</td>
      <td><button class="preset promote-btn" data-match="${g.match_id}"
        data-puuid="${g.my_puuid}" title="Add to current block">+ Block</button></td>
    </tr>`).join("");
  return `<table class="games-inner">
    <thead><tr><th>Date</th><th>Account</th><th>Me</th><th>Opponent</th><th>Opp. rank</th>
    <th>Result</th><th>K/D/A</th><th>CS/min</th><th>Length</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

async function toggleSegment(segment) {
  const key = segKey(segment);
  if (segmentUi.expanded.has(key)) {
    segmentUi.expanded.delete(key);
    renderProgress(segmentUi.segments);
    return;
  }
  segmentUi.expanded.add(key);
  await ensureSegmentMetrics(segment);
  renderProgress(segmentUi.segments);
}

const PROGRESS_COLS = [
  { key: "rank", label: "Rank at start" },
  { key: "games", label: "Games" },
  { key: "wl", label: "W–L" },
  { key: "winrate", label: "Winrate" },
  { key: "kda", label: "KDA" },
  { key: "cs", label: "CS/min" },
  { key: "gold", label: "Gold/min" },
  { key: "dmg", label: "DMG/min" },
];
// metric-average columns (incl. lane deltas) available in the progress table,
// keyed "m:<metric>"; off by default. Cells read segment.metrics.
function progressMetricCols() {
  return (state.metricsMeta || []).map((m) => ({
    key: `m:${m.key}`, label: m.label,
    cell: (seg) => `<td>${fmtMetric(seg.metrics ? seg.metrics[m.key] : null, m)}</td>`,
  }));
}
function progressAllCols() { return [...PROGRESS_COLS, ...progressMetricCols()]; }
function progressVisibleKeys() {
  return colPrefs("cp-cols-progress", progressAllCols().map((c) => c.key),
                  PROGRESS_COLS.map((c) => c.key)); // base on, metric averages off
}
function progressVisibleCols() {
  const vis = progressVisibleKeys();
  return progressAllCols().filter((c) => vis.has(c.key));
}

function renderProgress(segments) {
  segmentUi.segments = segments;
  const target = $("#progress-table");
  if (!segments.length) {
    target.innerHTML = `<div class="table-wrap"><div class="empty">
      No coaching sessions yet — add your first one below.</div></div>`;
    return;
  }
  const visible = progressVisibleCols();
  const rows = segments.map((segment, i) => {
    const previous = segments.slice(0, i).reverse().find((s) => s.games > 0);
    const wrDelta = delta(segment, previous, "winrate_pp", 1, "pp");
    const kdaDelta = delta(segment, previous, "kda", 2);
    const csDelta = delta(segment, previous, "cs_min", 1);
    const empty = !segment.games;
    const key = segKey(segment);
    const expanded = segmentUi.expanded.has(key);
    const cells = {
      rank: `<td class="rank-cell">${fmtRankList(segment.start_ranks)}</td>`,
      games: `<td>${segment.games}</td>`,
      wl: `<td>${empty ? "–" : `${segment.wins}–${segment.games - segment.wins}`}</td>`,
      winrate: `<td class="wr-col">${empty ? "–" : wrCell(segment.winrate)}<span class="delta-slot">${wrDelta}</span></td>`,
      kda: `<td>${fmt(segment.kda, 2)}<span class="delta-slot">${kdaDelta}</span></td>`,
      cs: `<td>${fmt(segment.cs_min)}<span class="delta-slot">${csDelta}</span></td>`,
      gold: `<td>${fmt(segment.gold_min, 0)}</td>`,
      dmg: `<td>${fmt(segment.dmg_min, 0)}</td>`,
    };
    let html = `<tr${empty ? ' class="muted"' : ""}>
      <td class="period-cell"><div class="period-wrap">
        <button class="preset seg-toggle" data-i="${i}" aria-expanded="${expanded}">${expanded ? "▾" : "▸"}</button>
        <div class="period-text"><strong>${segment.label}</strong><br><span class="muted period-sub">${fmtSegmentDates(segment)}${segment.note ? " · " + escapeHtml(segment.note) : ""}</span></div>
      </div></td>` + visible.map((c) => (c.cell ? c.cell(segment) : cells[c.key])).join("") + `</tr>`;
    if (expanded) {
      html += `<tr class="games-row"><td colspan="${visible.length + 1}">${segmentMetricsPanel(segment)}</td></tr>`;
    }
    return html;
  }).join("");
  const headers = { winrate: ' class="wr-col"' };
  target.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Period</th>` +
    visible.map((c) => `<th${headers[c.key] || ""}>${c.label}</th>`).join("") +
    `</tr></thead><tbody>${rows}</tbody></table></div>`;
  target.querySelectorAll(".seg-toggle").forEach((btn) =>
    btn.addEventListener("click", () => toggleSegment(segments[+btn.dataset.i])));
  target.querySelectorAll(".games-toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      const segment = segments.find((s) => segKey(s) === btn.dataset.key);
      if (segment) toggleSegmentGames(segment);
    }));
  wirePromoteButtons(target);
}

const sessionUi = { expanded: new Set(), editing: null, clips: new Map() };

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderNotes(notes) {
  if (!notes) return `<p class="muted">No notes yet — click edit to add some.</p>`;
  if (typeof marked !== "undefined") return marked.parse(notes);
  return `<pre>${escapeHtml(notes)}</pre>`; // fallback if vendor lib missing
}

// ---------- clips (shared by coaching sessions and block games) ----------

const clipsUi = { formOpen: new Set() }; // "ownerType:ownerId" keys with the add-form open

function clipsSection(ownerType, ownerId, clips) {
  const key = `${ownerType}:${ownerId}`;
  const items = clips === undefined
    ? `<p class="muted">Loading…</p>`
    : (clips.length ? clips.map((c) => `<div class="clip-item">
        <div class="clip-item-head">
          <span class="clip-label">${c.label ? escapeHtml(c.label) : `<span class="muted">clip</span>`}</span>
          <button class="preset icon-btn clip-delete" data-id="${c.id}"
            title="Delete clip" aria-label="Delete clip">🗑</button>
        </div>
        ${c.kind === "upload"
          ? `<video controls preload="metadata" src="${escapeHtml(c.play_url)}"></video>`
          : `<a href="${escapeHtml(c.play_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.play_url)}</a>`}
      </div>`).join("") : "");
  const form = clipsUi.formOpen.has(key)
    ? `<form class="clip-add-form">
        <input type="text" class="clip-label-input" placeholder='Label (optional) — e.g. "wave management @14min"'>
        <div class="clip-add-row">
          <input type="file" class="clip-file-input" accept=".mp4,.mov,.webm,.m4v,video/mp4,video/quicktime,video/webm">
          <span class="muted">or</span>
          <input type="url" class="clip-url-input" placeholder="paste a link (YouTube, Twitch…)">
        </div>
        <div class="session-actions">
          <button type="submit" class="preset">Add</button>
          <button type="button" class="preset clip-form-cancel">Cancel</button>
          <span class="muted clip-add-status"></span>
        </div>
      </form>`
    : `<button type="button" class="preset clip-form-open">+ Add clip</button>`;
  return `<div class="clips-section" data-owner-type="${ownerType}" data-owner-id="${ownerId}">
    <h5>Clips${clips && clips.length ? ` (${clips.length})` : ""}</h5>
    <div class="clips-list">${items}</div>
    ${form}
  </div>`;
}

// reload(ownerType, ownerId): async callback the caller supplies to refetch
// that owner's clips into its own cache and re-render its view.
// rerender(): cheap re-render of the caller's view without refetching —
// used for opening/closing the add form.
function wireClipsSection(container, reload, rerender) {
  const toggleForm = (btn, open) => {
    const section = btn.closest(".clips-section");
    const key = `${section.dataset.ownerType}:${section.dataset.ownerId}`;
    open ? clipsUi.formOpen.add(key) : clipsUi.formOpen.delete(key);
    rerender();
  };
  container.querySelectorAll(".clip-form-open").forEach((btn) =>
    btn.addEventListener("click", () => toggleForm(btn, true)));
  container.querySelectorAll(".clip-form-cancel").forEach((btn) =>
    btn.addEventListener("click", () => toggleForm(btn, false)));
  container.querySelectorAll(".clip-delete").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this clip?")) return;
      await fetch(`/api/clips/${btn.dataset.id}`, { method: "DELETE" });
      const section = btn.closest(".clips-section");
      await reload(section.dataset.ownerType, section.dataset.ownerId);
    }));
  container.querySelectorAll(".clip-add-form").forEach((form) =>
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const section = form.closest(".clips-section");
      const status = form.querySelector(".clip-add-status");
      const label = form.querySelector(".clip-label-input").value;
      const file = form.querySelector(".clip-file-input").files[0];
      const url = form.querySelector(".clip-url-input").value.trim();
      if (!file && !url) { status.textContent = "add a file or a link"; return; }
      if (file && url) { status.textContent = "choose either a file or a link, not both"; return; }
      const fd = new FormData();
      fd.set("owner_type", section.dataset.ownerType);
      fd.set("owner_id", section.dataset.ownerId);
      fd.set("label", label);
      if (file) fd.set("file", file); else fd.set("url", url);
      status.textContent = "adding…";
      const response = await fetch("/api/clips", { method: "POST", body: fd });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        status.textContent = body.detail || `error ${response.status}`;
        return;
      }
      clipsUi.formOpen.delete(`${section.dataset.ownerType}:${section.dataset.ownerId}`);
      await reload(section.dataset.ownerType, section.dataset.ownerId);
    }));
}

// ---------- game reflections (shared by Overview recent games and block game panels) ----------
// A quick per-game tag/note, independent of matchup notes / block learnings /
// sessions — a fast post-match reflection habit, not a full write-up.

const REFLECTION_SUGGESTED_TAGS = [
  "bad TP", "int death", "tilted", "good vision", "objective miss", "won lane lost game",
];

const reflectionUi = {
  cache: new Map(),        // "matchId:puuid" -> {tags, note} once fetched
  editingNote: new Set(),  // "matchId:puuid" keys with the note editor open
};

function reflectionKey(matchId, puuid) { return `${matchId}:${puuid}`; }

async function ensureReflection(matchId, puuid) {
  const key = reflectionKey(matchId, puuid);
  if (reflectionUi.cache.has(key)) return;
  reflectionUi.cache.set(key, await getJSON(
    `/api/reflections?match_id=${encodeURIComponent(matchId)}&puuid=${encodeURIComponent(puuid)}`));
}

function reflectionTagCount(matchId, puuid) {
  const cached = reflectionUi.cache.get(reflectionKey(matchId, puuid));
  return cached ? cached.tags.length : 0;
}

async function putReflection(matchId, puuid, fields) {
  return fetch(`/api/reflections/${encodeURIComponent(matchId)}/${encodeURIComponent(puuid)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
}

function reflectionSection(matchId, puuid) {
  const key = reflectionKey(matchId, puuid);
  const reflection = reflectionUi.cache.get(key);
  if (!reflection) {
    return `<div class="reflection-section" data-match="${escapeHtml(matchId)}" data-puuid="${escapeHtml(puuid)}">
      <h5>Reflection</h5><p class="muted">Loading…</p></div>`;
  }
  const tags = reflection.tags;
  const allTags = [...REFLECTION_SUGGESTED_TAGS, ...tags.filter((t) => !REFLECTION_SUGGESTED_TAGS.includes(t))];
  const chips = allTags.map((t) => {
    const active = tags.includes(t);
    return `<button type="button" class="chip reflection-tag ${active ? "chip-main" : "chip-inactive"}"
      data-tag="${escapeHtml(t)}" aria-pressed="${active}">${escapeHtml(t)}</button>`;
  }).join("");
  const editing = reflectionUi.editingNote.has(key);
  const noteBody = editing
    ? `<div class="mu-notes">
        <label class="filter-label">Note (Markdown)</label>
        <textarea class="reflection-note-input" rows="4"
          placeholder="Optional freeform note — what happened, what to do differently…">${escapeHtml(reflection.note)}</textarea>
        <div class="session-actions">
          <button type="button" class="preset reflection-note-save">Save</button>
          <button type="button" class="preset reflection-note-cancel">Cancel</button>
          <span class="muted reflection-note-status"></span>
        </div>
      </div>`
    : `<div class="reflection-note-view">
        <div class="md-body">${reflection.note ? renderNotes(reflection.note) : `<p class="muted">No note yet.</p>`}</div>
        <button type="button" class="preset icon-btn reflection-note-edit" title="Edit reflection note" aria-label="Edit reflection note">✎</button>
      </div>`;
  return `<div class="reflection-section" data-match="${escapeHtml(matchId)}" data-puuid="${escapeHtml(puuid)}">
    <h5>Reflection</h5>
    <div class="chip-box reflection-tags">
      ${chips}
      <input type="text" class="chip-input reflection-tag-input" placeholder="+ custom tag (Enter)">
    </div>
    <span class="muted reflection-tag-status"></span>
    ${noteBody}
  </div>`;
}

// reload(matchId, puuid): async callback the caller supplies to refetch that
// game's reflection into its own cache and re-render its view.
// rerender(): cheap re-render of the caller's view without refetching — used
// for opening/closing the note editor.
function wireReflectionSection(container, reload, rerender) {
  container.querySelectorAll(".reflection-tags").forEach((box) =>
    box.addEventListener("click", (e) => {
      if (e.target === box) box.querySelector(".reflection-tag-input")?.focus();
    }));
  container.querySelectorAll(".reflection-tag").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const section = btn.closest(".reflection-section");
      const { match: matchId, puuid } = section.dataset;
      const current = reflectionUi.cache.get(reflectionKey(matchId, puuid)) || { tags: [], note: "" };
      const tag = btn.dataset.tag;
      const tags = current.tags.includes(tag)
        ? current.tags.filter((t) => t !== tag) : [...current.tags, tag];
      const response = await putReflection(matchId, puuid, { tags });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        section.querySelector(".reflection-tag-status").textContent =
          body.detail || `error ${response.status}`;
        return;
      }
      await reload(matchId, puuid);
    }));
  container.querySelectorAll(".reflection-tag-input").forEach((input) =>
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" && e.key !== ",") return;
      e.preventDefault();
      const value = input.value.replace(",", "").trim();
      if (!value) return;
      const section = input.closest(".reflection-section");
      const { match: matchId, puuid } = section.dataset;
      const current = reflectionUi.cache.get(reflectionKey(matchId, puuid)) || { tags: [], note: "" };
      if (current.tags.includes(value)) { input.value = ""; return; }
      const response = await putReflection(matchId, puuid, { tags: [...current.tags, value] });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        section.querySelector(".reflection-tag-status").textContent =
          body.detail || `error ${response.status}`;
        return;
      }
      input.value = "";
      await reload(matchId, puuid);
    }));
  container.querySelectorAll(".reflection-note-edit").forEach((btn) =>
    btn.addEventListener("click", () => {
      const section = btn.closest(".reflection-section");
      reflectionUi.editingNote.add(reflectionKey(section.dataset.match, section.dataset.puuid));
      rerender();
    }));
  container.querySelectorAll(".reflection-note-cancel").forEach((btn) =>
    btn.addEventListener("click", () => {
      const section = btn.closest(".reflection-section");
      reflectionUi.editingNote.delete(reflectionKey(section.dataset.match, section.dataset.puuid));
      rerender();
    }));
  container.querySelectorAll(".reflection-note-save").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const section = btn.closest(".reflection-section");
      const { match: matchId, puuid } = section.dataset;
      const note = section.querySelector(".reflection-note-input").value;
      const status = section.querySelector(".reflection-note-status");
      const response = await putReflection(matchId, puuid, { note });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        status.textContent = body.detail || `error ${response.status}`;
        return;
      }
      reflectionUi.editingNote.delete(reflectionKey(matchId, puuid));
      await reload(matchId, puuid);
    }));
}

function sessionCard(s) {
  const expanded = sessionUi.expanded.has(s.id);
  const editing = sessionUi.editing === s.id;
  let body = "";
  if (editing) {
    body = `<div class="session-body">
      <label class="filter-label" for="edit-title-${s.id}">Title</label>
      <input type="text" id="edit-title-${s.id}" value="${escapeHtml(s.title)}" style="width:100%">
      <label class="filter-label" for="edit-notes-${s.id}">Notes (Markdown)</label>
      <textarea id="edit-notes-${s.id}" rows="10">${escapeHtml(s.notes)}</textarea>
      <div class="session-actions">
        <button class="preset session-save" data-id="${s.id}">Save</button>
        <button class="preset session-cancel">Cancel</button>
      </div>
    </div>`;
  } else if (expanded) {
    body = `<div class="session-body md-body">${renderNotes(s.notes)}</div>`;
  }
  const clips = (expanded || editing)
    ? clipsSection("session", s.id, sessionUi.clips.get(s.id)) : "";
  return `<div class="session-card">
    <div class="session-head">
      <button class="preset session-toggle" data-id="${s.id}" aria-expanded="${expanded}">
        ${expanded || editing ? "▾" : "▸"}</button>
      <span class="session-date">${s.session_date}</span>
      <span class="session-title">${s.title ? escapeHtml(s.title) : "<span class='muted'>untitled</span>"}</span>
      <span class="session-actions">
        <button class="preset icon-btn session-edit" data-id="${s.id}" title="Edit session" aria-label="Edit session">✎</button>
        <button class="preset icon-btn session-delete" data-id="${s.id}" title="Delete session" aria-label="Delete session">🗑</button>
      </span>
    </div>
    ${body}
    ${clips}
  </div>`;
}

async function ensureSessionClips(id) {
  if (sessionUi.clips.has(id)) return;
  sessionUi.clips.set(id, await getJSON(`/api/clips?owner_type=session&owner_id=${id}`));
}

function renderSessions(sessionRows) {
  const target = $("#session-list");
  if (!sessionRows.length) {
    target.innerHTML = `<div class="muted">No sessions recorded.</div>`;
    return;
  }
  target.innerHTML = sessionRows.map(sessionCard).join("");
  target.querySelectorAll(".session-toggle").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = +btn.dataset.id;
      if (sessionUi.expanded.has(id)) {
        sessionUi.expanded.delete(id);
        if (sessionUi.editing === id) sessionUi.editing = null;
        renderSessions(sessionRows);
        return;
      }
      sessionUi.expanded.add(id);
      renderSessions(sessionRows); // show "Loading…" immediately
      await ensureSessionClips(id);
      renderSessions(sessionRows);
    }));
  target.querySelectorAll(".session-edit").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = +btn.dataset.id;
      sessionUi.editing = id;
      sessionUi.expanded.add(id);
      renderSessions(sessionRows);
      await ensureSessionClips(id);
      renderSessions(sessionRows);
    }));
  target.querySelectorAll(".session-cancel").forEach((btn) =>
    btn.addEventListener("click", () => {
      sessionUi.editing = null;
      renderSessions(sessionRows);
    }));
  target.querySelectorAll(".session-save").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = +btn.dataset.id;
      const response = await fetch(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: $(`#edit-title-${id}`).value,
          notes: $(`#edit-notes-${id}`).value,
        }),
      });
      if (response.ok) {
        sessionUi.editing = null;
        loadProgress(); // titles appear in the segment table too
      }
    }));
  target.querySelectorAll(".session-delete").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this coaching session?")) return;
      await fetch(`/api/sessions/${btn.dataset.id}`, { method: "DELETE" });
      loadProgress();
      refreshCoachingNudge();
    }));
  wireClipsSection(target, async (ownerType, ownerId) => {
    sessionUi.clips.delete(+ownerId);
    await ensureSessionClips(+ownerId);
    renderSessions(sessionRows);
  }, () => renderSessions(sessionRows));
}

async function unionFilterOptions() {
  // server unions across the selected accounts (all tracked when unscoped)
  const opts = await getJSON(`/api/filters?${accountParams()}`);
  return { champions: opts.champions, queues: opts.queues };
}

async function loadProgressFilterOptions() {
  const { champions, queues } = await unionFilterOptions();
  if (state.progressChampion === null) {
    state.progressChampion = champions.includes("Gwen") ? "Gwen" : "";
  }
  $("#progress-champion").innerHTML = `<option value="">All</option>` +
    champions.map((c) => `<option value="${c}" ${c === state.progressChampion ? "selected" : ""}>${displayName(c)}</option>`).join("");
  $("#progress-queue").innerHTML = `<option value="">All</option>` +
    queues.map((q) => `<option value="${q}" ${String(q) === state.progressQueue ? "selected" : ""}>${QUEUE_NAMES[q] ?? q}</option>`).join("");
}

async function loadProgress() {
  const params = accountParams();
  if (state.progressChampion) params.set("champion", state.progressChampion);
  if (state.progressQueue) params.set("queue", state.progressQueue);
  if (state.progressSide) params.set("side", state.progressSide);
  const [segments, sessionRows] = await Promise.all([
    getJSON(`/api/stats/progress?${params}`),
    getJSON("/api/sessions"),
  ]);
  // winrate in percentage points for delta display
  segments.forEach((s) => { s.winrate_pp = s.winrate == null ? null : 100 * s.winrate; });
  segmentUi.cache.clear(); // filters or data changed; refetch game lists on expand
  renderProgress(segments);
  renderSessions(sessionRows);
  // re-hydrate anything the user had expanded so panels don't stick on "Loading…"
  let rehydrated = false;
  for (const segment of segments) {
    const key = segKey(segment);
    if (segmentUi.expanded.has(key)) {
      await ensureSegmentMetrics(segment);
      rehydrated = true;
    }
    if (segmentUi.expandedGames.has(key)) {
      segmentUi.cache.set("games:" + key,
        await getJSON(`/api/stats/games?${progressFilterParams(segment)}`));
      rehydrated = true;
    }
  }
  if (rehydrated) renderProgress(segments);
}

function setMainView(view) {
  state.mainView = view;
  if (history.replaceState) {
    const hash = { matchups: "#matchups", progress: "#progress", trends: "#trends",
                   blocks: "#blocks", guide: "#guide", research: "#research",
                   macros: "#macros", tiers: "#tiers", calc: "#calc" }[view] || "#";
    history.replaceState(null, "", hash);
  }
  for (const v of ["overview", "matchups", "progress", "trends", "blocks", "guide", "research", "macros", "tiers", "calc", "settings"]) {
    $(`#nav-${v}`).classList.toggle("active", view === v);
    $(`#${v}-view`).classList.toggle("hidden", view !== v);
  }
  if (view === "matchups") initMatchups();
  if (view === "progress") loadProgressFilterOptions().then(loadProgress);
  if (view === "trends") initTrends();
  if (view === "blocks") initBlocks();
  if (view === "guide") initGuide();
  if (view === "research") initResearch();
  if (view === "macros") initMacros();
  if (view === "tiers") initTiers();
  if (view === "calc") initCalculator();
  if (view === "settings") initSettings();
}

// ---------- settings ----------

const settingsUi = { wired: false, accounts: [] };

// canonical Riot platform id -> human-readable server name
const PLATFORM_LABELS = {
  euw1: "EUW", eun1: "EUNE", tr1: "TR", ru: "RU",
  na1: "NA", br1: "BR", la1: "LAN", la2: "LAS",
  kr: "KR", jp1: "JP",
  oc1: "OCE", ph2: "PH", sg2: "SG", th2: "TH", tw2: "TW", vn2: "VN",
};
const PLATFORM_ORDER = ["euw1", "eun1", "na1", "kr", "br1", "la1", "la2",
                        "jp1", "ru", "tr1", "oc1", "ph2", "sg2", "th2", "tw2", "vn2"];

function renderAccountChips() {
  const box = $("#settings-accounts");
  box.querySelectorAll(".chip").forEach((chip) => chip.remove());
  const input = box.querySelector(".chip-input");
  input.insertAdjacentHTML("beforebegin", settingsUi.accounts.map((a) =>
    `<span class="chip chip-plain">${escapeHtml(a)}
       <button class="chip-x" data-account="${escapeHtml(a)}" title="Remove from the tracked list (on Save)"
         aria-label="Remove ${escapeHtml(a)}">×</button>
       <button class="chip-del" data-account="${escapeHtml(a)}"
         title="Delete this account and its crawled data from the database"
         aria-label="Delete ${escapeHtml(a)} from the database">🗑</button></span>`).join(""));
  box.querySelectorAll(".chip-x").forEach((btn) =>
    btn.addEventListener("click", () => {
      settingsUi.accounts = settingsUi.accounts.filter((a) => a !== btn.dataset.account);
      renderAccountChips();
    }));
  box.querySelectorAll(".chip-del").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const account = btn.dataset.account;
      if (!confirm(`Delete ${account} and all its crawled data (matches, coaching `
        + `metrics, runes, rank history) from the database?\n\nYour blocks, sessions and `
        + `notes are kept. You can re-add and re-crawl the account later.`)) return;
      const res = await fetch("/api/accounts", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account }),
      });
      const bodyj = await res.json().catch(() => ({}));
      if (!res.ok) {
        $("#settings-status").textContent = bodyj.detail || `error ${res.status}`;
        return;
      }
      settingsUi.accounts = bodyj.accounts || settingsUi.accounts.filter((a) => a !== account);
      renderAccountChips();
      $("#settings-status").textContent =
        `deleted ${account} — ${bodyj.players_deleted} player record(s) purged`;
      init(false); // stats/account tabs change now the data's gone
    }));
}

function rgbToHex(colorString) {
  const nums = colorString.match(/\d+/g);
  if (!nums) return colorString.trim();
  return "#" + nums.slice(0, 3).map((n) => (+n).toString(16).padStart(2, "0")).join("");
}

function applyAppearance(data) {
  if (data.ui_opacity !== undefined) {
    document.documentElement.style.setProperty("--ui-opacity", data.ui_opacity / 100);
  }
  if ("accent_color" in data) {
    if (data.accent_color) {
      document.documentElement.style.setProperty("--series-1", data.accent_color);
    } else {
      document.documentElement.style.removeProperty("--series-1");
    }
  }
  if ("background_image" in data) {
    const bg = $("#bg-image");
    if (data.background_image) {
      bg.style.backgroundImage = `url(/api/settings/background/file?v=${Date.now()})`;
      bg.classList.add("active");
    } else {
      bg.style.backgroundImage = "";
      bg.classList.remove("active");
    }
  }
}

function applyHiddenViews(hidden) {
  state.hiddenViews = hidden || [];
  for (const view of ["overview", "matchups", "progress", "trends", "blocks", "guide", "research", "macros", "tiers", "calc"]) {
    $(`#nav-${view}`).classList.toggle("hidden", state.hiddenViews.includes(view));
  }
  if (state.hiddenViews.includes(state.mainView)) {
    const fallback = ["overview", "matchups", "progress", "trends", "blocks", "guide", "research", "macros", "tiers", "calc"]
      .find((view) => !state.hiddenViews.includes(view));
    setMainView(fallback || "settings");
  }
}

// champion pool flattened to one priority-ordered list (main blind first,
// then core, then counters — pool order is user-set by dragging chips).
// Cached; blocks.js's savePool resets it.
async function poolChampionOrder() {
  if (state.poolOrder) return state.poolOrder;
  try {
    const pool = await getJSON("/api/pool");
    state.poolOrder = [...new Set([
      ...(pool.main_blind ? [pool.main_blind] : []), ...pool.core, ...pool.counter])];
  } catch {
    state.poolOrder = [];
  }
  return state.poolOrder;
}

// full-roster <select> options: the champion pool (in pool order) grouped on
// top, then everyone else alphabetically by display name
async function championOptions(selected, emptyLabel) {
  await loadChampionRoster(); // blocks.js — cached after the first call
  const pool = (await poolChampionOrder()).filter((c) => roster.nameById.has(c));
  const poolSet = new Set(pool);
  const rest = [...roster.nameById.keys()].filter((c) => !poolSet.has(c)).sort(
    (a, b) => champDisplay(a).localeCompare(champDisplay(b)));
  const opt = (c) =>
    `<option value="${c}" ${c === selected ? "selected" : ""}>${escapeHtml(champDisplay(c))}</option>`;
  const empty = emptyLabel === undefined ? "" : `<option value="">${emptyLabel}</option>`;
  if (!pool.length) return empty + rest.map(opt).join("");
  return empty
    + `<optgroup label="Champion Pool">${pool.map(opt).join("")}</optgroup>`
    + `<optgroup label="All champions">${rest.map(opt).join("")}</optgroup>`;
}

// legacy matchup notes (pre-champ-guide, my_champion='') — Settings offers to
// migrate them under one of your champions or delete them; the section only
// shows while such rows exist
async function refreshLegacySection() {
  const section = $("#legacy-notes-section");
  let info;
  try {
    info = await getJSON("/api/matchups/legacy-notes");
  } catch {
    return;
  }
  section.classList.toggle("hidden", !info.count);
  if (!info.count) return;
  $("#legacy-notes-summary").textContent =
    `${info.count} matchup note(s) from before the champ-guide update — ` +
    `${Object.keys(info.notes).map(displayName).join(", ")} — aren't tied to one of ` +
    `your champions, so they don't appear in the Matchup guide. Assign them to a ` +
    `champion, or delete them.`;
  const select = $("#legacy-migrate-champion");
  if (!select.options.length) {
    select.innerHTML = await championOptions((await poolChampionOrder())[0] || "");
  }
}

// ---------- comparison ("research") players (Settings) ----------
async function loadComparisonPlayers() {
  const list = $("#comparison-players-list");
  if (!list) return;
  await loadChampionRoster(); // champion grouping + the add/move champion inputs need it
  let data;
  try { data = await getJSON("/api/comparison-players"); }
  catch { list.innerHTML = ""; return; }
  renderComparisonPlayers(data.players || [], data.fetching || {});
  // a background fetch is running — poll until it finishes, updating counts
  const status = $("#comparison-status");
  if (data.fetching && data.fetching.running) {
    if (status) status.textContent = data.fetching.message || "fetching games…";
    clearTimeout(state.comparisonPoll);
    state.comparisonPoll = setTimeout(loadComparisonPlayers, 2500);
  } else if (data.fetching && data.fetching.error) {
    if (status) status.textContent = `fetch failed — ${data.fetching.error}`;
  } else if (data.fetching && data.fetching.message && data.fetching.message !== "idle") {
    if (status) status.textContent = data.fetching.message;
  }
}

// resolve a typed champion (display name or id) to its DDragon id via the shared
// roster (blocks.js); "" when blank, null when non-empty but unknown
function champIdFromText(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return "";
  return roster.byLookup.get(t) || null;
}

function renderComparisonPlayers(players, fetching = {}) {
  const list = $("#comparison-players-list");
  if (!list) return;
  const busy = Boolean(fetching.running);
  const playerRow = (p) => `
      <div class="comparison-player" data-puuid="${p.puuid}">
        <label class="comparison-enable" title="Show this player in the guide comparison">
          <input type="checkbox" class="cmp-enable" ${p.enabled ? "checked" : ""}></label>
        <span class="comparison-name">${escapeHtml(p.game_name)}<span class="muted">#${escapeHtml(p.tag_line)}</span></span>
        <span class="muted comparison-games">${p.platform ? (PLATFORM_LABELS[p.platform] || p.platform.toUpperCase()) + " · " : ""}${p.games} game${p.games === 1 ? "" : "s"}${busy && fetching.puuid === p.puuid ? " · fetching…" : ""}</span>
        <input class="chip-input cmp-champ" list="champ-list" style="max-width:9em"
          value="${p.champion ? escapeHtml(displayName(p.champion)) : ""}"
          placeholder="all champs" title="Which champion this player is for (blank = all)">
        <button class="preset cmp-more" type="button" ${busy ? "disabled" : ""}
          title="Fetch &amp; store more of this player's games (deeper history)">Fetch more</button>
        <button class="preset icon-btn cmp-remove" type="button" title="Remove">✕</button>
      </div>`;
  // group players by champion ('' = shown for all), named champions first
  const groups = new Map();
  for (const p of players) {
    const key = p.champion || "";
    (groups.get(key) || groups.set(key, []).get(key)).push(p);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    (a === "" ? 1 : b === "" ? -1 : displayName(a).localeCompare(displayName(b))));
  list.innerHTML = keys.length
    ? keys.map((key) => {
        const head = key
          ? `${champIcon(key)}${displayName(key)}`
          : `Any champion <span class="muted">— shown for every matchup</span>`;
        const ps = groups.get(key);
        return `<div class="cmp-group">
          <div class="cmp-group-head">${head} <span class="muted">(${ps.length})</span></div>
          ${ps.map(playerRow).join("")}</div>`;
      }).join("")
    : `<p class="muted">No research players yet — add one below and pick which champion it's for
        (blank = shown for every matchup).</p>`;
  $("#comparison-add-input").disabled = busy;
  $("#comparison-add").disabled = busy;
  list.querySelectorAll(".cmp-enable").forEach((cb) =>
    cb.addEventListener("change", () =>
      toggleComparisonPlayer(cb.closest(".comparison-player").dataset.puuid, cb.checked)));
  list.querySelectorAll(".cmp-more").forEach((btn) =>
    btn.addEventListener("click", () =>
      comparisonFetchMore(btn.closest(".comparison-player").dataset.puuid, btn)));
  list.querySelectorAll(".cmp-remove").forEach((btn) =>
    btn.addEventListener("click", () =>
      removeComparisonPlayer(btn.closest(".comparison-player").dataset.puuid)));
  list.querySelectorAll(".cmp-champ").forEach((inp) =>
    inp.addEventListener("change", () =>
      moveComparisonPlayer(inp.closest(".comparison-player").dataset.puuid, inp.value)));
}

async function addComparisonPlayer() {
  const input = $("#comparison-add-input");
  const riotId = input.value.trim();
  if (!riotId) return;
  const status = $("#comparison-status");
  const champText = $("#comparison-add-champion").value.trim();
  const champion = champIdFromText(champText);
  if (champion === null) { status.textContent = `unknown champion "${champText}"`; return; }
  status.textContent = `looking up ${riotId}…`;
  const res = await fetch("/api/comparison-players", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ riot_id: riotId, platform: $("#comparison-add-platform").value, champion }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    input.value = "";
    $("#comparison-add-champion").value = "";
    status.textContent = `added ${body.game_name}#${body.tag_line} — fetching games in the background…`;
    loadComparisonPlayers(); // picks up the running fetch and polls it
  } else {
    status.textContent = body.detail || `error ${res.status}`;
  }
}

async function moveComparisonPlayer(puuid, champText) {
  const status = $("#comparison-status");
  const champion = champIdFromText(champText);
  if (champion === null) { status.textContent = `unknown champion "${champText}"`; return; }
  const res = await fetch(`/api/comparison-players/${encodeURIComponent(puuid)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ champion }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    status.textContent = b.detail || `error ${res.status}`;
  }
  loadComparisonPlayers();
}

async function comparisonFetchMore(puuid, btn) {
  const status = $("#comparison-status");
  btn.disabled = true; btn.textContent = "fetching…";
  const res = await fetch(`/api/comparison-players/${encodeURIComponent(puuid)}/fetch-more`,
    { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) status.textContent = body.detail || `error ${res.status}`;
  loadComparisonPlayers(); // background fetch started — poll for progress
}

async function toggleComparisonPlayer(puuid, enabled) {
  await fetch(`/api/comparison-players/${encodeURIComponent(puuid)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

async function removeComparisonPlayer(puuid) {
  if (!confirm("Remove this comparison player? Their fetched games stay in the db.")) return;
  await fetch(`/api/comparison-players/${encodeURIComponent(puuid)}`, { method: "DELETE" });
  loadComparisonPlayers();
}

async function initSettings() {
  await loadChampionRoster(); // populates the shared #champ-list datalist
  const data = await getJSON("/api/settings");
  $("#setting-key").value = data.riot_api_key;
  const platforms = [...data.platforms].sort((a, b) =>
    PLATFORM_ORDER.indexOf(a) - PLATFORM_ORDER.indexOf(b));
  const platformOptions = (selected) => platforms.map((p) =>
    `<option value="${p}" ${p === selected ? "selected" : ""}>${PLATFORM_LABELS[p] || p.toUpperCase()}</option>`).join("");
  $("#setting-platform").innerHTML = platformOptions(data.platform);
  $("#comparison-add-platform").innerHTML = platformOptions(data.platform); // default to yours
  settingsUi.accounts = data.accounts;
  settingsUi.wasUnconfigured = !data.configured;
  renderAccountChips();
  document.querySelectorAll(".view-toggle-cb").forEach((cb) => {
    cb.checked = !(data.hidden_views || []).includes(cb.value);
  });
  $("#setting-auto-crawl").value = data.auto_crawl_hours;
  $("#setting-block-size").value = data.block_size;
  $("#setting-block-gap").value = data.block_gap_hours;
  $("#setting-block-gap-confirm").checked = Boolean(data.block_gap_confirm);
  $("#setting-block-series").checked = Boolean(data.block_series_enabled);
  $("#setting-date-format").value = data.date_format || "iso";
  $("#setting-main-role").innerHTML = roleSettingOptions(data.main_role || "");
  $("#setting-secondary-role").innerHTML = roleSettingOptions(data.secondary_role || "");
  $("#setting-runes-mode").value = data.runes_mode || "matchup";
  $("#setting-enable-comparison").checked = Boolean(data.enable_player_comparison);
  $("#comparison-card").classList.toggle("hidden", !data.enable_player_comparison);
  state.runesMode = data.runes_mode || "matchup";
  state.enableComparison = Boolean(data.enable_player_comparison);
  loadComparisonPlayers();
  loadProfiles();
  $("#setting-hide-rank").checked = Boolean(data.hide_my_rank);
  await loadChampionRoster(); // pool chips + legacy select need display names
  loadPool(); // blocks.js — hydrates the pool editor now hosted in Settings
  refreshLegacySection();
  $("#setting-accent-color").value = data.accent_color
    || rgbToHex(getComputedStyle(document.documentElement).getPropertyValue("--series-1"));
  $("#setting-accent-reset").classList.toggle("hidden", !data.accent_color);
  $("#setting-ui-opacity").value = data.ui_opacity;
  $("#setting-ui-opacity-value").textContent = `${data.ui_opacity}%`;
  $("#setting-bg-remove").classList.toggle("hidden", !data.background_image);
  applyAppearance(data);
  $("#settings-banner").classList.toggle("hidden", data.configured);
  if (settingsUi.wired) return;
  settingsUi.wired = true;
  $("#pool-save").addEventListener("click", savePool); // blocks.js
  wireChipBoxes(); // blocks.js — chip add/remove/drag inside #pool-card
  $("#setting-enable-comparison").addEventListener("change", (e) =>
    $("#comparison-card").classList.toggle("hidden", !e.target.checked));
  $("#comparison-add").addEventListener("click", addComparisonPlayer);
  $("#comparison-add-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addComparisonPlayer(); }
  });
  // ---- profiles manager (delegated) ----
  $("#profile-new").addEventListener("click", async () => {
    const name = $("#profile-new-name").value.trim();
    if (!name) return;
    const prof = await (await fetch("/api/profiles", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })).json();
    $("#profile-new-name").value = "";
    await loadProfiles();
    switchProfile(prof.id); // jump to the new (empty) profile so you can fill it
  });
  $("#profiles-list").addEventListener("click", async (e) => {
    const id = Number(e.target.dataset.id);
    if (e.target.classList.contains("profile-activate")) switchProfile(id);
    else if (e.target.classList.contains("profile-del")) {
      const p = state.profiles.find((x) => x.id === id);
      if (!confirm(`Delete profile "${p ? p.name : ""}" and its research players?`)) return;
      await fetch(`/api/profiles/${id}`, { method: "DELETE" });
      await loadProfiles();
      if (id === state.activeProfileId) location.reload();
    }
  });
  $("#profiles-list").addEventListener("change", (e) => {
    const id = Number(e.target.dataset.id);
    if (e.target.classList.contains("profile-role")) saveProfileField(id, { role: e.target.value });
    else if (e.target.classList.contains("profile-champ")) saveProfileField(id, { champion: e.target.value.trim() });
  });
  $("#import-all-btn").addEventListener("click", async () => {
    const status = $("#import-all-status");
    const file = $("#import-all-file").files[0];
    if (!file) { status.textContent = "choose a .zip file first"; return; }
    status.textContent = "checking…";
    const previewData = new FormData();
    previewData.append("file", file);
    const preview = await fetch("/api/import-all/preview", { method: "POST", body: previewData });
    const previewBody = await preview.json().catch(() => ({}));
    if (!preview.ok) {
      status.textContent = previewBody.detail || `error ${preview.status}`;
      return;
    }
    if (previewBody.conflicts.length) {
      status.textContent = `Can't import — would overwrite: ${previewBody.conflicts.slice(0, 5).join(", ")}` +
        `${previewBody.conflicts.length > 5 ? "…" : ""}`;
      return;
    }
    const c = previewBody.counts;
    const summary = [
      c.sessions && `${c.sessions} session(s)`, c.blocks && `${c.blocks} block(s)`,
      c.matchup_notes && `${c.matchup_notes} matchup guide(s)`,
      c.champion_notes && `${c.champion_notes} champion note(s)`,
      c.item_builds && `${c.item_builds} item build(s)`,
      c.research_entries && `${c.research_entries} research entr(y/ies)`,
      c.clips && `${c.clips} clip(s)`,
    ].filter(Boolean).join(", ");
    if (!confirm(`Import ${summary || "this backup"}?`)) { status.textContent = "cancelled"; return; }
    status.textContent = "importing…";
    const importData = new FormData();
    importData.append("file", file);
    const response = await fetch("/api/import-all", { method: "POST", body: importData });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      status.textContent = body.detail || `error ${response.status}`;
      return;
    }
    status.textContent = "imported ✓ — reloading…";
    setTimeout(() => location.reload(), 1000);
  });
  $("#setting-accent-color").addEventListener("input", (e) => {
    document.documentElement.style.setProperty("--series-1", e.target.value);
    $("#setting-accent-reset").classList.remove("hidden");
  });
  $("#setting-accent-reset").addEventListener("click", () => {
    document.documentElement.style.removeProperty("--series-1");
    $("#setting-accent-color").value =
      rgbToHex(getComputedStyle(document.documentElement).getPropertyValue("--series-1"));
    $("#setting-accent-reset").classList.add("hidden");
  });
  $("#setting-ui-opacity").addEventListener("input", (e) => {
    $("#setting-ui-opacity-value").textContent = `${e.target.value}%`;
    document.documentElement.style.setProperty("--ui-opacity", e.target.value / 100);
  });
  $("#setting-bg-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $("#setting-bg-status").textContent = "uploading…";
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/settings/background", { method: "POST", body: formData });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      $("#setting-bg-status").textContent = "saved ✓";
      $("#setting-bg-remove").classList.remove("hidden");
      applyAppearance({ background_image: true });
    } else {
      $("#setting-bg-status").textContent = body.detail || `error ${response.status}`;
    }
    e.target.value = "";
  });
  $("#setting-bg-remove").addEventListener("click", async () => {
    await fetch("/api/settings/background", { method: "DELETE" });
    $("#setting-bg-remove").classList.add("hidden");
    $("#setting-bg-status").textContent = "";
    applyAppearance({ background_image: false });
  });
  $("#legacy-migrate-btn").addEventListener("click", async () => {
    const champ = $("#legacy-migrate-champion").value;
    const status = $("#legacy-notes-status");
    if (!champ) { status.textContent = "pick a champion first"; return; }
    const response = await fetch("/api/matchups/legacy-notes/migrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ my_champion: champ }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      status.textContent = body.detail || `error ${response.status}`;
      return;
    }
    status.textContent = `Moved ${body.migrated} note(s) to ${displayName(champ)}`
      + (body.skipped.length
        ? ` — skipped ${body.skipped.map(displayName).join(", ")} (${displayName(champ)} already has a guide for them)`
        : "");
    $("#settings-status").textContent = status.textContent;
    refreshLegacySection();
  });
  $("#legacy-delete-btn").addEventListener("click", async () => {
    if (!confirm("Delete these older matchup notes for good? This cannot be undone.")) return;
    const response = await fetch("/api/matchups/legacy-notes", { method: "DELETE" });
    const body = await response.json().catch(() => ({}));
    $("#settings-status").textContent = `Deleted ${body.deleted ?? 0} older matchup note(s).`;
    refreshLegacySection();
  });
  $("#key-reveal").addEventListener("click", () => {
    const input = $("#setting-key");
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    $("#key-reveal").title = hidden ? "Hide key" : "Show key";
  });
  const input = $("#settings-accounts-input");
  const addAccount = () => {
    const value = input.value.trim();
    if (!value) return;
    if (!value.includes("#")) {
      $("#settings-status").textContent = "accounts must be Name#TAG";
      return;
    }
    if (!settingsUi.accounts.includes(value)) settingsUi.accounts.push(value);
    input.value = "";
    $("#settings-status").textContent = "";
    renderAccountChips();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addAccount();
    } else if (e.key === "Backspace" && !input.value) {
      settingsUi.accounts.pop();
      renderAccountChips();
    }
  });
  $("#settings-accounts").addEventListener("click", () => input.focus());
  $("#settings-save").addEventListener("click", async () => {
    addAccount(); // commit any half-typed account first
    const hiddenViews = [...document.querySelectorAll(".view-toggle-cb")]
      .filter((cb) => !cb.checked).map((cb) => cb.value);
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        riot_api_key: $("#setting-key").value,
        accounts: settingsUi.accounts,
        platform: $("#setting-platform").value,
        hidden_views: hiddenViews,
        auto_crawl_hours: Math.max(0, parseInt($("#setting-auto-crawl").value, 10) || 0),
        block_size: Math.max(1, parseInt($("#setting-block-size").value, 10) || 3),
        block_gap_hours: Math.min(168, Math.max(0, parseFloat($("#setting-block-gap").value) || 0)),
        block_gap_confirm: $("#setting-block-gap-confirm").checked,
        block_series_enabled: $("#setting-block-series").checked,
        date_format: $("#setting-date-format").value,
        main_role: $("#setting-main-role").value,
        secondary_role: $("#setting-secondary-role").value,
        runes_mode: $("#setting-runes-mode").value,
        enable_player_comparison: $("#setting-enable-comparison").checked,
        hide_my_rank: $("#setting-hide-rank").checked,
        ui_opacity: Math.min(100, Math.max(20, parseInt($("#setting-ui-opacity").value, 10) || 100)),
        accent_color: $("#setting-accent-reset").classList.contains("hidden")
          ? null : $("#setting-accent-color").value,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      if (Boolean(state.hideMyRank) !== Boolean(body.hide_my_rank)) {
        state.hideMyRank = body.hide_my_rank;
        init(false); // re-pull data so the redaction change applies everywhere
      }
      applyHiddenViews(body.hidden_views);
      applyAppearance(body);
      applyRoleSettings(body); // main/secondary role changed -> refilter
      refresh();
      if (state.dateFormat !== body.date_format) {
        state.dateFormat = body.date_format;
        refresh(); // re-render visible dates in the new format
      }
      const runesModeChanged = state.runesMode !== body.runes_mode;
      state.runesMode = body.runes_mode;
      state.enableComparison = Boolean(body.enable_player_comparison);
      $("#comparison-card").classList.toggle("hidden", !body.enable_player_comparison);
      if (runesModeChanged && typeof loadGuide === "function"
          && state.mainView === "guide") loadGuide();
      $("#settings-banner").classList.add("hidden");
      if (settingsUi.wasUnconfigured && body.configured) {
        settingsUi.wasUnconfigured = false;
        $("#settings-status").textContent = "saved ✓ — fetching your match history now…";
        startCrawl();
      } else {
        $("#settings-status").textContent = "saved ✓";
      }
    } else {
      $("#settings-status").textContent = body.detail || `error ${response.status}`;
    }
  });
}

function wireProgress() {
  $("#nav-overview").addEventListener("click", () => setMainView("overview"));
  $("#nav-matchups").addEventListener("click", () => setMainView("matchups"));
  $("#nav-progress").addEventListener("click", () => setMainView("progress"));
  $("#nav-trends").addEventListener("click", () => setMainView("trends"));
  $("#nav-blocks").addEventListener("click", () => setMainView("blocks"));
  $("#nav-guide").addEventListener("click", () => setMainView("guide"));
  $("#nav-research").addEventListener("click", () => setMainView("research"));
  $("#nav-macros").addEventListener("click", () => setMainView("macros"));
  $("#nav-tiers").addEventListener("click", () => setMainView("tiers"));
  $("#nav-calc").addEventListener("click", () => setMainView("calc"));
  $("#nav-settings").addEventListener("click", () => setMainView("settings"));
  $("#coaching-nudge").addEventListener("click", () => setMainView("progress"));
  $("#progress-champion").addEventListener("change", (e) => {
    state.progressChampion = e.target.value; loadProgress();
  });
  $("#progress-queue").addEventListener("change", (e) => {
    state.progressQueue = e.target.value; loadProgress();
  });
  $("#progress-side").addEventListener("change", (e) => {
    state.progressSide = e.target.value; loadProgress();
  });
  $("#session-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = $("#session-error");
    errorEl.textContent = "";
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: $("#session-date").value, title: $("#session-title").value }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      errorEl.textContent = body.detail || `error ${response.status}`;
      return;
    }
    $("#session-date").value = "";
    $("#session-title").value = "";
    loadProgress();
    refreshCoachingNudge();
  });
}

// ---------- patch notes ----------

async function ensureChangelog() {
  if (state.changelog) return;
  try {
    state.changelog = (await getJSON("changelog.json")).entries || [];
  } catch {
    state.changelog = [];
  }
}

async function openChangelog() {
  await ensureChangelog();
  const latestRelease = (localStorage.getItem("cp-latest-tag") || "").replace(/^v/, "");
  $("#changelog-body").innerHTML = state.changelog.map((entry) => {
    const unreleased = latestRelease && isNewerVersion(entry.version, latestRelease);
    return `<div class="changelog-entry">
      <h3>v${escapeHtml(entry.version)}
        <span class="muted">${escapeHtml(entry.date)}</span>
        ${unreleased ? `<span class="block-badge">not yet released</span>` : ""}</h3>
      <ul>${entry.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </div>`;
  }).join("") || `<p class="muted">No entries yet.</p>`;
  $("#changelog-overlay").classList.remove("hidden");
  if (state.changelog.length) {
    localStorage.setItem("cp-changelog-seen", state.changelog[0].version);
    $("#nav-changelog").classList.remove("has-news");
  }
}

function wireChangelog() {
  $("#nav-changelog").addEventListener("click", openChangelog);
  const overlay = $("#changelog-overlay");
  $("#changelog-close").addEventListener("click", () => overlay.classList.add("hidden"));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.add("hidden");
  });
  // dot on the icon while the newest entry hasn't been opened yet
  ensureChangelog().then(() => {
    const seen = localStorage.getItem("cp-changelog-seen");
    if (state.changelog.length && state.changelog[0].version !== seen) {
      $("#nav-changelog").classList.add("has-news");
    }
  });
}

// ---------- auto crawl ----------

const STARTUP_CRAWL_MIN_GAP_MS = 15 * 60 * 1000; // skip if we crawled minutes ago

async function startCrawl() {
  const status = await getJSON("/api/crawl/status");
  if (!status.running) await fetch("/api/crawl", { method: "POST" });
  pollCrawl();
}

function maybeStartupCrawl(settings) {
  if (!settings.configured) return;
  if (Date.now() - (settings.last_crawl_ms || 0) > STARTUP_CRAWL_MIN_GAP_MS) startCrawl();
}

async function autoCrawlTick() {
  const settings = await getJSON("/api/settings");
  if (!settings.configured || !settings.auto_crawl_hours) return;
  const due = (settings.last_crawl_ms || 0) + settings.auto_crawl_hours * 3_600_000;
  if (Date.now() > due) startCrawl();
}

// ---------- update check ----------

function isNewerVersion(candidate, current) {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

async function checkForUpdates() {
  try {
    const info = await getJSON("/api/version");
    $("#app-version").textContent = `v${info.version}`;
    if (info.version === "dev") return;
    let latest = localStorage.getItem("cp-latest-tag") || "";
    const lastCheck = +localStorage.getItem("cp-update-checked") || 0;
    if (Date.now() - lastCheck > 86_400_000) {  // at most one GitHub call per day
      const release = await getJSON(
        `https://api.github.com/repos/${info.repo}/releases/latest`);
      latest = release.tag_name || "";
      localStorage.setItem("cp-latest-tag", latest);
      localStorage.setItem("cp-update-checked", String(Date.now()));
    }
    const version = latest.replace(/^v/, "");
    if (version && isNewerVersion(version, info.version)) {
      const banner = $("#update-banner");
      banner.innerHTML = `⬆ <strong>Coach Potato v${escapeHtml(version)}</strong> is available —
        <a href="https://github.com/${info.repo}/releases/latest" target="_blank"
        rel="noopener">download the update</a> (you have v${escapeHtml(info.version)})`;
      banner.classList.remove("hidden");
    }
  } catch {
    // offline, rate-limited, or no releases published yet — stay quiet
  }
}

// ---------- crawl ----------

let crawlTimer = null;
let crawlPolls = 0;

async function refreshDuringCrawl() {
  // refresh data views as the crawl lands new games — but never a view
  // where the user might have half-finished input
  if (state.mainView === "settings") return;
  if (state.mainView === "blocks") {
    if (typeof blockState !== "undefined" &&
        blockState.editingNotes == null && blockState.editingLearnings == null) {
      await loadBlocks();
    }
    return;
  }
  await init(false);
  if (state.mainView === "matchups" && muState.editingNotes == null) await loadMatchups();
  else if (state.mainView === "progress") await loadProgress();
  else if (state.mainView === "trends") await loadTrends();
}

async function pollCrawl() {
  const status = await getJSON("/api/crawl/status");
  const el = $("#crawl-status");
  $("#crawl-btn").disabled = status.running;
  $("#crawl-indicator").classList.toggle("hidden", !status.running);
  if (status.running) {
    const explain = "Riot limits API requests to 100 per 2 minutes, so large " +
      "updates pause periodically and resume automatically. Progress so far: " +
      (status.message || "starting");
    const warn = $("#rate-warn");
    warn.classList.toggle("hidden", !status.rate_limited);
    warn.title = explain;
    warn.onclick = () => alert(explain);
    el.textContent = "";
    if (!crawlTimer) crawlTimer = setInterval(pollCrawl, 2000);
    if (++crawlPolls % 5 === 0) await refreshDuringCrawl();
  } else {
    if (crawlTimer) { clearInterval(crawlTimer); crawlTimer = null; }
    if (status.error) {
      el.textContent = `crawl failed: ${status.error}`;
    } else if (status.message === "done") {
      el.textContent = "up to date";
      await init(false);
      // refresh whichever view is active so new games appear immediately —
      // but never yank a half-written note out from under the user
      if (state.mainView === "matchups") {
        if (muState.editingNotes == null) await loadMatchups();
      } else if (state.mainView === "progress") {
        await loadProgress();
      } else if (state.mainView === "blocks") {
        if (blockState.editingNotes == null && blockState.editingLearnings == null) {
          await loadBlocks();
        }
      } else if (state.mainView === "trends") {
        await loadTrends();
      }
    } else {
      el.textContent = "";
    }
  }
}

// ---------- wiring ----------

function wireFilters() {
  document.querySelectorAll("#range-presets .preset").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll("#range-presets .preset").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.range = btn.dataset.range;
      $("#custom-dates").classList.toggle("hidden", state.range !== "custom");
      if (state.range !== "custom") refresh();
    }));
  $("#date-from").addEventListener("change", (e) => { state.from = e.target.value; refresh(); });
  $("#date-to").addEventListener("change", (e) => { state.to = e.target.value; refresh(); });
  $("#champion-select").addEventListener("change", (e) => { state.champion = e.target.value; refresh(); });
  $("#queue-select").addEventListener("change", (e) => { state.queue = e.target.value; refresh(); });
  $("#side-select").addEventListener("change", (e) => { state.side = e.target.value; refresh(); });
  $("#role-select").addEventListener("change", (e) => {
    state.roleFilter = e.target.value; syncRoleSelects(); refresh();
  });
  $("#profile-select").addEventListener("change", (e) => switchProfile(e.target.value));
  $("#rank-select").addEventListener("change", (e) => { state.rankTier = e.target.value; refresh(); });
  $("#min-games").addEventListener("change", (e) => { state.minGames = Math.max(1, +e.target.value || 1); refresh(); });
  // one picker for the whole progress table: base columns (default on) + metric
  // averages incl. lane deltas (default off). Expanded panels show all metrics.
  renderColPicker($("#progress-cols"), "cp-cols-progress",
    progressAllCols().map((c) => ({ key: c.key, label: c.label })),
    progressVisibleKeys(), () => renderProgress(segmentUi.segments));
  $("#crawl-btn").addEventListener("click", startCrawl);
  $("#champion-table-toggle").addEventListener("click", () => {
    const btn = $("#champion-table-toggle");
    const table = $("#champion-table");
    const expanded = table.classList.toggle("hidden") === false;
    btn.textContent = expanded ? "▾" : "▸";
    btn.setAttribute("aria-expanded", String(expanded));
  });
}

async function loadDdragonVersion() {
  try {
    const cached = localStorage.getItem("ddragon-version");
    const cachedList = localStorage.getItem("ddragon-versions");
    const cachedAt = +localStorage.getItem("ddragon-version-at") || 0;
    if (cached && cachedList && Date.now() - cachedAt < 86_400_000) {
      state.ddragonVersion = cached;
      state.ddragonVersions = JSON.parse(cachedList);
      return;
    }
    const versions = await getJSON("https://ddragon.leagueoflegends.com/api/versions.json");
    state.ddragonVersion = versions[0];
    state.ddragonVersions = versions.slice(0, 40); // recent patches, for the guide's patch picker
    localStorage.setItem("ddragon-version", versions[0]);
    localStorage.setItem("ddragon-versions", JSON.stringify(state.ddragonVersions));
    localStorage.setItem("ddragon-version-at", String(Date.now()));
  } catch {
    state.ddragonVersion = null; // icons silently disabled offline
    state.ddragonVersions = [];
  }
}

async function init(firstLoad = true) {
  state.players = await getJSON("/api/players");
  if (firstLoad) {
    await loadDdragonVersion();
    await ensureMetricsMeta(); // metric column pickers (wired below) need it
    loadLaneBaselines();       // matchup-relative lane grading (Blocks); async
    wireFilters();
    wireProgress();
    wireChangelog();
    pollCrawl();
    checkForUpdates();
    const settings = await getJSON("/api/settings");
    state.hideMyRank = settings.hide_my_rank;
    state.dateFormat = settings.date_format || "iso";
    state.runesMode = settings.runes_mode || "matchup";
    state.enableComparison = Boolean(settings.enable_player_comparison);
    applyRoleSettings(settings);
    await loadProfiles(true); // profile focus can override the role default
    applyHiddenViews(settings.hidden_views);
    applyAppearance(settings);
    renderCoachingNudge(settings);
    maybeStartupCrawl(settings);
    setInterval(autoCrawlTick, 10 * 60 * 1000);
  }
  if (!state.players.length) {
    $("#summary-tiles").innerHTML = `<div class="tile" style="min-width:100%">
      <div class="label">No match data yet</div>
      <div class="value" style="font-size:16px">Add your API key and accounts in
        <a href="#settings" id="goto-settings">Settings ⚙</a>, then press <strong>Update data</strong>.</div></div>`;
    const link = $("#goto-settings");
    if (link) link.addEventListener("click", (e) => { e.preventDefault(); setMainView("settings"); });
    if (firstLoad) {
      const settings = await getJSON("/api/settings");
      setMainView(settings.configured ? "overview" : "settings");
    }
    return;
  }
  if (state.accounts !== null) {
    // drop selections for accounts that no longer exist
    state.accounts = state.accounts.filter((p) =>
      state.players.some((q) => q.puuid === p));
    if (!state.accounts.length) state.accounts = null;
  }
  renderAccountSelector();
  // loadRuneTrees (guide.js) is idempotent — populates RUNE_TREES/SHARD_ROWS
  // for the recent-games rune icons on this Overview tab too, even if the
  // user never visits the Matchup guide tab
  await Promise.all([loadFilterOptions(), loadRuneTrees()]);
  await refresh();
  if (firstLoad && location.hash === "#matchups") setMainView("matchups");
  if (firstLoad && location.hash === "#progress") setMainView("progress");
  if (firstLoad && location.hash === "#trends") setMainView("trends");
  if (firstLoad && location.hash === "#blocks") setMainView("blocks");
  if (firstLoad && location.hash === "#guide") setMainView("guide");
  if (firstLoad && location.hash === "#research") setMainView("research");
  if (firstLoad && location.hash === "#macros") setMainView("macros");
  if (firstLoad && location.hash === "#tiers") setMainView("tiers");
  if (firstLoad && location.hash === "#calc") setMainView("calc");
  if (firstLoad && location.hash === "#settings") setMainView("settings");
}

init();
