"use strict";

/**
 * background.js — the Lock In service worker.
 *
 * Invariants:
 *  - This is the ONLY writer of session state. Everything lives in
 *    chrome.storage.local; there is no mutable module-scope session state,
 *    because the worker can be evicted between any two events.
 *  - Elapsed time is always derived from stored timestamps (lib.js), never
 *    from setInterval.
 *  - Every state mutation runs inside withWriteLock() so concurrent messages
 *    cannot interleave a read-modify-write.
 */

importScripts("lib.js");

const L = globalThis.LockInLib;

const NOTIFICATION_ID = "lockin-timer-done";
const TAB_RECHECK_MS = 750; // second sample for the all-tabs-closed check
const HEARTBEAT_THROTTLE_MS = 5000;

const BADGE = {
  active: { text: "ON", color: "#1e8e3e" },
  paused: { text: "II", color: "#f9ab00" },
  done: { text: "DONE", color: "#1a73e8" },
};

// --- Small helpers ---------------------------------------------------------

function ignore(maybePromise) {
  if (maybePromise && typeof maybePromise.catch === "function") {
    maybePromise.catch(() => {});
  }
  return maybePromise;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Storage ---------------------------------------------------------------

function coerceStoredSession(raw) {
  if (
    raw &&
    typeof raw === "object" &&
    (raw.status === "idle" || raw.status === "active" || raw.status === "paused")
  ) {
    return raw;
  }
  return L.idleSession();
}

async function readState() {
  let data = {};
  try {
    data = await chrome.storage.local.get([
      L.KEY_SESSION,
      L.KEY_ALLOWLIST,
      L.KEY_LAST,
      L.KEY_HEARTBEAT,
    ]);
  } catch (_e) {
    data = {};
  }
  return {
    session: coerceStoredSession(data[L.KEY_SESSION]),
    allowlist: Array.isArray(data[L.KEY_ALLOWLIST]) ? data[L.KEY_ALLOWLIST] : [],
    lastSession: data[L.KEY_LAST] || null,
    heartbeat: data[L.KEY_HEARTBEAT] || null,
  };
}

async function writeState(patch) {
  try {
    await chrome.storage.local.set(patch);
  } catch (_e) {
    /* storage unavailable — nothing useful to do in a worker */
  }
}

/**
 * Heartbeat: "the browser was alive at this instant". Written to its own key
 * so popup/content onChanged listeners can ignore it, and used to date the
 * end of a stopwatch that died with the browser.
 */
let lastTouchAt = 0;
function touch(now, force) {
  const stamp = typeof now === "number" ? now : Date.now();
  if (!force && stamp - lastTouchAt < HEARTBEAT_THROTTLE_MS) return Promise.resolve();
  lastTouchAt = stamp;
  return writeState({ [L.KEY_HEARTBEAT]: { lastSeenAt: stamp } });
}

// --- Write lock ------------------------------------------------------------

let writeChain = Promise.resolve();

/** Serializes read-modify-write tasks. Returns the task's own result. */
function withWriteLock(task) {
  const result = writeChain.then(() => task());
  writeChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// --- Badge / alarm / notification ------------------------------------------

async function syncBadge() {
  const { session, lastSession } = await readState();
  let badge = null;
  if (session.status === "active") badge = BADGE.active;
  else if (session.status === "paused") badge = BADGE.paused;
  else if (lastSession && lastSession.reason === "timer_expired" && !lastSession.acknowledged) {
    badge = BADGE.done;
  }

  try {
    if (!badge) {
      await chrome.action.setBadgeText({ text: "" });
      return;
    }
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  } catch (_e) {
    /* action API unavailable (e.g. during shutdown) */
  }
}

/**
 * Marks the "timer finished" record as seen, which is what clears the DONE
 * badge. Persisted (rather than just calling setBadgeText("")) so a later
 * syncBadge() on a worker wake-up cannot resurrect a dismissed badge.
 * No-op unless there is an unacknowledged expiry to acknowledge.
 */
function acknowledgeLastSession() {
  return withWriteLock(async () => {
    const { lastSession } = await readState();
    if (!lastSession || lastSession.reason !== "timer_expired" || lastSession.acknowledged) return;
    await writeState({ [L.KEY_LAST]: { ...lastSession, acknowledged: true } });
    await syncBadge();
  });
}

async function clearTimerAlarm() {
  try {
    await chrome.alarms.clear(L.ALARM_TIMER_END);
  } catch (_e) {
    /* ignore */
  }
}

/** Arms (or clears) the expiry alarm to match the session. */
async function armTimerAlarm(session) {
  await clearTimerAlarm();
  const endsAt = L.computeEndsAt(session);
  if (endsAt === null) return;
  try {
    // A `when` in the past fires immediately, which is exactly what we want
    // after the worker was evicted past a timer's end.
    await chrome.alarms.create(L.ALARM_TIMER_END, { when: endsAt });
  } catch (_e) {
    /* ignore */
  }
}

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
  } catch (_e) {
    /* notifications can be disabled by the OS */
  }
}

// --- Transitions (all callers must hold the write lock) --------------------

/**
 * Ends `session` at `endedAt`, writes the LastSession record, clears the
 * alarm and resyncs the badge. Caller holds the write lock.
 */
async function finalize(session, endedAt, reason, notify) {
  const result = L.stopSession(session, endedAt, reason);
  if (result.error) return { ok: false, error: result.error };

  await writeState({
    [L.KEY_SESSION]: result.session,
    [L.KEY_LAST]: result.lastSession,
  });
  await clearTimerAlarm();
  if (notify) notifyTimerDone(result.lastSession.elapsedMs);
  await syncBadge();
  return { ok: true, session: result.session, lastSession: result.lastSession };
}

function doStart(mode, durationMs, tagScope) {
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

function doStop() {
  return withWriteLock(async () => {
    const now = Date.now();
    const { session } = await readState();
    return finalize(session, now, "manual", false);
  });
}

// --- Allowlist mutations ---------------------------------------------------

function doAddEntry(entryType, value) {
  return withWriteLock(async () => {
    const now = Date.now();
    const { allowlist } = await readState();
    const result = L.addEntry(allowlist, entryType, value, now);
    if (result.error) return { ok: false, error: result.error };

    await writeState({ [L.KEY_ALLOWLIST]: result.allowlist });
    return { ok: true, entry: result.entry, allowlist: result.allowlist };
  });
}

/** ALLOW_URL / ALLOW_DOMAIN from the modal: idempotent, duplicates are fine. */
function doAllow(entryType, url) {
  return withWriteLock(async () => {
    const now = Date.now();
    const { allowlist } = await readState();
    const result = L.addEntry(allowlist, entryType, url, now);
    if (result.error === "DUPLICATE") {
      return { ok: true, entry: null, allowlist, duplicate: true };
    }
    if (result.error) return { ok: false, error: result.error };

    await writeState({ [L.KEY_ALLOWLIST]: result.allowlist });
    return { ok: true, entry: result.entry, allowlist: result.allowlist };
  });
}

function doUpdateEntry(id, entryType, value, tag) {
  return withWriteLock(async () => {
    const now = Date.now();
    const { allowlist } = await readState();
    const result = L.updateEntry(allowlist, id, entryType, value, now, tag);
    if (result.error) return { ok: false, error: result.error };

    await writeState({ [L.KEY_ALLOWLIST]: result.allowlist });
    return { ok: true, entry: result.entry, allowlist: result.allowlist };
  });
}

function doDeleteEntry(id) {
  return withWriteLock(async () => {
    const { allowlist } = await readState();
    const result = L.deleteEntry(allowlist, id);
    if (result.error) return { ok: false, error: result.error };

    await writeState({ [L.KEY_ALLOWLIST]: result.allowlist });
    return { ok: true, allowlist: result.allowlist };
  });
}

async function doCloseTab(sender) {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (typeof tabId !== "number") return { ok: false, error: "NO_TAB" };
  try {
    await chrome.tabs.remove(tabId);
    return { ok: true };
  } catch (_e) {
    return { ok: false, error: "NO_TAB" };
  }
}

// --- Reconcilers -----------------------------------------------------------

/**
 * Finalizes an expired timer (with notification) or re-arms the alarm if the
 * timer is still running. Safe to call from anywhere, any number of times.
 */
function reconcileTimer() {
  return withWriteLock(async () => {
    const now = Date.now();
    const { session } = await readState();

    if (L.isExpired(session, now)) {
      const endsAt = L.computeEndsAt(session);
      return finalize(session, endsAt === null ? now : endsAt, "timer_expired", true);
    }
    if (session.status === "active" && session.mode === "timer") {
      await armTimerAlarm(session);
    }
    return { ok: true, session };
  });
}

/**
 * onStartup only — the one place allowed to finalize a stale session.
 *  - active stopwatch  -> ended at the last heartbeat, reason "browser_restart"
 *  - expired timer     -> finalized at its end time + late notification
 *  - unexpired timer   -> keeps running, alarm re-armed
 *  - paused session    -> untouched
 */
function reconcileOnBoot() {
  return withWriteLock(async () => {
    const now = Date.now();
    const { session, heartbeat } = await readState();

    if (session.status === "active") {
      if (session.mode === "timer") {
        const endsAt = L.computeEndsAt(session);
        if (endsAt !== null && endsAt <= now) {
          await finalize(session, endsAt, "timer_expired", true);
        } else {
          await armTimerAlarm(session);
        }
      } else {
        const seenAt =
          heartbeat && typeof heartbeat.lastSeenAt === "number" ? heartbeat.lastSeenAt : now;
        const startedAt = typeof session.startedAt === "number" ? session.startedAt : 0;
        const endedAt = Math.min(now, Math.max(seenAt, startedAt));
        await finalize(session, endedAt, "browser_restart", false);
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
  } catch (_e) {
    return -1; // unknown: never treat an error as "no tabs left"
  }
}

/**
 * Ends an active stopwatch once every tab is gone. Double-sampled ~750 ms
 * apart so dragging the last tab into a new window does not end the session.
 */
async function checkAllTabsClosed() {
  if ((await countTabs()) !== 0) return;
  await sleep(TAB_RECHECK_MS);
  if ((await countTabs()) !== 0) return;

  await withWriteLock(async () => {
    const now = Date.now();
    const { session } = await readState();
    if (session.status !== "active" || session.mode !== "stopwatch") return;
    await finalize(session, now, "all_tabs_closed", false);
  });
}

/**
 * Runs on every worker wake-up. Resyncs the badge and the alarm ONLY — it
 * must never finalize anything, because a wake-up says nothing about how
 * long the worker was asleep.
 */
async function initOnWake() {
  try {
    const { session } = await readState();
    if (session.status === "active" && session.mode === "timer") {
      await armTimerAlarm(session);
    }
    await syncBadge();
  } catch (_e) {
    /* ignore */
  }
}

// --- Message router --------------------------------------------------------

async function handleMessage(message, sender) {
  const type = message && message.type;
  switch (type) {
    case "GET_STATE": {
      await reconcileTimer();
      // Opening the popup is how the user "sees" a finished timer, so this is
      // where the DONE badge is dismissed — before the state we hand back is
      // read, so the response already carries acknowledged: true.
      await acknowledgeLastSession();
      const { session, allowlist, lastSession } = await readState();
      return { ok: true, session, allowlist, lastSession };
    }
    case "START_SESSION":
      return doStart(message.mode, message.durationMs, message.tagScope);
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
      return doAllow("url", message.url);
    case "ALLOW_DOMAIN":
      return doAllow("domain", message.url);
    case "CLOSE_TAB":
      return doCloseTab(sender);
    default:
      return { ok: false, error: "INVALID_VALUE" };
  }
}

// --- Listeners -------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  ignore(
    withWriteLock(async () => {
      let data = {};
      try {
        data = await chrome.storage.local.get([
          L.KEY_SESSION,
          L.KEY_ALLOWLIST,
          L.KEY_LAST,
          L.KEY_HEARTBEAT,
        ]);
      } catch (_e) {
        data = {};
      }
      const patch = {};
      if (!Array.isArray(data[L.KEY_ALLOWLIST])) patch[L.KEY_ALLOWLIST] = [];
      if (!data[L.KEY_SESSION]) patch[L.KEY_SESSION] = L.idleSession();
      if (!(L.KEY_LAST in data)) patch[L.KEY_LAST] = null;
      if (!data[L.KEY_HEARTBEAT]) patch[L.KEY_HEARTBEAT] = { lastSeenAt: Date.now() };
      if (Object.keys(patch).length > 0) await writeState(patch);
      await syncBadge();
    })
  );
});

chrome.runtime.onStartup.addListener(() => {
  ignore(reconcileOnBoot());
});

// MV3: the listener must return `true` and call sendResponse from a .then().
// Returning a Promise from the listener silently drops the response.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(
    (response) => {
      try {
        sendResponse(response || { ok: false, error: "INTERNAL" });
      } catch (_e) {
        /* port closed */
      }
    },
    (error) => {
      try {
        sendResponse({ ok: false, error: "INTERNAL", detail: String((error && error.message) || error) });
      } catch (_e) {
        /* port closed */
      }
    }
  );
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== L.ALARM_TIMER_END) return;
  ignore(reconcileTimer());
});

chrome.tabs.onRemoved.addListener(() => {
  ignore(touch(Date.now(), true));
  ignore(checkAllTabsClosed());
});

chrome.windows.onRemoved.addListener(() => {
  ignore(touch(Date.now(), true));
  ignore(checkAllTabsClosed());
});

chrome.tabs.onUpdated.addListener(() => {
  ignore(touch(Date.now(), false));
});

chrome.notifications.onClicked.addListener((id) => {
  try {
    ignore(chrome.notifications.clear(id));
  } catch (_e) {
    /* ignore */
  }
  ignore(acknowledgeLastSession());
});

// Every wake-up of the worker: badge + alarm resync, never a finalization.
ignore(initOnWake());
