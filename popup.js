
/* popup.js - logic for `popup.html`
 * All logic & states go through `background.js`.
*/

// startup
(() => {
  "use strict";

  const L = globalThis.LockInLib;
  const TICK_MS = 250;

  const byId = (id) => document.getElementById(id);

  const el = {
    statusPill: byId("statusPill"),
    timeReadout: byId("timeReadout"),
    timeLabel: byId("timeLabel"),
    modeRow: byId("modeRow"),
    durationRow: byId("durationRow"),
    hours: byId("hours"),
    minutes: byId("minutes"),
    sessionError: byId("sessionError"),
    startBtn: byId("startBtn"),
    scopeRow: byId("scopeRow"),
    pauseBtn: byId("pauseBtn"),
    pauseDot: byId("pauseDot"),
    resumeBtn: byId("resumeBtn"),
    resumeDot: byId("resumeDot"),
    stopBtn: byId("stopBtn"),
    lastSession: byId("lastSession"),
    addForm: byId("addForm"),
    entryType: byId("entryType"),
    entryValue: byId("entryValue"),
    filterRow: byId("filterRow"),
    allowError: byId("allowError"),
    entryList: byId("entryList"),
    emptyState: byId("emptyState"),
  };


  // the hand-written "nothing here yet" copy, kept so the "no matches" swap
  // can put it back verbatim
  const EMPTY_TEXT = el.emptyState.textContent;
  const NO_MATCH_TEXT = "No matches";

  const PILL_TEXT = {
    idle: "Idle",
    active: "Locked in",
    paused: "Paused",
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

  // popup states
  let state = { session: null, allowlist: [], lastSession: null };
  let editingId = null;
  let expiryPinged = false;

  // popup filters
  let searchQuery = "";
  let typeFilter = null;
  let tagFilter = null;
  let tagScope = "white";

  // --- Messaging

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

  // re-fetches and renders the popup
  async function refresh() {
    const response = await send({ type: "GET_STATE" });
    if (!response || !response.ok) return;
    state = {
      session: response.session || null,
      allowlist: Array.isArray(response.allowlist) ? response.allowlist : [],
      lastSession: response.lastSession || null,
    };
    render();
  }

  // state changes from messages on response
  function onResponse(response) {
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

  // every mutation answers the same way: no reply at all means the service
  // worker is gone (stay quiet), an error reply paints `errorNode`, a good
  // reply is adopted. `onSuccess` runs before that adopt because the view
  // state it touches (editingId, searchQuery) has to be right by the time
  // onResponse() re-renders
  async function mutate(message, errorNode, onSuccess) {
    const response = await send(message);
    if (!response) return;
    if (!response.ok) {
      showError(errorNode, errorText(response.error));
      return;
    }
    if (onSuccess) onSuccess();
    onResponse(response);
  }

  // --- Render

  function render() {
    renderSession();
    renderLastSession();
    renderFilters();
    renderAllowlist();
  }

  // marks an element with a tag
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
    // anything that is neither idle nor active is *styled* as paused
    const pill = idle ? "idle" : active ? "active" : "paused";

    el.statusPill.textContent = PILL_TEXT[pill];
    el.statusPill.className = `pill pill--${pill}`;
    el.timeLabel.textContent = statusLabel(session);

    el.modeRow.hidden = !idle;
    el.durationRow.hidden = !(idle && selectedMode() === "timer");

    el.startBtn.hidden = !idle;
    el.scopeRow.hidden = !idle;
    renderScope();
    el.pauseBtn.hidden = !active;
    el.resumeBtn.hidden = !paused;
    el.stopBtn.hidden = idle;

    // Pause/Resume carry the running session's scope colour (the session, not
    // the idle picker, is the source of truth once started)
    const sessionScope =
      session && L.TAG_SCOPES.includes(session.tagScope) ? session.tagScope : "white";
    el.pauseDot.className = `btn-dot btn-dot--${sessionScope}`;
    el.resumeDot.className = `btn-dot btn-dot--${sessionScope}`;

    renderTime();
  }

  // updates time on clock
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
    // search and both filter groups always apply together (AND)
    const visible = L.filterEntries(state.allowlist, {
      query: searchQuery,
      type: typeFilter,
      tag: tagFilter,
    });

    el.entryList.textContent = "";
    for (const entry of visible) {
      el.entryList.appendChild(entry.id === editingId ? editRow(entry) : viewRow(entry));
    }

    // empty because there is nothing, or empty because nothing matched?
    el.emptyState.textContent = state.allowlist.length === 0 ? EMPTY_TEXT : NO_MATCH_TEXT;
    el.emptyState.hidden = visible.length > 0;
  }

  function button(label, className, onClick) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    node.addEventListener("click", onClick);
    return node;
  }

  function tagOf(entry) {
    return L.TAGS.includes(entry.tag) ? entry.tag : null;
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

    const value = document.createElement("span");
    value.className = "entry-value";
    value.textContent = entry.value;
    value.title = entry.value;

    const line = document.createElement("div");
    line.className = "entry-line";
    line.appendChild(value);
    const color = tagOf(entry);
    if (color) line.appendChild(tagDot(color));

    const type = document.createElement("span");
    type.className = "entry-tag";
    type.textContent = entry.type;

    const main = document.createElement("div");
    main.className = "entry-main";
    main.append(line, type);

    const actions = document.createElement("div");
    actions.className = "entry-actions";
    actions.append(
      button("Edit", "btn btn--link", () => startEditing(entry.id)),
      button("Delete", "btn btn--link is-danger", () => deleteEntry(entry.id))
    );

    row.append(main, actions);
    return row;
  }

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

    for (const color of [null, ...L.TAGS]) {
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

    const type = document.createElement("select");
    type.add(new Option("Domain", "domain"));
    type.add(new Option("URL", "url"));
    type.value = entry.type;

    const value = document.createElement("input");
    value.type = "text";
    value.value = entry.value;
    value.spellcheck = false;
    value.autocomplete = "off";

    const fields = document.createElement("div");
    fields.className = "entry-edit";
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
    // deferred: the row is not in the document until the caller appends it
    queueMicrotask(() => value.focus());
    return row;
  }

  // --- Errors

  function showError(node, message) {
    node.textContent = message;
    node.hidden = false;
  }

  function clearError(node) {
    node.textContent = "";
    node.hidden = true;
  }

  // --- Session

  function start() {
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

    mutate(message, el.sessionError);
  }

  function transition(type) {
    clearError(el.sessionError);
    mutate({ type }, el.sessionError);
  }

  // --- Allowlist

  function addEntry(event) {
    event.preventDefault();
    clearError(el.allowError);

    const value = el.entryValue.value.trim();
    if (!value) {
      showError(el.allowError, "Type a domain or URL first");
      return;
    }

    mutate({ type: "ADD_ENTRY", entryType: el.entryType.value, value }, el.allowError, () => {
      // clearing the box programmatically also clears the search it was doubling as
      el.entryValue.value = "";
      searchQuery = "";
    });
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

  function saveEdit(id, entryType, rawValue, tag, errorNode) {
    clearError(errorNode);
    const value = rawValue.trim();
    if (!value) {
      showError(errorNode, "Can't be empty");
      return;
    }

    // `tag` is always explicit — null clears it — so a value/type edit can
    // never quietly drop the colour
    mutate({ type: "UPDATE_ENTRY", id, entryType, value, tag }, errorNode, () => {
      editingId = null;
    });
  }

  function deleteEntry(id) {
    clearError(el.allowError);
    mutate({ type: "DELETE_ENTRY", id }, el.allowError, () => {
      if (editingId === id) editingId = null;
    });
  }

  async function prefillFromActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && L.isBlockableUrl(tab.url) && !el.entryValue.value) {
        el.entryValue.value = tab.url;
      }
    } catch {
      console.error("Failed to prefill URL in popup")
    }
  }

  // --- Wiring

  // event.target can be a text node, so narrow it before closest()
  function closestButton(event, selector) {
    return event.target instanceof Element ? event.target.closest(selector) : null;
  }

  el.startBtn.addEventListener("click", start);
  el.pauseBtn.addEventListener("click", () => transition("PAUSE_SESSION"));
  el.resumeBtn.addEventListener("click", () => transition("RESUME_SESSION"));
  el.stopBtn.addEventListener("click", () => transition("STOP_SESSION"));
  el.addForm.addEventListener("submit", addEntry);

  el.entryValue.addEventListener("input", () => {
    searchQuery = el.entryValue.value;
    renderAllowlist();
  });

  el.scopeRow.addEventListener("click", (event) => {
    const chosen = closestButton(event, "[data-scope]");
    if (!chosen) return;
    tagScope = chosen.dataset.scope;
    renderScope();
  });

  el.filterRow.addEventListener("click", (event) => {
    const chosen = closestButton(event, "[data-type],[data-tag]");
    if (!chosen) return;
    if (chosen.dataset.type) {
      typeFilter = typeFilter === chosen.dataset.type ? null : chosen.dataset.type;
    } else {
      tagFilter = tagFilter === chosen.dataset.tag ? null : chosen.dataset.tag;
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
