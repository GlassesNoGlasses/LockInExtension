"use strict";

/**
 * lib.js — pure logic for the Lock In extension.
 *
 * Rules for this file (enforced by tests / review):
 *  - Zero extension-API usage (no `chrome` namespace at all). It is loaded by
 *    the service worker (importScripts), the popup, the content script and
 *    node:test alike.
 *  - Every function is total: junk input never throws.
 *  - No ambient clock reads; callers pass `now` so tests are deterministic.
 */

// --- Storage keys ----------------------------------------------------------

const KEY_ALLOWLIST = "lockin.allowlist";
const KEY_SESSION = "lockin.session";
const KEY_LAST = "lockin.lastSession";
const KEY_HEARTBEAT = "lockin.heartbeat";

// --- Session constants -----------------------------------------------------

const MIN_DURATION_MS = 60 * 1000; // 1 minute
const MAX_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const ALARM_TIMER_END = "lockin-timer-end";

const IDLE_SESSION = Object.freeze({
  status: "idle",
  mode: null,
  startedAt: null,
  accumulatedMs: 0,
  durationMs: null,
});

const DEFAULT_PORTS = { "http:": "80", "https:": "443" };

// --- URL / host helpers ----------------------------------------------------

/**
 * Normalize a bare hostname: lowercase, trimmed, no trailing dot, no port,
 * no leading "www.". Returns "" for anything unusable.
 */
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

/**
 * Parse an http(s) URL into its normalized parts.
 * @returns {null|{scheme:string,host:string,port:string,path:string,query:string,normalized:string}}
 */
function parseUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u;
  try {
    u = new URL(trimmed);
  } catch (_e) {
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

/** True when the URL is one a content script could actually run on. */
function isBlockableUrl(raw) {
  return parseUrl(raw) !== null;
}

const HAS_SCHEME_RE = /^[a-z][a-z0-9+.\-]*:\/\//i;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Normalize a user-supplied domain entry ("YouTube.com/feed" -> "youtube.com").
 * Returns "" when the input is not a plausible hostname.
 */
function normalizeDomainEntry(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (HAS_SCHEME_RE.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return "";

  const candidate = HAS_SCHEME_RE.test(trimmed) ? trimmed : "http://" + trimmed;
  let u;
  try {
    u = new URL(candidate);
  } catch (_e) {
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

/**
 * Normalize a user-supplied URL entry. Scheme-less input is assumed https.
 * Returns "" when the input is not a usable http(s) URL.
 */
function normalizeUrlEntry(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (HAS_SCHEME_RE.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return "";
  const candidate = HAS_SCHEME_RE.test(trimmed) ? trimmed : "https://" + trimmed;
  const parsed = parseUrl(candidate);
  return parsed ? parsed.normalized : "";
}

/**
 * True when `host` is `domain` or a subdomain of it. Both sides are
 * normalized first, so "www.youtube.com" matches "youtube.com" but
 * "youtube.com.evil.com" and "notyoutube.com" do not.
 */
function hostMatchesDomain(host, domain) {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith("." + d);
}

/**
 * Domains that are always allowed (with subdomains). They live here rather
 * than in storage, so they are never listed in the popup and cannot be
 * edited or deleted.
 */
const BUILTIN_DOMAINS = Object.freeze(["google.com"]);

/**
 * True when `raw` is permitted by a built-in domain or the allowlist.
 * Non-http(s) URLs are never "allowed" — callers gate on isBlockableUrl()
 * first.
 */
function isUrlAllowed(raw, allowlist) {
  const parsed = parseUrl(raw);
  if (!parsed) return false;
  for (const domain of BUILTIN_DOMAINS) {
    if (hostMatchesDomain(parsed.host, domain)) return true;
  }
  if (!Array.isArray(allowlist)) return false;

  for (const entry of allowlist) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "domain") {
      if (hostMatchesDomain(parsed.host, entry.value)) return true;
    } else if (entry.type === "url") {
      const value = normalizeUrlEntry(entry.value);
      if (value && value === parsed.normalized) return true;
    }
  }
  return false;
}

// --- Allowlist CRUD --------------------------------------------------------

let idCounter = 0;

function generateId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (_e) {
    /* fall through */
  }
  idCounter += 1;
  return "e" + idCounter + "-" + Math.random().toString(36).slice(2);
}

function normalizeEntryValue(type, rawValue) {
  if (type === "domain") return normalizeDomainEntry(rawValue);
  if (type === "url") return normalizeUrlEntry(rawValue);
  return "";
}

/**
 * True when a normalized entry value falls under a built-in domain. Such
 * entries are rejected: they would only duplicate (visibly) what the
 * built-in already allows invisibly.
 */
function matchesBuiltinDomain(type, value) {
  const host = type === "domain" ? value : (parseUrl(value) || {}).host;
  if (!host) return false;
  return BUILTIN_DOMAINS.some((domain) => hostMatchesDomain(host, domain));
}

function asList(allowlist) {
  return Array.isArray(allowlist) ? allowlist : [];
}

/**
 * Build a normalized Entry. @returns {{entry:object|null, error:string|null}}
 */
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

/**
 * @returns {{allowlist:object[], entry:object|null, error:string|null}}
 * On error the allowlist is returned unchanged.
 */
function addEntry(allowlist, type, rawValue, now, id) {
  const list = asList(allowlist);
  const made = makeEntry(type, rawValue, now, id);
  if (made.error) return { allowlist: list, entry: null, error: made.error };
  if (findDuplicate(list, made.entry.type, made.entry.value, null)) {
    return { allowlist: list, entry: null, error: "DUPLICATE" };
  }
  return { allowlist: list.concat([made.entry]), entry: made.entry, error: null };
}

/**
 * @returns {{allowlist:object[], entry:object|null, error:string|null}}
 */
function updateEntry(allowlist, id, type, rawValue, now) {
  const list = asList(allowlist);
  const index = list.findIndex((e) => e && e.id === id);
  if (index === -1) return { allowlist: list, entry: null, error: "NOT_FOUND" };

  const value = normalizeEntryValue(type, rawValue);
  if (!value) return { allowlist: list, entry: null, error: "INVALID_VALUE" };
  if (matchesBuiltinDomain(type, value)) {
    return { allowlist: list, entry: null, error: "BUILTIN" };
  }
  if (findDuplicate(list, type, value, id)) {
    return { allowlist: list, entry: null, error: "DUPLICATE" };
  }

  const previous = list[index];
  const entry = {
    id: previous.id,
    type,
    value,
    createdAt: typeof previous.createdAt === "number" ? previous.createdAt : now,
  };
  const next = list.slice();
  next[index] = entry;
  return { allowlist: next, entry, error: null };
}

/** @returns {{allowlist:object[], error:string|null}} */
function deleteEntry(allowlist, id) {
  const list = asList(allowlist);
  const index = list.findIndex((e) => e && e.id === id);
  if (index === -1) return { allowlist: list, error: "NOT_FOUND" };
  const next = list.slice();
  next.splice(index, 1);
  return { allowlist: next, error: null };
}

/** Domains first, then urls; alphabetical within each group. Never mutates. */
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

// --- Session transitions ---------------------------------------------------

const VALID_REASONS = ["manual", "timer_expired", "all_tabs_closed", "browser_restart"];

function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A fresh, mutable copy of the idle session. */
function idleSession() {
  return {
    status: "idle",
    mode: null,
    startedAt: null,
    accumulatedMs: 0,
    durationMs: null,
  };
}

/** Returns the session if it is structurally usable, otherwise a fresh idle one. */
function coerceSession(session) {
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

/** Milliseconds of focus banked so far. Frozen while paused. */
function elapsedMs(session, now) {
  const s = coerceSession(session);
  const banked = Math.max(0, num(s.accumulatedMs, 0));
  if (s.status !== "active") return banked;
  const startedAt = num(s.startedAt, null);
  if (startedAt === null) return banked;
  return banked + Math.max(0, num(now, startedAt) - startedAt);
}

/** Milliseconds left on a timer, clamped at 0. null when there is no timer. */
function remainingMs(session, now) {
  const s = coerceSession(session);
  if (s.mode !== "timer") return null;
  const duration = num(s.durationMs, null);
  if (duration === null) return null;
  return Math.max(0, duration - elapsedMs(s, now));
}

/** Wall-clock instant an actively running timer will fire. null otherwise. */
function computeEndsAt(session) {
  const s = coerceSession(session);
  if (s.status !== "active" || s.mode !== "timer") return null;
  const duration = num(s.durationMs, null);
  const startedAt = num(s.startedAt, null);
  if (duration === null || startedAt === null) return null;
  return startedAt + Math.max(0, duration - Math.max(0, num(s.accumulatedMs, 0)));
}

/** True when a running timer has reached its duration. */
function isExpired(session, now) {
  const s = coerceSession(session);
  if (s.status !== "active" || s.mode !== "timer") return false;
  const duration = num(s.durationMs, null);
  if (duration === null) return false;
  return elapsedMs(s, now) >= duration;
}

/** The one question the content script asks: should pages be blocked? */
function isBlockingActive(session) {
  return !!session && typeof session === "object" && session.status === "active";
}

/** idle -> active. @returns {{session:object, error:string|null}} */
function startSession(session, now, mode, durationMs) {
  const s = coerceSession(session);
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
    },
    error: null,
  };
}

/** active -> paused (banks the open leg). */
function pauseSession(session, now) {
  const s = coerceSession(session);
  if (s.status !== "active") return { session: s, error: "ILLEGAL_TRANSITION" };
  return {
    session: {
      status: "paused",
      mode: s.mode,
      startedAt: null,
      accumulatedMs: elapsedMs(s, now),
      durationMs: num(s.durationMs, null),
    },
    error: null,
  };
}

/** paused -> active (opens a new leg). */
function resumeSession(session, now) {
  const s = coerceSession(session);
  if (s.status !== "paused") return { session: s, error: "ILLEGAL_TRANSITION" };
  return {
    session: {
      status: "active",
      mode: s.mode,
      startedAt: num(now, 0),
      accumulatedMs: Math.max(0, num(s.accumulatedMs, 0)),
      durationMs: num(s.durationMs, null),
    },
    error: null,
  };
}

/**
 * active|paused -> idle, producing the LastSession record.
 * @returns {{session:object, lastSession:object|null, error:string|null}}
 */
function stopSession(session, now, reason) {
  const s = coerceSession(session);
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
    },
    error: null,
  };
}

// --- Duration --------------------------------------------------------------

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

/**
 * Turn an (hours, minutes) pair into a duration in ms.
 * @returns {{ms:number|null, error:null|"INVALID"|"TOO_SHORT"|"TOO_LONG"}}
 */
function parseDuration(hours, minutes) {
  const h = toWholeNumber(hours);
  const m = toWholeNumber(minutes);
  if (h === null || m === null) return { ms: null, error: "INVALID" };
  const ms = h * 3600000 + m * 60000;
  if (ms < MIN_DURATION_MS) return { ms: null, error: "TOO_SHORT" };
  if (ms > MAX_DURATION_MS) return { ms: null, error: "TOO_LONG" };
  return { ms, error: null };
}

// --- Formatting ------------------------------------------------------------

function clampMs(ms) {
  const n = num(ms, 0);
  return n > 0 ? n : 0;
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

/** "HH:MM:SS" for the popup clock. */
function formatClock(ms) {
  const total = Math.floor(clampMs(ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return pad2(hours) + ":" + pad2(minutes) + ":" + pad2(seconds);
}

/** "2h 2m" / "1m 3s" / "45s" for notifications and summaries. */
function formatShort(ms) {
  const total = Math.floor(clampMs(ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return hours + "h " + minutes + "m";
  if (minutes > 0) return minutes + "m " + seconds + "s";
  return seconds + "s";
}

// --- Exports ---------------------------------------------------------------

const LockInLib = {
  KEY_ALLOWLIST,
  KEY_SESSION,
  KEY_LAST,
  KEY_HEARTBEAT,
  MIN_DURATION_MS,
  MAX_DURATION_MS,
  ALARM_TIMER_END,
  IDLE_SESSION,
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
