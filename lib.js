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

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

const MIN_DURATION_MS = MS_PER_MINUTE;
const MAX_DURATION_MS = 24 * MS_PER_HOUR;
const ALARM_TIMER_END = "lockin-timer-end";

function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// --- Tags ------------------------------------------------------------------

// white tags (null) -> all URLs/DOMs
const TAGS = Object.freeze(["red", "green", "blue"]);
const TAG_SCOPES = Object.freeze(["white", "red", "green", "blue"]);

// returns a tag or null
function normalizeTag(tag) {
  return TAGS.includes(tag) ? tag : null;
}

// returns a tag's scope, defaulting to "white" (all)
function normalizeTagScope(tagScope) {
  return TAG_SCOPES.includes(tagScope) ? tagScope : "white";
}

// --- URL / host helpers ----------------------------------------------------

const DEFAULT_PORTS = { "http:": "80", "https:": "443" };
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.\-]*:\/\//i;
const HAS_HTTP_SCHEME_RE = /^https?:\/\//i;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// normalizes a host; lowercase + trim + removing `www.`
function normalizeHost(host) {
  if (typeof host !== "string") return "";
  let h = host.trim().toLowerCase();
  const colon = h.indexOf(":");
  if (colon !== -1) h = h.slice(0, colon);
  h = h.replace(/\.+$/, "");
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

// Parse an http(s) URL
function parseUrl(raw) {
  if (typeof raw !== "string") return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch (_e) {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = normalizeHost(u.hostname);
  if (!host) return null;

  const scheme = u.protocol.slice(0, -1);
  const port = u.port === DEFAULT_PORTS[u.protocol] ? "" : u.port;
  // http(s) URLs always carry a path, so only the root keeps its slash.
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const query = u.search;
  const authority = port ? host + ":" + port : host;
  const normalized = scheme + "://" + authority + path + query;

  return { scheme, host, port, path, query, normalized };
}

// for content.js; returns True if website can be blocked (valid URL)
function isBlockableUrl(raw) {
  return parseUrl(raw) !== null;
}

// convers raw URL to actual URL
function toHttpUrl(raw, defaultScheme) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (!HAS_SCHEME_RE.test(trimmed)) return defaultScheme + "://" + trimmed;
  return HAS_HTTP_SCHEME_RE.test(trimmed) ? trimmed : "";
}

// checks and returns the domain of any URL
function normalizeDomainEntry(raw) {
  const parsed = parseUrl(toHttpUrl(raw, "http"));
  if (!parsed) return "";
  const host = parsed.host;
  if (host === "localhost") return host;
  const labels = host.split(".");
  if (labels.length < 2) return "";
  return labels.every((label) => LABEL_RE.test(label)) ? host : "";
}

// checks and returns the URL of any entry
function normalizeUrlEntry(raw) {
  const parsed = parseUrl(toHttpUrl(raw, "https"));
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
function isBuiltinHost(host) {
  return BUILTIN_DOMAINS.some((domain) => hostMatchesDomain(host, domain));
}

function isUrlAllowed(raw, allowlist, tagScope) {
  const parsed = parseUrl(raw);
  if (!parsed) return false;
  if (isBuiltinHost(parsed.host)) return true;
  if (!Array.isArray(allowlist)) return false;

  const scope = normalizeTagScope(tagScope);
  return allowlist.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (entry.tag != null && entry.tag !== scope) return false;
    if (entry.type === "domain") return hostMatchesDomain(parsed.host, entry.value);
    // parsed.normalized is never "", so an unusable entry value cannot match.
    if (entry.type === "url") return normalizeUrlEntry(entry.value) === parsed.normalized;
    return false;
  });
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
  return isBuiltinHost(type === "domain" ? value : parseUrl(value)?.host);
}

function asList(allowlist) {
  return Array.isArray(allowlist) ? allowlist : [];
}

// returns a new allowList entry
function hasDuplicate(list, type, value, exceptId) {
  return list.some(
    (e) =>
      e &&
      typeof e === "object" &&
      e.id !== exceptId &&
      e.type === type &&
      normalizeEntryValue(e.type, e.value) === value
  );
}

function makeEntry(type, rawValue, now, id) {
  const value = normalizeEntryValue(type, rawValue);
  if (!value) return { entry: null, error: "INVALID_VALUE" };
  if (matchesBuiltinDomain(type, value)) return { entry: null, error: "BUILTIN" };
  return {
    entry: {
      id: typeof id === "string" && id ? id : generateId(),
      type,
      value,
      createdAt: num(now, 0),
      tag: null,
    },
    error: null,
  };
}

function addEntry(allowlist, type, rawValue, now, id) {
  const list = asList(allowlist);
  const made = makeEntry(type, rawValue, now, id);
  if (made.error) return { allowlist: list, entry: null, error: made.error };
  if (hasDuplicate(list, made.entry.type, made.entry.value, null)) {
    return { allowlist: list, entry: null, error: "DUPLICATE" };
  }
  return { allowlist: list.concat([made.entry]), entry: made.entry, error: null };
}

// updates an entry in allowList
function updateEntry(allowlist, id, type, rawValue, now, tag) {
  const list = asList(allowlist);
  const fail = (error) => ({ allowlist: list, entry: null, error });

  const index = list.findIndex((e) => e && e.id === id);
  if (index === -1) return fail("NOT_FOUND");
  if (tag !== undefined && tag !== null && !TAGS.includes(tag)) return fail("INVALID_VALUE");

  const value = normalizeEntryValue(type, rawValue);
  if (!value) return fail("INVALID_VALUE");
  if (matchesBuiltinDomain(type, value)) return fail("BUILTIN");
  if (hasDuplicate(list, type, value, id)) return fail("DUPLICATE");

  const previous = list[index];
  const entry = {
    id: previous.id,
    type,
    value,
    createdAt: typeof previous.createdAt === "number" ? previous.createdAt : now,
    tag: normalizeTag(tag === undefined ? previous.tag : tag),
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
  const rank = (e) => (e && e.type === "url" ? 1 : 0);
  const value = (e) => (e && e.value) || "";
  return asList(allowlist)
    .slice()
    .sort((a, b) => {
      const byType = rank(a) - rank(b);
      if (byType !== 0) return byType;
      return value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0;
    });
}

// filters allowlist entries
function filterEntries(allowlist, filters) {
  const list = asList(allowlist);
  const f = filters && typeof filters === "object" ? filters : {};

  const query = typeof f.query === "string" ? f.query.trim().toLowerCase() : "";
  const type = f.type === "domain" || f.type === "url" ? f.type : null;
  const tag = normalizeTag(f.tag);
  // Unfiltered means unfiltered: junk entries are only dropped when narrowing.
  if (!query && !type && !tag) return list.slice();

  return list.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (type && entry.type !== type) return false;
    if (tag && entry.tag !== tag) return false;
    if (!query) return true;
    const value = typeof entry.value === "string" ? entry.value.toLowerCase() : "";
    return value.includes(query);
  });
}

// --- Session transitions (background.js)

const SESSION_STATUSES = ["idle", "active", "paused"];
const STOP_REASONS = ["manual", "timer_expired", "all_tabs_closed", "browser_restart"];

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

const IDLE_SESSION = Object.freeze(idleSession());

function coerceSession(session) {
  const usable = session && typeof session === "object" && SESSION_STATUSES.includes(session.status);
  return usable ? session : idleSession();
}

function isValidDuration(durationMs) {
  const ms = num(durationMs, null);
  return ms !== null && ms >= MIN_DURATION_MS && ms <= MAX_DURATION_MS;
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
  return {
    session: idleSession(),
    lastSession: {
      mode: s.mode,
      elapsedMs: elapsedMs(s, now),
      endedAt: num(now, 0),
      reason: STOP_REASONS.includes(reason) ? reason : "manual",
      // Flipped by the service worker once the user has seen the DONE badge.
      acknowledged: false,
    },
    error: null,
  };
}

// --- Duration

/** A non-negative integer; 0 for blank input, null for anything else. */
function toWholeNumber(input) {
  if (input === null || input === undefined || input === "") return 0;
  if (typeof input === "number") {
    return Number.isInteger(input) && input >= 0 ? input : null;
  }
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return 0;
  if (!/^\d+$/.test(trimmed)) return null;
  // A long enough run of digits still overflows to Infinity.
  return num(Number(trimmed), null);
}

// converts hours + minutes to miliseconds
function parseDuration(hours, minutes) {
  const h = toWholeNumber(hours);
  const m = toWholeNumber(minutes);
  if (h === null || m === null) return { ms: null, error: "INVALID" };
  const ms = h * MS_PER_HOUR + m * MS_PER_MINUTE;
  if (ms < MIN_DURATION_MS) return { ms: null, error: "TOO_SHORT" };
  if (ms > MAX_DURATION_MS) return { ms: null, error: "TOO_LONG" };
  return { ms, error: null };
}

// --- Formatting

/** Whole hours/minutes/seconds in `ms`, clamped at zero. */
function splitDuration(ms) {
  const total = Math.floor(Math.max(0, num(ms, 0)) / 1000);
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

function pad2(n) { // pad for display
  return n < 10 ? "0" + n : String(n);
}

// "HH:MM:SS" for the popup clock
function formatClock(ms) {
  const { hours, minutes, seconds } = splitDuration(ms);
  return pad2(hours) + ":" + pad2(minutes) + ":" + pad2(seconds);
}

// "2h 2m" / "1m 3s" / "45s" for notifications and summaries
function formatShort(ms) {
  const { hours, minutes, seconds } = splitDuration(ms);
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
