"use strict";

/**
 * background.js — main service worker.
 *
 * Performs:
 * - ONLY writer of session state in chrome.storage.local. No other sessions stored.
 * - Elapsed time is always derived from stored timestamps (lib.js).
 * - Every state mutation runs inside withWriteLock() for concurrency.
 */

importScripts("lib.js");
const L = globalThis.LockInLib;

const NOTIFICATION_ID = "lockin-timer-done";
const TAB_RECHECK_MS = 750; // second sample for the all-tabs-closed check
const HEARTBEAT_THROTTLE_MS = 5000; // 5 seconds
const STATE_KEYS = [L.KEY_SESSION, L.KEY_ALLOWLIST, L.KEY_LAST, L.KEY_HEARTBEAT];

const BADGE = { // badge states + color
  active: { text: "ON", color: "#1e8e3e" },
  paused: { text: "II", color: "#f9ab00" },
  done: { text: "DONE", color: "#1a73e8" },
};

// --- Helpers

// ignore chrome async function return values when not needed
function ignore(maybePromise) {
  if (maybePromise && typeof maybePromise.catch === "function") {
    maybePromise.catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Storage

function parseStorageSession(raw) {
  if (
    raw &&
    typeof raw === "object" &&
    (raw.status === "idle" || raw.status === "active" || raw.status === "paused")
  ) {
    return raw;
  }
  return L.idleSession();
}

// fetches current session, allows, last session, and heartbeat health from local storage
async function readRawState() {
  try {
    return await chrome.storage.local.get(STATE_KEYS);
  } catch (_e) {
    return {};
  }
}

async function readState() {
  const data = await readRawState();
  return {
    session: parseStorageSession(data[L.KEY_SESSION]),
    allowlist: Array.isArray(data[L.KEY_ALLOWLIST]) ? data[L.KEY_ALLOWLIST] : [],
    lastSession: data[L.KEY_LAST] || null,
    heartbeat: data[L.KEY_HEARTBEAT] || null,
  };
}

// writes to local storage
async function writeState(patch) {
  try {
    await chrome.storage.local.set(patch);
  } catch (e) {
    console.error("Failed writing to storage: ", e)
  }
}

// rate limit heartbeat of timer/stopwatch (last state recorded)
let lastTouchAt = 0;
function touch(now, force) {
  if (!force && now - lastTouchAt < HEARTBEAT_THROTTLE_MS) return Promise.resolve();
  lastTouchAt = now;
  return writeState({ [L.KEY_HEARTBEAT]: { lastSeenAt: now } });
}

// --- Write lock

let writeChain = Promise.resolve();

// acquire write lock to storage
function withWriteLock(task) {
  // call task
  const result = writeChain.then(() => task());
  // on complete reset lock
  writeChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// --- Badge / alarm / notification

// returns True when DONE badge is not seen
function isUnseenExpiry(lastSession) {
  return !!lastSession && lastSession.reason === "timer_expired" && !lastSession.acknowledged;
}

function badgeFor(session, lastSession) {
  if (session.status === "active") return BADGE.active;
  if (session.status === "paused") return BADGE.paused;
  return isUnseenExpiry(lastSession) ? BADGE.done : null;
}

// update badge
async function syncBadge() {
  const { session, lastSession } = await readState();
  const badge = badgeFor(session, lastSession);
  try {
    await chrome.action.setBadgeText({ text: badge ? badge.text : "" });
    if (badge) await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  } catch (_e) {
    console.error("Failed to sync badge: ", e)
  }
}

// timer finished callback function; lock -> write lastSession state -> badge update
function acknowledgeLastSession() {
  return withWriteLock(async () => {
    const { lastSession } = await readState();
    if (!isUnseenExpiry(lastSession)) return;
    await writeState({ [L.KEY_LAST]: { ...lastSession, acknowledged: true } });
    await syncBadge();
  });
}

async function clearTimerAlarm() {
  try {
    await chrome.alarms.clear(L.ALARM_TIMER_END);
  } catch (e) {
    console.error("Failed to clear timer alarm: ", e)
  }
}

// (re)computes chrome alarm for timer option
async function armTimerAlarm(session) {
  await clearTimerAlarm();
  const endsAt = L.computeEndsAt(session);
  if (endsAt === null) return;
  try {
    await chrome.alarms.create(L.ALARM_TIMER_END, { when: endsAt });
  } catch (e) {
    console.error("Failed to create alarm for Timer option: ", e)
  }
}

// timer option done
function notifyTimerDone(elapsed) {
  try {
    ignore(
      chrome.notifications.create(NOTIFICATION_ID, {
        type: "basic",
        iconUrl: "yippee.gif",
        title: "Lock In — time's up",
        message: "Nice job twin, you stayed locked in for " + L.formatShort(elapsed),
        priority: 2,
        requireInteraction: true,
      })
    );
  } catch (e) {
    console.error("Failed to create notification: Timer Done")
  }
}

// --- Timer/Stopwatch transitions (all callers must hold the write lock)

// finalizes session state and writes to storage; write lock must be acquired
async function finalize(session, endedAt, reason) {
  const result = L.stopSession(session, endedAt, reason);
  if (result.error) return { ok: false, error: result.error };

  await writeState({
    [L.KEY_SESSION]: result.session,
    [L.KEY_LAST]: result.lastSession,
  });
  await clearTimerAlarm();
  // a finished timer is the only ending the user is notified about
  if (result.lastSession.reason === "timer_expired") {
    notifyTimerDone(result.lastSession.elapsedMs);
  }
  await syncBadge();
  return { ok: true, session: result.session, lastSession: result.lastSession };
}

// starts a new session; acquires storage write lock
function start(mode, durationMs, tagScope) {
  return withWriteLock(async () => {
    const now = Date.now();
    const { session } = await readState();
    const result = L.startSession(session, now, mode, durationMs, tagScope);
    if (result.error) return { ok: false, error: result.error };

    await writeState({ [L.KEY_SESSION]: result.session, [L.KEY_LAST]: null });
    await armTimerAlarm(result.session);
    await touch(now, true);
    await syncBadge();
    return { ok: true, session: result.session };
  });
}

// pauses an active session; acquires write lock
function doPause() {
  return withWriteLock(async () => {
    const now = Date.now();
    const { session } = await readState();
    const result = L.pauseSession(session, now);
    if (result.error) return { ok: false, error: result.error };

    await writeState({ [L.KEY_SESSION]: result.session });
    await clearTimerAlarm();
    await syncBadge();
    return { ok: true, session: result.session };
  });
}

// resumes a paused session; acquires write lock
function doResume() {
  return withWriteLock(async () => {
    const now = Date.now();
    const { session } = await readState();
    const result = L.resumeSession(session, now);
    if (result.error) return { ok: false, error: result.error };

    await writeState({ [L.KEY_SESSION]: result.session });
    await armTimerAlarm(result.session);
    await touch(now, true);
    await syncBadge();
    return { ok: true, session: result.session };
  });
}

// stops a session and resets; acquires write lock -> finalize
function doStop() {
  return withWriteLock(async () => {
    const { session } = await readState();
    return finalize(session, Date.now(), "manual");
  });
}

// --- Allowlist functions (write lock must be acquired)

// adds a new URL/DOM to allowlist; acquires write lock
function doAddEntry(entryType, value, { tolerateDuplicate = false } = {}) {
  return withWriteLock(async () => {
    const { allowlist } = await readState();
    const result = L.addEntry(allowlist, entryType, value, Date.now());
    if (result.error === "DUPLICATE" && tolerateDuplicate) {
      return { ok: true, entry: null, allowlist, duplicate: true };
    }
    if (result.error) return { ok: false, error: result.error };

    await writeState({ [L.KEY_ALLOWLIST]: result.allowlist });
    return { ok: true, entry: result.entry, allowlist: result.allowlist };
  });
}

// updates a URL/DOM from allowList; acquires write lock
function doUpdateEntry(id, entryType, value, tag) {
  return withWriteLock(async () => {
    const { allowlist } = await readState();
    const result = L.updateEntry(allowlist, id, entryType, value, Date.now(), tag);
    if (result.error) return { ok: false, error: result.error };

    await writeState({ [L.KEY_ALLOWLIST]: result.allowlist });
    return { ok: true, entry: result.entry, allowlist: result.allowlist };
  });
}

// deletes a URL/DOM from allowList; acquires write lock
function doDeleteEntry(id) {
  return withWriteLock(async () => {
    const { allowlist } = await readState();
    const result = L.deleteEntry(allowlist, id);
    if (result.error) return { ok: false, error: result.error };

    await writeState({ [L.KEY_ALLOWLIST]: result.allowlist });
    return { ok: true, allowlist: result.allowlist };
  });
}

// modal "You Right" option to programatically close tab
async function doCloseTab(sender) {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (typeof tabId !== "number") return { ok: false, error: "NO_TAB" };
  try {
    await chrome.tabs.remove(tabId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "NO_TAB" };
  }
}

// --- Reconcilers - because service worker interruptions & actual states needed.
// Write locks acquired; can be called everywhere

// fills in every storage key the extension has not written yet
function seedDefaults() {
  return withWriteLock(async () => {
    const data = await readRawState();
    const patch = {};
    if (!Array.isArray(data[L.KEY_ALLOWLIST])) patch[L.KEY_ALLOWLIST] = [];
    if (!data[L.KEY_SESSION]) patch[L.KEY_SESSION] = L.idleSession();
    if (!(L.KEY_LAST in data)) patch[L.KEY_LAST] = null;
    if (!data[L.KEY_HEARTBEAT]) patch[L.KEY_HEARTBEAT] = { lastSeenAt: Date.now() };
    if (Object.keys(patch).length > 0) await writeState(patch);
    await syncBadge();
  });
}

// re-derives timer, timer alarm, and finalization of timer
function reconcileTimer() {
  return withWriteLock(async () => {
    const now = Date.now();
    const { session } = await readState();

    if (L.isExpired(session, now)) {
      const endsAt = L.computeEndsAt(session);
      return finalize(session, endsAt === null ? now : endsAt, "timer_expired");
    }
    if (session.status === "active" && session.mode === "timer") {
      await armTimerAlarm(session);
    }
    return { ok: true, session };
  });
}

// onStartup, checks and updates prior states + timers
function reconcileOnBoot() {
  return withWriteLock(async () => {
    const now = Date.now();
    const { session, heartbeat } = await readState();

    if (session.status === "active") {
      if (session.mode === "timer") {
        const endsAt = L.computeEndsAt(session);
        if (endsAt !== null && endsAt <= now) {
          await finalize(session, endsAt, "timer_expired");
        } else {
          await armTimerAlarm(session);
        }
      } else {
        const seenAt =
          heartbeat && typeof heartbeat.lastSeenAt === "number" ? heartbeat.lastSeenAt : now;
        const startedAt = typeof session.startedAt === "number" ? session.startedAt : 0;
        const endedAt = Math.min(now, Math.max(seenAt, startedAt));
        await finalize(session, endedAt, "browser_restart");
      }
    }

    await syncBadge();
    await touch(now, true);
  });
}

async function countTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    return Array.isArray(tabs) ? tabs.length : -1;
  } catch (e) {
    return -1; // unknown: never treat an error as "no tabs left"
  }
}

// for stopwatch ONLY; checks all tabs are closed and turns off stopwatch
// double counts for last tab drag
async function checkAllTabsClosed() {
  if ((await countTabs()) !== 0) return;
  await sleep(TAB_RECHECK_MS);
  if ((await countTabs()) !== 0) return;

  await withWriteLock(async () => {
    const { session } = await readState();
    if (session.status !== "active" || session.mode !== "stopwatch") return;
    await finalize(session, Date.now(), "all_tabs_closed");
  });
}

// runs on service worker init; resyncs badge + alarm
async function initOnWake() {
  try {
    const { session } = await readState();
    if (session.status === "active" && session.mode === "timer") {
      await armTimerAlarm(session);
    }
    await syncBadge();
  } catch (e) {
    console.error("Service Worker Init: ", e)
  }
}

// --- Message routing
async function handleMessage(message, sender) {
  switch (message && message.type) {
    case "GET_STATE": {
      await reconcileTimer();
      await acknowledgeLastSession();
      const { session, allowlist, lastSession } = await readState();
      return { ok: true, session, allowlist, lastSession };
    }
    case "START_SESSION":
      return start(message.mode, message.durationMs, message.tagScope);
    case "PAUSE_SESSION":
      return doPause();
    case "RESUME_SESSION":
      return doResume();
    case "STOP_SESSION":
      return doStop();
    case "ADD_ENTRY":
      return doAddEntry(message.entryType, message.value);
    case "UPDATE_ENTRY":
      return doUpdateEntry(message.id, message.entryType, message.value, message.tag);
    case "DELETE_ENTRY":
      return doDeleteEntry(message.id);
    case "ALLOW_URL":
      return doAddEntry("url", message.url, { tolerateDuplicate: true });
    case "ALLOW_DOMAIN":
      return doAddEntry("domain", message.url, { tolerateDuplicate: true });
    case "CLOSE_TAB":
      return doCloseTab(sender);
    default:
      return { ok: false, error: "INVALID_VALUE" };
  }
}

// --- Listeners

function onTabOrWindowClosed() {
  ignore(touch(Date.now(), true));
  ignore(checkAllTabsClosed());
}

chrome.runtime.onInstalled.addListener(() => {
  ignore(seedDefaults());
});

chrome.runtime.onStartup.addListener(() => {
  ignore(reconcileOnBoot());
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (response) => {
    try {
      sendResponse(response);
    } catch (_e) {
      // port closed
    }
  };
  handleMessage(message, sender).then(
    (response) => respond(response || { ok: false, error: "INTERNAL" }),
    (error) =>
      respond({ ok: false, error: "INTERNAL", detail: String((error && error.message) || error) })
  );
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== L.ALARM_TIMER_END) return;
  ignore(reconcileTimer());
});

chrome.tabs.onRemoved.addListener(onTabOrWindowClosed);

chrome.windows.onRemoved.addListener(onTabOrWindowClosed);

chrome.tabs.onUpdated.addListener(() => {
  ignore(touch(Date.now(), false));
});

chrome.notifications.onClicked.addListener((id) => {
  try {
    ignore(chrome.notifications.clear(id));
  } catch (e) {
    console.error("Failed to clear notification: ", e)
  }
  ignore(acknowledgeLastSession());
});

// every wake-up of the worker: badge + alarm resync
ignore(initOnWake());
