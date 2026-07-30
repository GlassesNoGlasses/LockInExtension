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
    pauseDot: document.getElementById("pauseDot"),
    resumeDot: document.getElementById("resumeDot"),
    resumeBtn: document.getElementById("resumeBtn"),
    stopBtn: document.getElementById("stopBtn"),
    scopeRow: document.getElementById("scopeRow"),
    lastSession: document.getElementById("lastSession"),
    addForm: document.getElementById("addForm"),
    entryType: document.getElementById("entryType"),
    entryValue: document.getElementById("entryValue"),
    filterRow: document.getElementById("filterRow"),
    allowError: document.getElementById("allowError"),
    entryList: document.getElementById("entryList"),
    emptyState: document.getElementById("emptyState"),
  };

  /* The hand-written "nothing here yet" copy, kept so the "no matches" swap
     can put it back verbatim. */
  const EMPTY_TEXT = el.emptyState.textContent;
  const NO_MATCH_TEXT = "No matches";

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

  /* View state — popup-local, deliberately never persisted. `searchQuery` is
     written ONLY by real input events on #entryValue: the field is also
     pre-filled programmatically (prefillFromActiveTab), and that must not
     count as a search. Never re-derive it from el.entryValue.value. */
  let searchQuery = "";
  let typeFilter = null;
  let tagFilter = null;
  let tagScope = "white";

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
    renderFilters();
    renderAllowlist();
  }

  /* Mark exactly one member of a dot/chip group as chosen. `value` of null
     leaves every button off. */
  function paintGroup(buttons, attribute, value) {
    for (const node of buttons) {
      const on = node.dataset[attribute] === value;
      node.classList.toggle("is-on", on);
      node.setAttribute("aria-pressed", String(on));
    }
  }

  function renderScope() {
    paintGroup(el.scopeRow.querySelectorAll("button[data-scope]"), "scope", tagScope);
  }

  function renderFilters() {
    paintGroup(el.filterRow.querySelectorAll("button[data-type]"), "type", typeFilter);
    paintGroup(el.filterRow.querySelectorAll("button[data-tag]"), "tag", tagFilter);
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
    el.scopeRow.hidden = !idle;
    renderScope();
    el.pauseBtn.hidden = !active;
    // Pause/Resume carry the running session's scope colour (the session, not
    // the idle picker, is the source of truth once started).
    const sessionScope =
      session && L.TAG_SCOPES.indexOf(session.tagScope) !== -1 ? session.tagScope : "white";
    el.pauseDot.className = `btn-dot btn-dot--${sessionScope}`;
    el.resumeDot.className = `btn-dot btn-dot--${sessionScope}`;
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

  /* Search and both filter groups always apply together (AND). */
  function visibleEntries() {
    return L.filterEntries(state.allowlist, {
      query: searchQuery,
      type: typeFilter,
      tag: tagFilter,
    });
  }

  function renderAllowlist() {
    el.entryList.textContent = "";
    const visible = visibleEntries();
    for (const entry of visible) {
      el.entryList.appendChild(entry.id === editingId ? editRow(entry) : viewRow(entry));
    }

    // Empty because there is nothing, or empty because nothing matched?
    const empty = visible.length === 0;
    el.emptyState.textContent = state.allowlist.length === 0 ? EMPTY_TEXT : NO_MATCH_TEXT;
    el.emptyState.hidden = !empty;
  }

  function button(label, className, onClick) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    node.addEventListener("click", onClick);
    return node;
  }

  /* entry.tag comes back from storage, and older entries predate the field —
     trust nothing but a known colour. */
  function tagOf(entry) {
    const tag = entry ? entry.tag : null;
    return L.TAGS.indexOf(tag) === -1 ? null : tag;
  }

  function tagDot(color) {
    const node = document.createElement("span");
    node.className = `entry-dot entry-dot--${color}`;
    node.title = `Tagged ${color}`;
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

    const line = document.createElement("div");
    line.className = "entry-line";
    line.appendChild(value);
    const color = tagOf(entry);
    if (color) line.appendChild(tagDot(color));

    const tag = document.createElement("span");
    tag.className = "entry-tag";
    tag.textContent = entry.type;

    main.append(line, tag);

    const actions = document.createElement("div");
    actions.className = "entry-actions";
    actions.append(
      button("Edit", "btn btn--link", () => startEditing(entry.id)),
      button("Delete", "btn btn--link is-danger", () => deleteEntry(entry.id))
    );

    row.append(main, actions);
    return row;
  }

  /* Radio-style dot picker: None + the three colours. Owns its own selection
     so Cancel simply discards it. */
  function tagPicker(current) {
    const node = document.createElement("div");
    node.className = "tag-picker";

    const label = document.createElement("span");
    label.className = "tag-picker-label";
    label.textContent = "Tag";
    node.appendChild(label);

    let selected = current;
    const dots = [];

    const paint = () => {
      for (const dot of dots) {
        const on = (dot.dataset.tag || null) === selected;
        dot.classList.toggle("is-on", on);
        dot.setAttribute("aria-pressed", String(on));
      }
    };

    for (const color of [null].concat(L.TAGS)) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = color ? `dot dot--${color}` : "dot dot--none";
      if (color) dot.dataset.tag = color;
      dot.setAttribute("aria-label", color ? `Tag: ${color}` : "Tag: none");
      dot.title = color ? `Tag ${color}` : "No tag";
      dot.addEventListener("click", () => {
        selected = color;
        paint();
      });
      dots.push(dot);
      node.appendChild(dot);
    }

    paint();
    return { node, value: () => selected };
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

    const tags = tagPicker(tagOf(entry));

    const error = document.createElement("p");
    error.className = "error";
    error.hidden = true;

    const save = () => saveEdit(entry.id, type.value, value.value, tags.value(), error);
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

    row.append(fields, tags.node, error, actions);
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
    const message = { type: "START_SESSION", mode, tagScope };

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
    // Clearing the box programmatically also clears the search it was doubling as.
    el.entryValue.value = "";
    searchQuery = "";
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

  async function saveEdit(id, entryType, rawValue, tag, errorNode) {
    clearError(errorNode);
    const value = rawValue.trim();
    if (!value) {
      showError(errorNode, "Can't be empty");
      return;
    }

    // `tag` is always explicit — null clears it — so a value/type edit can
    // never quietly drop the colour.
    const response = await send({ type: "UPDATE_ENTRY", id, entryType, value, tag });
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

  /* The add box doubles as the search box. Only a real keystroke counts —
     prefillFromActiveTab() must never blank the list. */
  el.entryValue.addEventListener("input", () => {
    searchQuery = el.entryValue.value;
    renderAllowlist();
  });

  el.scopeRow.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-scope]") : null;
    if (!button) return;
    tagScope = button.dataset.scope;
    renderScope();
  });

  /* One selection per group, groups independent, and clicking the live option
     again switches that group's filter off. */
  el.filterRow.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest("[data-type],[data-tag]") : null;
    if (!button) return;
    if (button.dataset.type) {
      typeFilter = typeFilter === button.dataset.type ? null : button.dataset.type;
    } else {
      tagFilter = tagFilter === button.dataset.tag ? null : button.dataset.tag;
    }
    renderFilters();
    renderAllowlist();
  });

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
