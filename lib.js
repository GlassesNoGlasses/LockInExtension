"use strict";

/**
 * lib.js — main library for extension.
 * Imported by `content.js`, `background.js`, and `popup.js`.
 */

// --- Storage keys 

const KEY_ALLOWLIST = "lockin.allowlist";
const KEY_SESSION = "lockin.session";
const KEY_LAST = "lockin.lastSession";
const KEY_HEARTBEAT = "lockin.heartbeat";

// --- Session constants

const MIN_DURATION_MS = 60 * 1000; // 1 minute
const MAX_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const ALARM_TIMER_END = "lockin-timer-end";

// --- URL/DOM Tags 

// white tags (null) -> all URLs/DOMs
const TAGS = Object.freeze(["red", "green", "blue"]);
const TAG_SCOPES = Object.freeze(["white", "red", "green", "blue"]);

// returns a tag or null
function normalizeTag(tag) {
  return TAGS.indexOf(tag) === -1 ? null : tag;
}

// returns a tag's scope, defaulting to "white" (all)
function normalizeTagScope(tagScope) {
  return TAG_SCOPES.indexOf(tagScope) === -1 ? "white" : tagScope;
}

const IDLE_SESSION = Object.freeze({
  status: "idle",
  mode: null,
  startedAt: null,
  accumulatedMs: 0,
  durationMs: null,
  tagScope: null,
});

const DEFAULT_PORTS = { "http:": "80", "https:": "443" }; // for URLs

// --- URL / host helpers

// normalizes a host; lowercase + trim + removing `www.`
function normalizeHost(host) {
  if (typeof host !== "string") return "";
  let h = host.trim().toLowerCase();
  if (!h) return "";
  // Strip an accidental port.
  const colon = h.indexOf(":");
  if (colon !== -1) h = h.slice(0, colon);
  // Strip trailing dots (FQDN form).
  h = h.replace(/\.+$/, "");
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

// Parse an http(s) URL
function parseUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u;
  try {
    u = new URL(trimmed);
  } catch (e) {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = normalizeHost(u.hostname);
  if (!host) return null;

  let port = u.port || "";
  if (port && port === DEFAULT_PORTS[u.protocol]) port = "";

  let path = u.pathname || "/";
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (!path) path = "/";

  const scheme = u.protocol.slice(0, -1);
  const query = u.search || "";
  const authority = port ? host + ":" + port : host;
  const normalized = scheme + "://" + authority + path + query;

  return { scheme, host, port, path, query, normalized };
}

// for content.js; returns True if website can be blocked (valid URL)
function isBlockableUrl(raw) {
  return parseUrl(raw) !== null;
}

const HAS_SCHEME_RE = /^[a-z][a-z0-9+.\-]*:\/\//i; // follows URL schem `://`
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/; // looks like a domain

// checks and returns the domain of any URL
function normalizeDomainEntry(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (HAS_SCHEME_RE.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return "";

  const candidate = HAS_SCHEME_RE.test(trimmed) ? trimmed : "http://" + trimmed;
  let u;
  try {
    u = new URL(candidate);
  } catch (e) {
    return "";
  }
  const host = normalizeHost(u.hostname);
  if (!host) return "";
  if (host === "localhost") return host;

  const labels = host.split(".");
  if (labels.length < 2) return "";
  for (const label of labels) {
    if (!LABEL_RE.test(label)) return "";
  }
  return host;
}

// checks and returns the URL of any entry
function normalizeUrlEntry(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (HAS_SCHEME_RE.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return "";
  const candidate = HAS_SCHEME_RE.test(trimmed) ? trimmed : "https://" + trimmed;
  const parsed = parseUrl(candidate);
  return parsed ? parsed.normalized : "";
}

// returns if a host URL matches a domain
function hostMatchesDomain(host, domain) {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith("." + d);
}

// domains that are always allowed
const BUILTIN_DOMAINS = Object.freeze(["google.com"]);

// checks if a URL is allowed and fits the start tag
function isUrlAllowed(raw, allowlist, tagScope) {
  const parsed = parseUrl(raw);
  if (!parsed) return false;
  for (const domain of BUILTIN_DOMAINS) {
    if (hostMatchesDomain(parsed.host, domain)) return true;
  }
  if (!Array.isArray(allowlist)) return false;
  const scope = normalizeTagScope(tagScope);

  for (const entry of allowlist) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.tag != null && entry.tag !== scope) continue;
    if (entry.type === "domain") {
      if (hostMatchesDomain(parsed.host, entry.value)) return true;
    } else if (entry.type === "url") {
      const value = normalizeUrlEntry(entry.value);
      if (value && value === parsed.normalized) return true;
    }
  }
  return false;
}

// --- Allowlist CRUD

let idCounter = 0;

function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID(); // use crypto where possible
  }
  idCounter += 1;
  return "e" + idCounter + "-" + Math.random().toString(36).slice(2);
}

function normalizeEntryValue(type, rawValue) {
  if (type === "domain") return normalizeDomainEntry(rawValue);
  else if (type === "url") return normalizeUrlEntry(rawValue);
  return "";
}

// returns True if a URL matches a built-in domain; we reject
function matchesBuiltinDomain(type, value) {
  const host = type === "domain" ? value : (parseUrl(value) || {}).host;
  if (!host) return false;
  return BUILTIN_DOMAINS.some((domain) => hostMatchesDomain(host, domain));
}

function asList(allowlist) {
  return Array.isArray(allowlist) ? allowlist : [];
}

// returns a new allowList entry
function makeEntry(type, rawValue, now, id) {
  const value = normalizeEntryValue(type, rawValue);
  if (!value) return { entry: null, error: "INVALID_VALUE" };
  if (matchesBuiltinDomain(type, value)) return { entry: null, error: "BUILTIN" };
  return {
    entry: {
      id: typeof id === "string" && id ? id : generateId(),
      type,
      value,
      createdAt: typeof now === "number" && isFinite(now) ? now : 0,
      tag: null,
    },
    error: null,
  };
}

function findDuplicate(list, type, value, exceptId) {
  return list.some(
    (e) =>
      e &&
      typeof e === "object" &&
      e.id !== exceptId &&
      e.type === type &&
      normalizeEntryValue(e.type, e.value) === value
  );
}

// adds a new entry to allowList
function addEntry(allowlist, type, rawValue, now, id) {
  const list = asList(allowlist);
  const made = makeEntry(type, rawValue, now, id);
  if (made.error) return { allowlist: list, entry: null, error: made.error };
  if (findDuplicate(list, made.entry.type, made.entry.value, null)) {
    return { allowlist: list, entry: null, error: "DUPLICATE" };
  }
  return { allowlist: list.concat([made.entry]), entry: made.entry, error: null };
}

// updates an entry in allowList
function updateEntry(allowlist, id, type, rawValue, now, tag) {
  const list = asList(allowlist);
  const index = list.findIndex((e) => e && e.id === id);
  if (index === -1) return { allowlist: list, entry: null, error: "NOT_FOUND" };

  const previous = list[index];
  let nextTag;
  if (tag === undefined) nextTag = normalizeTag(previous.tag);
  else if (tag === null) nextTag = null;
  else if (TAGS.indexOf(tag) !== -1) nextTag = tag;
  else return { allowlist: list, entry: null, error: "INVALID_VALUE" };

  const value = normalizeEntryValue(type, rawValue);
  if (!value) return { allowlist: list, entry: null, error: "INVALID_VALUE" };
  if (matchesBuiltinDomain(type, value)) {
    return { allowlist: list, entry: null, error: "BUILTIN" };
  }
  if (findDuplicate(list, type, value, id)) {
    return { allowlist: list, entry: null, error: "DUPLICATE" };
  }

  const entry = {
    id: previous.id,
    type,
    value,
    createdAt: typeof previous.createdAt === "number" ? previous.createdAt : now,
    tag: nextTag,
  };
  const next = list.slice();
  next[index] = entry;
  return { allowlist: next, entry, error: null };
}

// deletes an entry in allowList
function deleteEntry(allowlist, id) {
  const list = asList(allowlist);
  const index = list.findIndex((e) => e && e.id === id);
  if (index === -1) return { allowlist: list, error: "NOT_FOUND" };
  const next = list.slice();
  next.splice(index, 1);
  return { allowlist: next, error: null };
}

// sorts the allow list by domain, then URL by chars
function sortAllowlist(allowlist) {
  return asList(allowlist)
    .slice()
    .sort((a, b) => {
      const at = a && a.type === "url" ? 1 : 0;
      const bt = b && b.type === "url" ? 1 : 0;
      if (at !== bt) return at - bt;
      const av = (a && a.value) || "";
      const bv = (b && b.value) || "";
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
}

// filters allowlist entries
function filterEntries(allowlist, filters) {
  const list = asList(allowlist);
  const f = filters && typeof filters === "object" ? filters : {};

  const query = typeof f.query === "string" ? f.query.trim().toLowerCase() : "";
  const type = f.type === "domain" || f.type === "url" ? f.type : null;
  const tag = normalizeTag(f.tag);
  if (!query && !type && !tag) return list.slice();

  return list.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (type && entry.type !== type) return false;
    if (tag && entry.tag !== tag) return false;
    if (query) {
      const value = typeof entry.value === "string" ? entry.value.toLowerCase() : "";
      if (value.indexOf(query) === -1) return false;
    }
    return true;
  });
}

// --- Session transitions (background.js)

const VALID_REASONS = ["manual", "timer_expired", "all_tabs_closed", "browser_restart"];

function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// returns the idle session
function idleSession() {
  return {
    status: "idle",
    mode: null,
    startedAt: null,
    accumulatedMs: 0,
    durationMs: null,
    tagScope: null,
  };
}

// returns the session if it is structurally usable, otherwise a fresh idle one
function verifySession(session) {
  if (
    session &&
    typeof session === "object" &&
    (session.status === "idle" || session.status === "active" || session.status === "paused")
  ) {
    return session;
  }
  return idleSession();
}

function isValidDuration(durationMs) {
  return (
    typeof durationMs === "number" &&
    Number.isFinite(durationMs) &&
    durationMs >= MIN_DURATION_MS &&
    durationMs <= MAX_DURATION_MS
  );
}

// milliseconds of session banked so far
function elapsedMs(session, now) {
  const s = verifySession(session);
  const banked = Math.max(0, num(s.accumulatedMs, 0));
  if (s.status !== "active") return banked;
  const startedAt = num(s.startedAt, null);
  if (startedAt === null) return banked;
  return banked + Math.max(0, num(now, startedAt) - startedAt);
}

// milliseconds left on a timer, clamped at 0. Returns null if not timer
function remainingMs(session, now) {
  const s = verifySession(session);
  if (s.mode !== "timer") return null;
  const duration = num(s.durationMs, null);
  if (duration === null) return null;
  return Math.max(0, duration - elapsedMs(s, now));
}

// returns when a timer should end
function computeEndsAt(session) {
  const s = verifySession(session);
  if (s.status !== "active" || s.mode !== "timer") return null;
  const duration = num(s.durationMs, null);
  const startedAt = num(s.startedAt, null);
  if (duration === null || startedAt === null) return null;
  return startedAt + Math.max(0, duration - Math.max(0, num(s.accumulatedMs, 0)));
}

// returns True when a running timer has reached its duration
function isExpired(session, now) {
  const s = verifySession(session);
  if (s.status !== "active" || s.mode !== "timer") return false;
  const duration = num(s.durationMs, null);
  if (duration === null) return false;
  return elapsedMs(s, now) >= duration;
}

// content.js check if a URL should be blocked
function isBlockingActive(session) {
  return !!session && typeof session === "object" && session.status === "active";
}

// returns a new session, with default values (tag = white)
function startSession(session, now, mode, durationMs, tagScope) {
  const s = verifySession(session);
  if (s.status !== "idle") return { session: s, error: "ILLEGAL_TRANSITION" };
  if (mode !== "stopwatch" && mode !== "timer") return { session: s, error: "INVALID_VALUE" };
  if (mode === "timer" && !isValidDuration(durationMs)) {
    return { session: s, error: "INVALID_DURATION" };
  }
  return {
    session: {
      status: "active",
      mode,
      startedAt: num(now, 0),
      accumulatedMs: 0,
      durationMs: mode === "timer" ? durationMs : null,
      tagScope: normalizeTagScope(tagScope),
    },
    error: null,
  };
}

// active -> paused
function pauseSession(session, now) {
  const s = verifySession(session);
  if (s.status !== "active") return { session: s, error: "ILLEGAL_TRANSITION" };
  return {
    session: {
      status: "paused",
      mode: s.mode,
      startedAt: null,
      accumulatedMs: elapsedMs(s, now),
      durationMs: num(s.durationMs, null),
      tagScope: normalizeTagScope(s.tagScope),
    },
    error: null,
  };
}

// paused -> active
function resumeSession(session, now) {
  const s = verifySession(session);
  if (s.status !== "paused") return { session: s, error: "ILLEGAL_TRANSITION" };
  return {
    session: {
      status: "active",
      mode: s.mode,
      startedAt: num(now, 0),
      accumulatedMs: Math.max(0, num(s.accumulatedMs, 0)),
      durationMs: num(s.durationMs, null),
      tagScope: normalizeTagScope(s.tagScope),
    },
    error: null,
  };
}

// stops and ends a session
function stopSession(session, now, reason) {
  const s = verifySession(session);
  if (s.status === "idle") {
    return { session: s, lastSession: null, error: "ILLEGAL_TRANSITION" };
  }
  const finalReason = VALID_REASONS.indexOf(reason) === -1 ? "manual" : reason;
  return {
    session: idleSession(),
    lastSession: {
      mode: s.mode,
      elapsedMs: elapsedMs(s, now),
      endedAt: num(now, 0),
      reason: finalReason,
      // Flipped by the service worker once the user has seen the DONE badge.
      acknowledged: false,
    },
    error: null,
  };
}

// --- Duration

function toWholeNumber(input) {
  if (input === null || input === undefined || input === "") return 0;
  if (typeof input === "number") {
    return Number.isFinite(input) && Number.isInteger(input) && input >= 0 ? input : null;
  }
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return 0;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// converts hours + minutes to miliseconds
function parseDuration(hours, minutes) {
  const h = toWholeNumber(hours);
  const m = toWholeNumber(minutes);
  if (h === null || m === null) return { ms: null, error: "INVALID" };
  const ms = h * 3600000 + m * 60000;
  if (ms < MIN_DURATION_MS) return { ms: null, error: "TOO_SHORT" };
  if (ms > MAX_DURATION_MS) return { ms: null, error: "TOO_LONG" };
  return { ms, error: null };
}

// --- Formatting

function clampMs(ms) { // clamp ms to min(0)
  const n = num(ms, 0);
  return n > 0 ? n : 0;
}

function pad2(n) { // pad for display
  return n < 10 ? "0" + n : String(n);
}

// "HH:MM:SS" for the popup clock
function formatClock(ms) {
  const total = Math.floor(clampMs(ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return pad2(hours) + ":" + pad2(minutes) + ":" + pad2(seconds);
}

// "2h 2m" / "1m 3s" / "45s" for notifications and summaries
function formatShort(ms) {
  const total = Math.floor(clampMs(ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return hours + "h " + minutes + "m";
  if (minutes > 0) return minutes + "m " + seconds + "s";
  return seconds + "s";
}

// --- Exports -----

const LockInLib = {
  KEY_ALLOWLIST,
  KEY_SESSION,
  KEY_LAST,
  KEY_HEARTBEAT,
  MIN_DURATION_MS,
  MAX_DURATION_MS,
  ALARM_TIMER_END,
  IDLE_SESSION,
  TAGS,
  TAG_SCOPES,
  BUILTIN_DOMAINS,
  normalizeHost,
  parseUrl,
  isBlockableUrl,
  normalizeDomainEntry,
  normalizeUrlEntry,
  hostMatchesDomain,
  isUrlAllowed,
  makeEntry,
  addEntry,
  updateEntry,
  deleteEntry,
  sortAllowlist,
  filterEntries,
  idleSession,
  startSession,
  pauseSession,
  resumeSession,
  stopSession,
  elapsedMs,
  remainingMs,
  computeEndsAt,
  isExpired,
  isBlockingActive,
  parseDuration,
  formatClock,
  formatShort,
};

if (typeof globalThis !== "undefined") globalThis.LockInLib = LockInLib;
if (typeof module !== "undefined" && module.exports) module.exports = LockInLib;
