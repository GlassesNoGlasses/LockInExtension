"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const lib = require("../lib.js");

// ---------------------------------------------------------------------------
// Group 1 — normalizeHost / parseUrl / isBlockableUrl
// ---------------------------------------------------------------------------

test("normalizeHost lowercases and trims", () => {
  assert.equal(lib.normalizeHost("WWW.YouTube.COM"), "youtube.com");
  assert.equal(lib.normalizeHost("  YouTube.com  "), "youtube.com");
});

test("normalizeHost strips trailing dots and leading www.", () => {
  assert.equal(lib.normalizeHost("youtube.com."), "youtube.com");
  assert.equal(lib.normalizeHost("www.youtube.com."), "youtube.com");
  assert.equal(lib.normalizeHost("music.youtube.com"), "music.youtube.com");
});

test("normalizeHost strips a port", () => {
  assert.equal(lib.normalizeHost("youtube.com:8080"), "youtube.com");
});

test("normalizeHost is total for junk input", () => {
  assert.equal(lib.normalizeHost(""), "");
  assert.equal(lib.normalizeHost(null), "");
  assert.equal(lib.normalizeHost(undefined), "");
  assert.equal(lib.normalizeHost(42), "");
  assert.equal(lib.normalizeHost({}), "");
});

test("parseUrl splits and normalizes an http(s) url", () => {
  const p = lib.parseUrl("https://WWW.YouTube.com/feed/?a=1#frag");
  assert.ok(p);
  assert.equal(p.scheme, "https");
  assert.equal(p.host, "youtube.com");
  assert.equal(p.port, "");
  assert.equal(p.path, "/feed");
  assert.equal(p.query, "?a=1");
  assert.equal(p.normalized, "https://youtube.com/feed?a=1");
});

test("parseUrl keeps the root slash and drops the hash", () => {
  assert.equal(lib.parseUrl("https://youtube.com").normalized, "https://youtube.com/");
  assert.equal(lib.parseUrl("https://youtube.com/").normalized, "https://youtube.com/");
  assert.equal(lib.parseUrl("https://youtube.com/#x").normalized, "https://youtube.com/");
});

test("parseUrl preserves a non-default port", () => {
  const p = lib.parseUrl("http://localhost:3000/x/");
  assert.equal(p.host, "localhost");
  assert.equal(p.port, "3000");
  assert.equal(p.normalized, "http://localhost:3000/x");
});

test("parseUrl drops default ports", () => {
  assert.equal(lib.parseUrl("https://example.com:443/a").normalized, "https://example.com/a");
  assert.equal(lib.parseUrl("http://example.com:80/a").normalized, "http://example.com/a");
});

test("parseUrl returns null for non-http(s) and junk", () => {
  assert.equal(lib.parseUrl("chrome://extensions"), null);
  assert.equal(lib.parseUrl("chrome-extension://abc/popup.html"), null);
  assert.equal(lib.parseUrl("about:blank"), null);
  assert.equal(lib.parseUrl("file:///Users/x"), null);
  assert.equal(lib.parseUrl("not a url"), null);
  assert.equal(lib.parseUrl(""), null);
  assert.equal(lib.parseUrl(null), null);
  assert.equal(lib.parseUrl(undefined), null);
  assert.equal(lib.parseUrl(123), null);
});

test("isBlockableUrl only accepts http(s)", () => {
  assert.equal(lib.isBlockableUrl("https://example.com"), true);
  assert.equal(lib.isBlockableUrl("http://example.com/a?b=1#c"), true);
  assert.equal(lib.isBlockableUrl("chrome://extensions"), false);
  assert.equal(lib.isBlockableUrl("about:blank"), false);
  assert.equal(lib.isBlockableUrl(""), false);
  assert.equal(lib.isBlockableUrl(null), false);
});

// ---------------------------------------------------------------------------
// Group 2 — normalizeDomainEntry / normalizeUrlEntry
// ---------------------------------------------------------------------------

test("normalizeDomainEntry accepts bare hosts", () => {
  assert.equal(lib.normalizeDomainEntry("YouTube.com"), "youtube.com");
  assert.equal(lib.normalizeDomainEntry("  www.YouTube.com.  "), "youtube.com");
  assert.equal(lib.normalizeDomainEntry("music.youtube.com"), "music.youtube.com");
  assert.equal(lib.normalizeDomainEntry("1.2.3.4"), "1.2.3.4");
  assert.equal(lib.normalizeDomainEntry("localhost"), "localhost");
});

test("normalizeDomainEntry strips scheme, port, path and query", () => {
  assert.equal(lib.normalizeDomainEntry("https://www.YouTube.com/feed?x=1#y"), "youtube.com");
  assert.equal(lib.normalizeDomainEntry("youtube.com:8080"), "youtube.com");
  assert.equal(lib.normalizeDomainEntry("youtube.com/watch?v=1"), "youtube.com");
});

test("normalizeDomainEntry rejects junk", () => {
  assert.equal(lib.normalizeDomainEntry(""), "");
  assert.equal(lib.normalizeDomainEntry("   "), "");
  assert.equal(lib.normalizeDomainEntry(null), "");
  assert.equal(lib.normalizeDomainEntry(undefined), "");
  assert.equal(lib.normalizeDomainEntry(7), "");
  assert.equal(lib.normalizeDomainEntry("not a domain"), "");
  assert.equal(lib.normalizeDomainEntry("youtube"), "");
  assert.equal(lib.normalizeDomainEntry("-bad.com"), "");
  assert.equal(lib.normalizeDomainEntry("bad-.com"), "");
  assert.equal(lib.normalizeDomainEntry("foo_bar.com"), "");
  assert.equal(lib.normalizeDomainEntry("ftp://youtube.com"), "");
});

test("normalizeUrlEntry normalizes host, hash, trailing slash", () => {
  assert.equal(
    lib.normalizeUrlEntry("https://WWW.YouTube.com/feed/?a=1#frag"),
    "https://youtube.com/feed?a=1"
  );
  assert.equal(lib.normalizeUrlEntry("https://youtube.com"), "https://youtube.com/");
  assert.equal(lib.normalizeUrlEntry("HTTP://Example.COM/A/B/"), "http://example.com/A/B");
});

test("normalizeUrlEntry assumes https for scheme-less input", () => {
  assert.equal(lib.normalizeUrlEntry("youtube.com/watch?v=1"), "https://youtube.com/watch?v=1");
  assert.equal(lib.normalizeUrlEntry("localhost:3000/app"), "https://localhost:3000/app");
});

test("normalizeUrlEntry rejects junk and non-http schemes", () => {
  assert.equal(lib.normalizeUrlEntry(""), "");
  assert.equal(lib.normalizeUrlEntry(null), "");
  assert.equal(lib.normalizeUrlEntry(12), "");
  assert.equal(lib.normalizeUrlEntry("not a url"), "");
  assert.equal(lib.normalizeUrlEntry("ftp://x.com/a"), "");
  assert.equal(lib.normalizeUrlEntry("chrome://extensions"), "");
});

// ---------------------------------------------------------------------------
// Group 3 — hostMatchesDomain (subdomain matching, adversarial)
// ---------------------------------------------------------------------------

test("hostMatchesDomain matches the domain itself and its subdomains", () => {
  assert.equal(lib.hostMatchesDomain("youtube.com", "youtube.com"), true);
  assert.equal(lib.hostMatchesDomain("music.youtube.com", "youtube.com"), true);
  assert.equal(lib.hostMatchesDomain("www.youtube.com", "youtube.com"), true);
  assert.equal(lib.hostMatchesDomain("a.b.c.youtube.com", "youtube.com"), true);
});

test("hostMatchesDomain rejects suffix and prefix look-alikes", () => {
  assert.equal(lib.hostMatchesDomain("notyoutube.com", "youtube.com"), false);
  assert.equal(lib.hostMatchesDomain("youtube.com.evil.com", "youtube.com"), false);
  assert.equal(lib.hostMatchesDomain("evilyoutube.com", "youtube.com"), false);
  assert.equal(lib.hostMatchesDomain("youtube.co", "youtube.com"), false);
  assert.equal(lib.hostMatchesDomain("youtube.com", "music.youtube.com"), false);
});

test("hostMatchesDomain normalizes both sides", () => {
  assert.equal(lib.hostMatchesDomain("WWW.YouTube.com.", "youtube.com"), true);
  assert.equal(lib.hostMatchesDomain("music.youtube.com", "WWW.YouTube.COM"), true);
  assert.equal(lib.hostMatchesDomain("music.youtube.com:443", "youtube.com"), true);
});

test("hostMatchesDomain is total and false for junk", () => {
  assert.equal(lib.hostMatchesDomain("", "youtube.com"), false);
  assert.equal(lib.hostMatchesDomain("youtube.com", ""), false);
  assert.equal(lib.hostMatchesDomain(null, null), false);
  assert.equal(lib.hostMatchesDomain(undefined, "youtube.com"), false);
  assert.equal(lib.hostMatchesDomain(5, 5), false);
});

// ---------------------------------------------------------------------------
// Group 4 — isUrlAllowed
// ---------------------------------------------------------------------------

const E = (type, value, id) => ({ id: id || type + ":" + value, type, value, createdAt: 0 });

test("isUrlAllowed matches domain entries including subdomains", () => {
  const list = [E("domain", "youtube.com")];
  assert.equal(lib.isUrlAllowed("https://youtube.com/feed", list), true);
  assert.equal(lib.isUrlAllowed("https://music.youtube.com/", list), true);
  assert.equal(lib.isUrlAllowed("http://www.youtube.com/watch?v=1", list), true);
  assert.equal(lib.isUrlAllowed("https://youtube.com.evil.com/", list), false);
  assert.equal(lib.isUrlAllowed("https://reddit.com/", list), false);
});

test("isUrlAllowed matches url entries exactly (query included, hash ignored)", () => {
  const list = [E("url", "https://docs.example.com/a?b=1")];
  assert.equal(lib.isUrlAllowed("https://docs.example.com/a?b=1", list), true);
  assert.equal(lib.isUrlAllowed("https://docs.example.com/a?b=1#frag", list), true);
  assert.equal(lib.isUrlAllowed("https://docs.example.com/a/?b=1", list), true);
  assert.equal(lib.isUrlAllowed("https://docs.example.com/a", list), false);
  assert.equal(lib.isUrlAllowed("https://docs.example.com/a?b=2", list), false);
  assert.equal(lib.isUrlAllowed("https://docs.example.com/", list), false);
});

test("isUrlAllowed handles a mixed allowlist", () => {
  const list = [E("domain", "github.com"), E("url", "https://news.ycombinator.com/")];
  assert.equal(lib.isUrlAllowed("https://gist.github.com/x", list), true);
  assert.equal(lib.isUrlAllowed("https://news.ycombinator.com", list), true);
  assert.equal(lib.isUrlAllowed("https://news.ycombinator.com/item?id=1", list), false);
  assert.equal(lib.isUrlAllowed("https://twitter.com", list), false);
});

test("isUrlAllowed normalizes stored entry values defensively", () => {
  assert.equal(lib.isUrlAllowed("https://music.youtube.com/", [E("domain", "WWW.YouTube.com.")]), true);
  assert.equal(lib.isUrlAllowed("https://x.com/a", [E("url", "HTTPS://X.com/a/")]), true);
});

test("built-in domains are always allowed, even with an empty or missing allowlist", () => {
  assert.deepEqual(lib.BUILTIN_DOMAINS, ["google.com"]);
  assert.equal(lib.isUrlAllowed("https://google.com/search?q=x", []), true);
  assert.equal(lib.isUrlAllowed("https://mail.google.com/", []), true);
  assert.equal(lib.isUrlAllowed("http://docs.google.com/d/1", null), true);
  assert.equal(lib.isUrlAllowed("https://google.com.evil.com/", []), false);
  assert.equal(lib.isUrlAllowed("https://notgoogle.com/", []), false);
});

test("isUrlAllowed is false for non-http(s) input", () => {
  const list = [E("domain", "youtube.com")];
  assert.equal(lib.isUrlAllowed("chrome://extensions", list), false);
  assert.equal(lib.isUrlAllowed("chrome-extension://abc/popup.html", list), false);
  assert.equal(lib.isUrlAllowed("about:blank", list), false);
  assert.equal(lib.isUrlAllowed("", list), false);
  assert.equal(lib.isUrlAllowed(null, list), false);
});

test("isUrlAllowed is total for junk allowlists", () => {
  assert.equal(lib.isUrlAllowed("https://youtube.com/", []), false);
  assert.equal(lib.isUrlAllowed("https://youtube.com/", null), false);
  assert.equal(lib.isUrlAllowed("https://youtube.com/", undefined), false);
  assert.equal(lib.isUrlAllowed("https://youtube.com/", "nope"), false);
  assert.equal(lib.isUrlAllowed("https://youtube.com/", [null, {}, { type: "domain" }, { type: "weird", value: "youtube.com" }]), false);
});

// ---------------------------------------------------------------------------
// Group 5 — makeEntry / addEntry / updateEntry / deleteEntry / sortAllowlist
// ---------------------------------------------------------------------------

test("makeEntry normalizes the value and stamps id/createdAt", () => {
  const r = lib.makeEntry("domain", "  WWW.YouTube.com  ", 1000, "id-1");
  assert.equal(r.error, null);
  assert.deepEqual(r.entry, { id: "id-1", type: "domain", value: "youtube.com", createdAt: 1000 });

  const u = lib.makeEntry("url", "youtube.com/watch?v=1", 5, "id-2");
  assert.equal(u.error, null);
  assert.equal(u.entry.value, "https://youtube.com/watch?v=1");
});

test("makeEntry generates a unique id when none is supplied", () => {
  const a = lib.makeEntry("domain", "a.com", 0);
  const b = lib.makeEntry("domain", "a.com", 0);
  assert.equal(typeof a.entry.id, "string");
  assert.ok(a.entry.id.length > 0);
  assert.notEqual(a.entry.id, b.entry.id);
});

test("makeEntry rejects invalid values and types", () => {
  assert.deepEqual(lib.makeEntry("domain", "nope", 0), { entry: null, error: "INVALID_VALUE" });
  assert.deepEqual(lib.makeEntry("url", "not a url", 0), { entry: null, error: "INVALID_VALUE" });
  assert.deepEqual(lib.makeEntry("bogus", "youtube.com", 0), { entry: null, error: "INVALID_VALUE" });
  assert.deepEqual(lib.makeEntry(null, null, 0), { entry: null, error: "INVALID_VALUE" });
});

test("addEntry appends without mutating the input array", () => {
  const list = [];
  const r = lib.addEntry(list, "domain", "YouTube.com", 10, "id-1");
  assert.equal(r.error, null);
  assert.equal(r.allowlist.length, 1);
  assert.equal(r.allowlist[0].value, "youtube.com");
  assert.equal(list.length, 0);
});

test("addEntry rejects duplicates after normalization", () => {
  const first = lib.addEntry([], "domain", "youtube.com", 1, "id-1").allowlist;
  const r = lib.addEntry(first, "domain", "WWW.YouTube.com.", 2, "id-2");
  assert.equal(r.error, "DUPLICATE");
  assert.equal(r.entry, null);
  assert.deepEqual(r.allowlist, first);
});

test("addEntry treats the same value under a different type as distinct", () => {
  const a = lib.addEntry([], "domain", "youtube.com", 1, "id-1").allowlist;
  const b = lib.addEntry(a, "url", "https://youtube.com/", 2, "id-2");
  assert.equal(b.error, null);
  assert.equal(b.allowlist.length, 2);
});

test("addEntry rejects invalid values", () => {
  const list = [];
  const r = lib.addEntry(list, "domain", "###", 1);
  assert.equal(r.error, "INVALID_VALUE");
  assert.deepEqual(r.allowlist, []);
});

test("addEntry rejects values covered by a built-in domain", () => {
  for (const value of [
    "google.com",
    "mail.google.com",
    "WWW.Google.com.",
    "https://google.com/search?q=x",
    "https://docs.google.com/d/1",
  ]) {
    const type = value.startsWith("https://") ? "url" : "domain";
    const r = lib.addEntry([], type, value, 1, "id-1");
    assert.equal(r.error, "BUILTIN", value + " should be rejected");
    assert.deepEqual(r.allowlist, []);
  }
  // Suffix look-alikes are NOT built-in and stay addable.
  assert.equal(lib.addEntry([], "domain", "notgoogle.com", 1, "id-1").error, null);
  assert.equal(lib.addEntry([], "domain", "google.com.evil.com", 1, "id-2").error, null);
});

test("updateEntry rejects edits into a built-in domain", () => {
  const list = lib.addEntry([], "domain", "youtube.com", 1, "id-1").allowlist;
  const asDomain = lib.updateEntry(list, "id-1", "domain", "google.com", 2);
  assert.equal(asDomain.error, "BUILTIN");
  const asUrl = lib.updateEntry(list, "id-1", "url", "https://mail.google.com/inbox", 2);
  assert.equal(asUrl.error, "BUILTIN");
  assert.equal(list[0].value, "youtube.com"); // untouched on error
});

test("addEntry is total for a junk allowlist", () => {
  const r = lib.addEntry(null, "domain", "youtube.com", 1, "id-1");
  assert.equal(r.error, null);
  assert.equal(r.allowlist.length, 1);
});

test("updateEntry replaces value and type, preserving id and createdAt", () => {
  const list = lib.addEntry([], "domain", "youtube.com", 100, "id-1").allowlist;
  const r = lib.updateEntry(list, "id-1", "url", "https://reddit.com/r/x/", 200);
  assert.equal(r.error, null);
  assert.deepEqual(r.allowlist[0], {
    id: "id-1",
    type: "url",
    value: "https://reddit.com/r/x",
    createdAt: 100,
  });
  assert.equal(list[0].value, "youtube.com"); // input untouched
});

test("updateEntry allows a no-op rewrite of the same entry", () => {
  const list = lib.addEntry([], "domain", "youtube.com", 1, "id-1").allowlist;
  const r = lib.updateEntry(list, "id-1", "domain", "WWW.YouTube.com", 2);
  assert.equal(r.error, null);
  assert.equal(r.allowlist[0].value, "youtube.com");
});

test("updateEntry reports NOT_FOUND / INVALID_VALUE / DUPLICATE", () => {
  let list = lib.addEntry([], "domain", "youtube.com", 1, "id-1").allowlist;
  list = lib.addEntry(list, "domain", "reddit.com", 2, "id-2").allowlist;

  const nf = lib.updateEntry(list, "nope", "domain", "x.com", 3);
  assert.equal(nf.error, "NOT_FOUND");
  assert.deepEqual(nf.allowlist, list);

  const iv = lib.updateEntry(list, "id-1", "domain", "###", 3);
  assert.equal(iv.error, "INVALID_VALUE");
  assert.deepEqual(iv.allowlist, list);

  const dup = lib.updateEntry(list, "id-1", "domain", "reddit.com", 3);
  assert.equal(dup.error, "DUPLICATE");
  assert.deepEqual(dup.allowlist, list);
});

test("deleteEntry removes by id and reports NOT_FOUND", () => {
  let list = lib.addEntry([], "domain", "youtube.com", 1, "id-1").allowlist;
  list = lib.addEntry(list, "domain", "reddit.com", 2, "id-2").allowlist;

  const ok = lib.deleteEntry(list, "id-1");
  assert.equal(ok.error, null);
  assert.equal(ok.allowlist.length, 1);
  assert.equal(ok.allowlist[0].id, "id-2");
  assert.equal(list.length, 2);

  const nf = lib.deleteEntry(list, "nope");
  assert.equal(nf.error, "NOT_FOUND");
  assert.deepEqual(nf.allowlist, list);
});

test("sortAllowlist orders domains before urls, alphabetically, without mutating", () => {
  const list = [
    E("url", "https://b.com/z"),
    E("domain", "zebra.com"),
    E("url", "https://a.com/z"),
    E("domain", "apple.com"),
  ];
  const sorted = lib.sortAllowlist(list);
  assert.deepEqual(
    sorted.map((e) => e.type + " " + e.value),
    ["domain apple.com", "domain zebra.com", "url https://a.com/z", "url https://b.com/z"]
  );
  assert.equal(list[0].value, "https://b.com/z");
  assert.deepEqual(lib.sortAllowlist(null), []);
});

// ---------------------------------------------------------------------------
// Group 6 — parseDuration
// ---------------------------------------------------------------------------

test("parseDuration accepts numbers and numeric strings", () => {
  assert.deepEqual(lib.parseDuration(0, 1), { ms: 60000, error: null });
  assert.deepEqual(lib.parseDuration("1", "30"), { ms: 5400000, error: null });
  assert.deepEqual(lib.parseDuration(" 2 ", ""), { ms: 7200000, error: null });
  assert.deepEqual(lib.parseDuration("", "90"), { ms: 5400000, error: null });
  assert.deepEqual(lib.parseDuration(null, 25), { ms: 1500000, error: null });
});

test("parseDuration enforces the 1 minute lower bound", () => {
  assert.deepEqual(lib.parseDuration(0, 0), { ms: null, error: "TOO_SHORT" });
  assert.deepEqual(lib.parseDuration("", ""), { ms: null, error: "TOO_SHORT" });
  assert.deepEqual(lib.parseDuration(undefined, undefined), { ms: null, error: "TOO_SHORT" });
});

test("parseDuration enforces the 24 hour upper bound", () => {
  assert.deepEqual(lib.parseDuration(24, 0), { ms: lib.MAX_DURATION_MS, error: null });
  assert.deepEqual(lib.parseDuration(23, 60), { ms: lib.MAX_DURATION_MS, error: null });
  assert.deepEqual(lib.parseDuration(24, 1), { ms: null, error: "TOO_LONG" });
  assert.deepEqual(lib.parseDuration(25, 0), { ms: null, error: "TOO_LONG" });
});

test("parseDuration rejects non-numeric, fractional and negative input", () => {
  assert.deepEqual(lib.parseDuration("abc", 0), { ms: null, error: "INVALID" });
  assert.deepEqual(lib.parseDuration(0, "12x"), { ms: null, error: "INVALID" });
  assert.deepEqual(lib.parseDuration({}, 0), { ms: null, error: "INVALID" });
  assert.deepEqual(lib.parseDuration(NaN, 0), { ms: null, error: "INVALID" });
  assert.deepEqual(lib.parseDuration(Infinity, 0), { ms: null, error: "INVALID" });
  assert.deepEqual(lib.parseDuration(0, 1.5), { ms: null, error: "INVALID" });
  assert.deepEqual(lib.parseDuration(-1, 0), { ms: null, error: "INVALID" });
  assert.deepEqual(lib.parseDuration(0, -30), { ms: null, error: "INVALID" });
  assert.deepEqual(lib.parseDuration(1, -30), { ms: null, error: "INVALID" });
});

// ---------------------------------------------------------------------------
// Group 7 — session transitions
// ---------------------------------------------------------------------------

const idle = () => ({ status: "idle", mode: null, startedAt: null, accumulatedMs: 0, durationMs: null });
const activeStopwatch = (startedAt, accumulatedMs) => ({
  status: "active", mode: "stopwatch", startedAt, accumulatedMs: accumulatedMs || 0, durationMs: null,
});
const activeTimer = (startedAt, durationMs, accumulatedMs) => ({
  status: "active", mode: "timer", startedAt, accumulatedMs: accumulatedMs || 0, durationMs,
});
const pausedStopwatch = (accumulatedMs) => ({
  status: "paused", mode: "stopwatch", startedAt: null, accumulatedMs, durationMs: null,
});
const pausedTimer = (accumulatedMs, durationMs) => ({
  status: "paused", mode: "timer", startedAt: null, accumulatedMs, durationMs,
});

/** Runs `fn(session)` and asserts the input object was not mutated. */
function withoutMutating(session, fn) {
  const before = JSON.parse(JSON.stringify(session));
  const result = fn(session);
  assert.deepEqual(session, before, "input session was mutated");
  return result;
}

test("startSession starts a stopwatch from idle", () => {
  const r = withoutMutating(idle(), (s) => lib.startSession(s, 1000, "stopwatch"));
  assert.equal(r.error, null);
  assert.deepEqual(r.session, {
    status: "active", mode: "stopwatch", startedAt: 1000, accumulatedMs: 0, durationMs: null,
  });
});

test("startSession starts a timer from idle", () => {
  const r = withoutMutating(idle(), (s) => lib.startSession(s, 1000, "timer", 1800000));
  assert.equal(r.error, null);
  assert.deepEqual(r.session, {
    status: "active", mode: "timer", startedAt: 1000, accumulatedMs: 0, durationMs: 1800000,
  });
});

test("startSession accepts a missing/garbage session as idle", () => {
  assert.equal(lib.startSession(null, 1, "stopwatch").error, null);
  assert.equal(lib.startSession(undefined, 1, "stopwatch").error, null);
  assert.equal(lib.startSession("junk", 1, "stopwatch").error, null);
});

test("startSession validates the timer duration", () => {
  for (const bad of [0, null, undefined, "abc", NaN, lib.MIN_DURATION_MS - 1, lib.MAX_DURATION_MS + 1, -60000]) {
    const r = withoutMutating(idle(), (s) => lib.startSession(s, 1000, "timer", bad));
    assert.equal(r.error, "INVALID_DURATION", "duration " + String(bad));
  }
  assert.equal(lib.startSession(idle(), 1, "timer", lib.MIN_DURATION_MS).error, null);
  assert.equal(lib.startSession(idle(), 1, "timer", lib.MAX_DURATION_MS).error, null);
});

test("startSession rejects an unknown mode", () => {
  const r = withoutMutating(idle(), (s) => lib.startSession(s, 1000, "sprint"));
  assert.equal(r.error, "INVALID_VALUE");
  assert.equal(lib.startSession(idle(), 1000, null).error, "INVALID_VALUE");
});

test("startSession is illegal while active or paused", () => {
  const a = withoutMutating(activeStopwatch(500), (s) => lib.startSession(s, 1000, "timer", 60000));
  assert.equal(a.error, "ILLEGAL_TRANSITION");
  assert.deepEqual(a.session, activeStopwatch(500));

  const p = withoutMutating(pausedStopwatch(400), (s) => lib.startSession(s, 1000, "stopwatch"));
  assert.equal(p.error, "ILLEGAL_TRANSITION");
  assert.deepEqual(p.session, pausedStopwatch(400));
});

test("pauseSession banks the elapsed leg", () => {
  const r = withoutMutating(activeStopwatch(1000, 5000), (s) => lib.pauseSession(s, 4000));
  assert.equal(r.error, null);
  assert.deepEqual(r.session, {
    status: "paused", mode: "stopwatch", startedAt: null, accumulatedMs: 8000, durationMs: null,
  });
});

test("pauseSession is illegal from idle and paused", () => {
  const i = withoutMutating(idle(), (s) => lib.pauseSession(s, 1));
  assert.equal(i.error, "ILLEGAL_TRANSITION");
  assert.deepEqual(i.session, idle());

  const p = withoutMutating(pausedStopwatch(400), (s) => lib.pauseSession(s, 1));
  assert.equal(p.error, "ILLEGAL_TRANSITION");
  assert.deepEqual(p.session, pausedStopwatch(400));
});

test("resumeSession opens a new leg from paused", () => {
  const r = withoutMutating(pausedTimer(8000, 600000), (s) => lib.resumeSession(s, 50000));
  assert.equal(r.error, null);
  assert.deepEqual(r.session, {
    status: "active", mode: "timer", startedAt: 50000, accumulatedMs: 8000, durationMs: 600000,
  });
});

test("resumeSession is illegal from idle and active", () => {
  const i = withoutMutating(idle(), (s) => lib.resumeSession(s, 1));
  assert.equal(i.error, "ILLEGAL_TRANSITION");

  const a = withoutMutating(activeStopwatch(100), (s) => lib.resumeSession(s, 500));
  assert.equal(a.error, "ILLEGAL_TRANSITION");
  assert.deepEqual(a.session, activeStopwatch(100));
});

test("stopSession finalizes an active session", () => {
  const r = withoutMutating(activeTimer(1000, 600000, 2000), (s) => lib.stopSession(s, 5000, "timer_expired"));
  assert.equal(r.error, null);
  assert.deepEqual(r.session, idle());
  assert.deepEqual(r.lastSession, {
    mode: "timer", elapsedMs: 6000, endedAt: 5000, reason: "timer_expired",
  });
});

test("stopSession finalizes a paused session at its banked time", () => {
  const r = withoutMutating(pausedStopwatch(9000), (s) => lib.stopSession(s, 99999, "manual"));
  assert.equal(r.error, null);
  assert.deepEqual(r.session, idle());
  assert.deepEqual(r.lastSession, {
    mode: "stopwatch", elapsedMs: 9000, endedAt: 99999, reason: "manual",
  });
});

test("stopSession defaults an unusable reason to manual", () => {
  assert.equal(lib.stopSession(pausedStopwatch(1), 2).lastSession.reason, "manual");
  assert.equal(lib.stopSession(pausedStopwatch(1), 2, 42).lastSession.reason, "manual");
});

test("stopSession is illegal from idle", () => {
  const r = withoutMutating(idle(), (s) => lib.stopSession(s, 10, "manual"));
  assert.equal(r.error, "ILLEGAL_TRANSITION");
  assert.equal(r.lastSession, null);
  assert.deepEqual(r.session, idle());
});

test("transitions never hand back a shared IDLE_SESSION object", () => {
  const a = lib.stopSession(pausedStopwatch(1), 2, "manual").session;
  const b = lib.stopSession(pausedStopwatch(1), 2, "manual").session;
  assert.notEqual(a, lib.IDLE_SESSION);
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// Group 8 — elapsedMs / remainingMs / computeEndsAt / isExpired / isBlockingActive
// ---------------------------------------------------------------------------

test("elapsedMs counts the open leg of an active session", () => {
  assert.equal(lib.elapsedMs(activeStopwatch(1000), 1000), 0);
  assert.equal(lib.elapsedMs(activeStopwatch(1000), 4000), 3000);
  assert.equal(lib.elapsedMs(activeStopwatch(1000, 5000), 4000), 8000);
});

test("elapsedMs is frozen while paused", () => {
  const s = pausedStopwatch(3000);
  assert.equal(lib.elapsedMs(s, 4000), 3000);
  assert.equal(lib.elapsedMs(s, 4000000), 3000);
});

test("elapsedMs is 0 for idle and total for junk", () => {
  assert.equal(lib.elapsedMs(idle(), 5000), 0);
  assert.equal(lib.elapsedMs(null, 5000), 0);
  assert.equal(lib.elapsedMs(undefined, undefined), 0);
  assert.equal(lib.elapsedMs({ status: "active", startedAt: "x", accumulatedMs: 7 }, 100), 7);
});

test("elapsedMs never goes backwards when the clock jumps back", () => {
  assert.equal(lib.elapsedMs(activeStopwatch(10000, 500), 9000), 500);
});

test("elapsed time survives a pause/resume/pause cycle", () => {
  let s = lib.startSession(idle(), 1000, "stopwatch").session;
  assert.equal(lib.elapsedMs(s, 4000), 3000);

  s = lib.pauseSession(s, 4000).session;
  assert.equal(lib.elapsedMs(s, 10000), 3000);
  assert.equal(lib.isBlockingActive(s), false);

  s = lib.resumeSession(s, 10000).session;
  assert.equal(lib.elapsedMs(s, 10000), 3000);
  assert.equal(lib.elapsedMs(s, 12000), 5000);

  s = lib.pauseSession(s, 12000).session;
  assert.equal(lib.elapsedMs(s, 999999), 5000);

  const done = lib.stopSession(s, 999999, "manual");
  assert.equal(done.lastSession.elapsedMs, 5000);
});

test("remainingMs counts down for timers and clamps at zero", () => {
  const s = activeTimer(1000, 600000);
  assert.equal(lib.remainingMs(s, 1000), 600000);
  assert.equal(lib.remainingMs(s, 301000), 300000);
  assert.equal(lib.remainingMs(s, 601000), 0);
  assert.equal(lib.remainingMs(s, 9999999), 0);
  assert.equal(lib.remainingMs(pausedTimer(300000, 600000), 9999999), 300000);
});

test("remainingMs is null when there is no timer", () => {
  assert.equal(lib.remainingMs(activeStopwatch(1000), 5000), null);
  assert.equal(lib.remainingMs(pausedStopwatch(1000), 5000), null);
  assert.equal(lib.remainingMs(idle(), 5000), null);
  assert.equal(lib.remainingMs(null, 5000), null);
});

test("computeEndsAt accounts for banked time", () => {
  assert.equal(lib.computeEndsAt(activeTimer(1000, 600000)), 601000);
  assert.equal(lib.computeEndsAt(activeTimer(1000000, 600000, 300000)), 1300000);
});

test("computeEndsAt is null unless a timer is actively running", () => {
  assert.equal(lib.computeEndsAt(pausedTimer(300000, 600000)), null);
  assert.equal(lib.computeEndsAt(activeStopwatch(1000)), null);
  assert.equal(lib.computeEndsAt(idle()), null);
  assert.equal(lib.computeEndsAt(null), null);
});

test("isExpired is true only once an active timer reaches its duration", () => {
  const s = activeTimer(1000, 600000);
  assert.equal(lib.isExpired(s, 600999), false);
  assert.equal(lib.isExpired(s, 601000), true);
  assert.equal(lib.isExpired(s, 700000), true);
});

test("isExpired is false for paused timers, stopwatches and idle", () => {
  assert.equal(lib.isExpired(pausedTimer(600000, 600000), 9999999), false);
  assert.equal(lib.isExpired(activeStopwatch(1000), 9999999), false);
  assert.equal(lib.isExpired(idle(), 9999999), false);
  assert.equal(lib.isExpired(null, 9999999), false);
});

test("isBlockingActive is true only for active sessions", () => {
  assert.equal(lib.isBlockingActive(activeStopwatch(1000)), true);
  assert.equal(lib.isBlockingActive(activeTimer(1000, 600000)), true);
  assert.equal(lib.isBlockingActive(pausedStopwatch(1000)), false);
  assert.equal(lib.isBlockingActive(pausedTimer(1, 600000)), false);
  assert.equal(lib.isBlockingActive(idle()), false);
  assert.equal(lib.isBlockingActive(null), false);
  assert.equal(lib.isBlockingActive("active"), false);
});

// ---------------------------------------------------------------------------
// Group 9 — formatClock / formatShort
// ---------------------------------------------------------------------------

test("formatClock renders HH:MM:SS", () => {
  assert.equal(lib.formatClock(0), "00:00:00");
  assert.equal(lib.formatClock(1000), "00:00:01");
  assert.equal(lib.formatClock(1999), "00:00:01");
  assert.equal(lib.formatClock(61000), "00:01:01");
  assert.equal(lib.formatClock(3661000), "01:01:01");
  assert.equal(lib.formatClock(lib.MAX_DURATION_MS), "24:00:00");
  assert.equal(lib.formatClock(359999999), "99:59:59");
});

test("formatClock is total and clamps at zero", () => {
  assert.equal(lib.formatClock(-1), "00:00:00");
  assert.equal(lib.formatClock(-90000), "00:00:00");
  assert.equal(lib.formatClock(null), "00:00:00");
  assert.equal(lib.formatClock(undefined), "00:00:00");
  assert.equal(lib.formatClock(NaN), "00:00:00");
  assert.equal(lib.formatClock("abc"), "00:00:00");
  assert.equal(lib.formatClock(Infinity), "00:00:00");
});

test("formatShort renders a human summary", () => {
  assert.equal(lib.formatShort(0), "0s");
  assert.equal(lib.formatShort(999), "0s");
  assert.equal(lib.formatShort(1000), "1s");
  assert.equal(lib.formatShort(45000), "45s");
  assert.equal(lib.formatShort(59999), "59s");
  assert.equal(lib.formatShort(60000), "1m 0s");
  assert.equal(lib.formatShort(63000), "1m 3s");
  assert.equal(lib.formatShort(3599000), "59m 59s");
  assert.equal(lib.formatShort(3600000), "1h 0m");
  assert.equal(lib.formatShort(3900000), "1h 5m");
  assert.equal(lib.formatShort(7325000), "2h 2m");
  assert.equal(lib.formatShort(lib.MAX_DURATION_MS), "24h 0m");
});

test("formatShort is total and clamps at zero", () => {
  assert.equal(lib.formatShort(-5000), "0s");
  assert.equal(lib.formatShort(null), "0s");
  assert.equal(lib.formatShort(undefined), "0s");
  assert.equal(lib.formatShort(NaN), "0s");
  assert.equal(lib.formatShort("abc"), "0s");
});

// ---------------------------------------------------------------------------
// Hygiene — the invariants the rest of the extension relies on
// ---------------------------------------------------------------------------

test("lib.js references no chrome APIs and no ambient clock", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "lib.js"), "utf8");
  assert.equal(/\bchrome\s*\./.test(src), false, "lib.js must not touch chrome.*");
  assert.equal(/\bDate\s*\.\s*now\b/.test(src), false, "lib.js must take `now` as a parameter");
  assert.equal(/\bnew Date\b/.test(src), false, "lib.js must take `now` as a parameter");
});

test("lib.js exports the whole frozen API surface", () => {
  const expected = [
    "KEY_ALLOWLIST", "KEY_SESSION", "KEY_LAST", "KEY_HEARTBEAT",
    "MIN_DURATION_MS", "MAX_DURATION_MS", "ALARM_TIMER_END", "IDLE_SESSION",
    "normalizeHost", "parseUrl", "isBlockableUrl", "normalizeUrlEntry",
    "normalizeDomainEntry", "hostMatchesDomain", "isUrlAllowed",
    "makeEntry", "addEntry", "updateEntry", "deleteEntry", "sortAllowlist",
    "startSession", "pauseSession", "resumeSession", "stopSession",
    "elapsedMs", "remainingMs", "computeEndsAt", "isExpired", "isBlockingActive",
    "parseDuration", "formatClock", "formatShort",
  ];
  for (const name of expected) {
    assert.ok(name in lib, "missing export: " + name);
  }
  assert.deepEqual(lib.IDLE_SESSION, {
    status: "idle", mode: null, startedAt: null, accumulatedMs: 0, durationMs: null,
  });
  assert.equal(lib.KEY_ALLOWLIST, "lockin.allowlist");
  assert.equal(lib.KEY_SESSION, "lockin.session");
  assert.equal(lib.KEY_LAST, "lockin.lastSession");
  assert.equal(lib.KEY_HEARTBEAT, "lockin.heartbeat");
  assert.equal(lib.MIN_DURATION_MS, 60000);
  assert.equal(lib.MAX_DURATION_MS, 86400000);
  assert.equal(lib.ALARM_TIMER_END, "lockin-timer-end");
  assert.equal(globalThis.LockInLib, lib);
});
