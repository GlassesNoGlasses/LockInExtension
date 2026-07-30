/* Lock In — popup. Renders session state + allowlist CRUD.
   All mutations go through the service worker; storage.onChanged keeps the
   popup honest when something changes behind its back (timer expiry, a modal
   button in some other tab). */

(() => {
  "use strict";

  const L = globalThis.LockInLib;
  const TICK_MS = 250;

  const el = {
    statusPill: document.getElementById("statusPill"),
    timeReadout: document.getElementById("timeReadout"),
    timeLabel: document.getElementById("timeLabel"),
    modeRow: document.getElementById("modeRow"),
    durationRow: document.getElementById("durationRow"),
    hours: document.getElementById("hours"),
    minutes: document.getElementById("minutes"),
    sessionError: document.getElementById("sessionError"),
    startBtn: document.getElementById("startBtn"),
    pauseBtn: document.getElementById("pauseBtn"),
    resumeBtn: document.getElementById("resumeBtn"),
    stopBtn: document.getElementById("stopBtn"),
    lastSession: document.getElementById("lastSession"),
    addForm: document.getElementById("addForm"),
    entryType: document.getElementById("entryType"),
    entryValue: document.getElementById("entryValue"),
    allowError: document.getElementById("allowError"),
    entryList: document.getElementById("entryList"),
    emptyState: document.getElementById("emptyState"),
  };

  const ERROR_TEXT = {
    BUILTIN: 'Domain "google.com" cannot be blocked',
    DUPLICATE: "Already in your list",
    INVALID_VALUE: "That doesn't look like a valid domain/URL",
    INVALID_DURATION: "Timer must be between 1 minute and 24 hours",
    TOO_SHORT: "Timer must be at least 1 minute",
    TOO_LONG: "Timer can't be longer than 24 hours",
    INVALID: "Enter whole numbers for hours and minutes",
    ILLEGAL_TRANSITION: "Can't do that right now",
    NOT_FOUND: "That entry is already gone",
    NO_TAB: "Couldn't find that tab",
  };

  const REASON_TEXT = {
    manual: "you called it",
    timer_expired: "timer finished",
    all_tabs_closed: "all tabs closed",
    browser_restart: "browser restarted",
  };

  let state = { session: null, allowlist: [], lastSession: null };
  let editingId = null;
  let expiryPinged = false;

  /* --- messaging --- */

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  function errorText(code) {
    return ERROR_TEXT[code] || "Something went wrong";
  }

  async function refresh() {
    const response = await send({ type: "GET_STATE" });
    if (!response || !response.ok) return;
    state.session = response.session || null;
    state.allowlist = Array.isArray(response.allowlist) ? response.allowlist : [];
    state.lastSession = response.lastSession || null;
    render();
  }

  /* Mutations answer with the slice of state they changed; fall back to a
     full GET_STATE if a response carries no state at all. */
  function adopt(response) {
    let changed = false;
    if (response.session) {
      state.session = response.session;
      changed = true;
    }
    if (Array.isArray(response.allowlist)) {
      state.allowlist = response.allowlist;
      changed = true;
    }
    if ("lastSession" in response) {
      state.lastSession = response.lastSession || null;
      changed = true;
    }
    if (changed) render();
    else refresh();
  }

  /* --- render --- */

  function render() {
    renderSession();
    renderLastSession();
    renderAllowlist();
  }

  function selectedMode() {
    const checked = el.modeRow.querySelector("input[name=mode]:checked");
    return checked ? checked.value : "stopwatch";
  }

  function statusLabel(session) {
    if (!session || session.status === "idle") return "Ready when you are";
    const kind = session.mode === "timer" ? "Timer" : "Stopwatch";
    return session.status === "paused" ? `${kind} — paused, time frozen` : `${kind} — locked in`;
  }

  function renderSession() {
    const session = state.session;
    const status = session ? session.status : "idle";
    const idle = status === "idle";
    const active = status === "active";
    const paused = status === "paused";

    el.statusPill.textContent = idle ? "Idle" : active ? "Locked in" : "Paused";
    el.statusPill.className = `pill pill--${idle ? "idle" : active ? "active" : "paused"}`;
    el.timeLabel.textContent = statusLabel(session);

    el.modeRow.hidden = !idle;
    el.durationRow.hidden = !(idle && selectedMode() === "timer");

    el.startBtn.hidden = !idle;
    el.pauseBtn.hidden = !active;
    el.resumeBtn.hidden = !paused;
    el.stopBtn.hidden = idle;

    renderTime();
  }

  /* Called by the 250 ms ticker — must not do anything but paint the clock. */
  function renderTime() {
    const session = state.session;
    const now = Date.now();

    if (!session || session.status === "idle") {
      expiryPinged = false;
      el.timeReadout.textContent = L.formatClock(0);
      return;
    }

    if (session.mode === "timer") {
      const remaining = L.remainingMs(session, now);
      el.timeReadout.textContent = L.formatClock(remaining);
      // Locally expired: ask the SW to reconcile, once.
      if (session.status === "active" && remaining <= 0 && !expiryPinged) {
        expiryPinged = true;
        refresh();
      }
      return;
    }

    expiryPinged = false;
    el.timeReadout.textContent = L.formatClock(L.elapsedMs(session, now));
  }

  function renderLastSession() {
    const last = state.lastSession;
    if (!last) {
      el.lastSession.hidden = true;
      el.lastSession.textContent = "";
      return;
    }
    const reason = REASON_TEXT[last.reason] || "session ended";
    el.lastSession.textContent = `Locked in ${L.formatShort(last.elapsedMs)} — ${reason}`;
    el.lastSession.hidden = false;
  }

  function renderAllowlist() {
    el.entryList.textContent = "";
    for (const entry of state.allowlist) {
      el.entryList.appendChild(entry.id === editingId ? editRow(entry) : viewRow(entry));
    }
    el.emptyState.hidden = state.allowlist.length > 0;
  }

  function button(label, className, onClick) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    node.addEventListener("click", onClick);
    return node;
  }

  function viewRow(entry) {
    const row = document.createElement("li");
    row.className = "entry";

    const main = document.createElement("div");
    main.className = "entry-main";

    const value = document.createElement("span");
    value.className = "entry-value";
    value.textContent = entry.value;
    value.title = entry.value;

    const tag = document.createElement("span");
    tag.className = "entry-tag";
    tag.textContent = entry.type;

    main.append(value, tag);

    const actions = document.createElement("div");
    actions.className = "entry-actions";
    actions.append(
      button("Edit", "btn btn--link", () => startEditing(entry.id)),
      button("Delete", "btn btn--link is-danger", () => deleteEntry(entry.id))
    );

    row.append(main, actions);
    return row;
  }

  function editRow(entry) {
    const row = document.createElement("li");
    row.className = "entry entry--editing";

    const fields = document.createElement("div");
    fields.className = "entry-edit";

    const type = document.createElement("select");
    for (const option of ["domain", "url"]) {
      const node = document.createElement("option");
      node.value = option;
      node.textContent = option === "domain" ? "Domain" : "URL";
      type.appendChild(node);
    }
    type.value = entry.type;

    const value = document.createElement("input");
    value.type = "text";
    value.value = entry.value;
    value.spellcheck = false;
    value.autocomplete = "off";

    fields.append(type, value);

    const error = document.createElement("p");
    error.className = "error";
    error.hidden = true;

    const save = () => saveEdit(entry.id, type.value, value.value, error);
    value.addEventListener("keydown", (event) => {
      if (event.key === "Enter") save();
      if (event.key === "Escape") stopEditing();
    });

    const actions = document.createElement("div");
    actions.className = "entry-edit-actions";
    actions.append(
      button("Cancel", "btn btn--link", stopEditing),
      button("Save", "btn btn--link", save)
    );

    row.append(fields, error, actions);
    queueMicrotask(() => value.focus());
    return row;
  }

  /* --- errors --- */

  function showError(node, message) {
    node.textContent = message;
    node.hidden = false;
  }

  function clearError(node) {
    node.textContent = "";
    node.hidden = true;
  }

  /* --- session actions --- */

  async function start() {
    clearError(el.sessionError);
    const mode = selectedMode();
    const message = { type: "START_SESSION", mode };

    if (mode === "timer") {
      const parsed = L.parseDuration(el.hours.value, el.minutes.value);
      if (parsed.error) {
        showError(el.sessionError, errorText(parsed.error));
        return;
      }
      message.durationMs = parsed.ms;
    }

    const response = await send(message);
    if (!response) return;
    if (!response.ok) {
      showError(el.sessionError, errorText(response.error));
      return;
    }
    adopt(response);
  }

  async function transition(type) {
    clearError(el.sessionError);
    const response = await send({ type });
    if (!response) return;
    if (!response.ok) {
      showError(el.sessionError, errorText(response.error));
      return;
    }
    adopt(response);
  }

  /* --- allowlist actions --- */

  async function addEntry(event) {
    event.preventDefault();
    clearError(el.allowError);

    const value = el.entryValue.value.trim();
    if (!value) {
      showError(el.allowError, "Type a domain or URL first");
      return;
    }

    const response = await send({ type: "ADD_ENTRY", entryType: el.entryType.value, value });
    if (!response) return;
    if (!response.ok) {
      showError(el.allowError, errorText(response.error));
      return;
    }
    el.entryValue.value = "";
    adopt(response);
  }

  function startEditing(id) {
    editingId = id;
    clearError(el.allowError);
    renderAllowlist();
  }

  function stopEditing() {
    editingId = null;
    renderAllowlist();
  }

  async function saveEdit(id, entryType, rawValue, errorNode) {
    clearError(errorNode);
    const value = rawValue.trim();
    if (!value) {
      showError(errorNode, "Can't be empty");
      return;
    }

    const response = await send({ type: "UPDATE_ENTRY", id, entryType, value });
    if (!response) return;
    if (!response.ok) {
      showError(errorNode, errorText(response.error));
      return;
    }
    editingId = null;
    adopt(response);
  }

  async function deleteEntry(id) {
    clearError(el.allowError);
    const response = await send({ type: "DELETE_ENTRY", id });
    if (!response) return;
    if (!response.ok) {
      showError(el.allowError, errorText(response.error));
      return;
    }
    if (editingId === id) editingId = null;
    adopt(response);
  }

  /* Pre-fill the add box with the page the user is looking at right now. */
  async function prefillFromActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && L.isBlockableUrl(tab.url) && !el.entryValue.value) {
        el.entryValue.value = tab.url;
      }
    } catch {
      /* no active tab or no access — leave the field empty */
    }
  }

  /* --- wiring --- */

  el.startBtn.addEventListener("click", start);
  el.pauseBtn.addEventListener("click", () => transition("PAUSE_SESSION"));
  el.resumeBtn.addEventListener("click", () => transition("RESUME_SESSION"));
  el.stopBtn.addEventListener("click", () => transition("STOP_SESSION"));
  el.addForm.addEventListener("submit", addEntry);

  for (const radio of el.modeRow.querySelectorAll("input[name=mode]")) {
    radio.addEventListener("change", () => {
      clearError(el.sessionError);
      renderSession();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!(L.KEY_SESSION in changes) && !(L.KEY_ALLOWLIST in changes)) return;
    refresh();
  });

  setInterval(renderTime, TICK_MS);

  render();
  refresh();
  prefillFromActiveTab();
})();
