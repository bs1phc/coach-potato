"use strict";
/* Macros view: freeform title+notes sections for game-macro notes — not
   tied to any account, champion, matchup, or session. A simple flat,
   always-expanded list; sections append at the bottom in creation order.
   Uses globals from app.js: $, escapeHtml, renderNotes, getJSON. */

const macrosState = {
  sections: [],
  editing: null, // section id whose editor is open
  adding: false, // "+ Add section" form open
};

async function initMacros() {
  await loadMacros();
}

async function loadMacros() {
  macrosState.sections = await getJSON("/api/macros");
  renderMacros();
}

function macroAddFormHtml() {
  return `<div class="mu-notes">
    <label class="filter-label" for="macro-new-title">Title</label>
    <input type="text" id="macro-new-title" placeholder="e.g. Dragon soul timings">
    <label class="filter-label" for="macro-new-notes">Notes (Markdown)</label>
    <textarea id="macro-new-notes" rows="5" placeholder="Macro notes…"></textarea>
    <div class="session-actions">
      <button class="preset macro-add-save">Add section</button>
      <button class="preset macro-add-cancel">Cancel</button>
      <span class="muted macro-add-status"></span>
    </div>
  </div>`;
}

function macroSectionHtml(section) {
  if (macrosState.editing === section.id) {
    return `<div class="mu-notes" data-id="${section.id}">
      <label class="filter-label" for="macro-title-${section.id}">Title</label>
      <input type="text" id="macro-title-${section.id}" value="${escapeHtml(section.title)}">
      <label class="filter-label" for="macro-notes-${section.id}">Notes (Markdown)</label>
      <textarea id="macro-notes-${section.id}" rows="6">${escapeHtml(section.notes)}</textarea>
      <div class="session-actions">
        <button class="preset macro-save" data-id="${section.id}">Save</button>
        <button class="preset macro-cancel">Cancel</button>
        <span class="muted macro-status"></span>
      </div>
    </div>`;
  }
  return `<div class="mu-notes" data-id="${section.id}">
    <div class="mu-notes-head"><h4>${escapeHtml(section.title)}</h4>
      <button class="preset icon-btn macro-edit" data-id="${section.id}"
        title="Edit section" aria-label="Edit section">✎</button>
      <button class="preset icon-btn macro-delete" data-id="${section.id}"
        title="Delete section" aria-label="Delete section">🗑</button>
    </div>
    <div class="md-body">${section.notes ? renderNotes(section.notes) : `<p class="muted">No notes yet.</p>`}</div>
  </div>`;
}

function renderMacros() {
  const target = $("#macros-list");
  const sectionsHtml = macrosState.sections.length
    ? macrosState.sections.map(macroSectionHtml).join("")
    : `<div class="empty">No macro sections yet — add one below.</div>`;
  const addHtml = macrosState.adding
    ? macroAddFormHtml()
    : `<button type="button" class="preset macro-add-open">+ Add section</button>`;
  target.innerHTML = sectionsHtml + addHtml;
  wireMacrosHandlers(target);
}

function wireMacrosHandlers(target) {
  target.querySelectorAll(".macro-edit").forEach((btn) =>
    btn.addEventListener("click", () => {
      macrosState.editing = +btn.dataset.id;
      renderMacros();
    }));
  target.querySelectorAll(".macro-cancel").forEach((btn) =>
    btn.addEventListener("click", () => {
      macrosState.editing = null;
      renderMacros();
    }));
  target.querySelectorAll(".macro-save").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = +btn.dataset.id;
      const title = $(`#macro-title-${id}`).value.trim();
      const notes = $(`#macro-notes-${id}`).value;
      const status = btn.parentElement.querySelector(".macro-status");
      if (!title) { status.textContent = "title is required"; return; }
      const response = await fetch(`/api/macros/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, notes }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        status.textContent = body.detail || `error ${response.status}`;
        return;
      }
      macrosState.editing = null;
      await loadMacros();
    }));
  target.querySelectorAll(".macro-delete").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this macro section? This can't be undone.")) return;
      await fetch(`/api/macros/${btn.dataset.id}`, { method: "DELETE" });
      await loadMacros();
    }));
  target.querySelectorAll(".macro-add-open").forEach((btn) =>
    btn.addEventListener("click", () => {
      macrosState.adding = true;
      renderMacros();
    }));
  target.querySelectorAll(".macro-add-cancel").forEach((btn) =>
    btn.addEventListener("click", () => {
      macrosState.adding = false;
      renderMacros();
    }));
  target.querySelectorAll(".macro-add-save").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const title = $("#macro-new-title").value.trim();
      const notes = $("#macro-new-notes").value;
      const status = btn.parentElement.querySelector(".macro-add-status");
      if (!title) { status.textContent = "title is required"; return; }
      const response = await fetch("/api/macros", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, notes }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        status.textContent = body.detail || `error ${response.status}`;
        return;
      }
      macrosState.adding = false;
      await loadMacros();
    }));
}
