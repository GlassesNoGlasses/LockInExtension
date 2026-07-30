
# Lock In Extension

A Chrome (MV3) focus extension. Keep an allowlist of the sites you're actually
allowed to be on, start a stopwatch or a countdown timer, and every disallowed
page gets a full-page guilt trip until you close it, allow it, or pause.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repository folder.
4. Pin the extension so the badge is visible: puzzle icon -> pin **Lock In**.
5. Click the icon to open the popup, add a couple of allowlist entries, and
   press **Start**.

`google.com` and all of its subdomains (docs.google.com, mail.google.com, …)
are always allowed. This is built into the extension (`BUILTIN_DOMAINS` in
`lib.js`) rather than stored in the allowlist, so it does not appear in the
popup and cannot be edited or deleted.

After editing any file, hit the **Reload** (circular arrow) button on the
extension's card at `chrome://extensions`. Service-worker logs live behind the
card's **service worker** link.

Badge states: no badge (idle), `ON` (locked in), `II` (paused), `DONE` (a timer
just finished — click the notification to clear it).

## Running the tests

No dependencies and no build step; the tests use Node's built-in runner
(Node 22+):

```sh
node --test        # or: npm test
```

`lib.js` holds all of the pure logic (URL normalization, domain matching,
allowlist CRUD, session state machine, time math, formatting) and is covered by
`tests/lib.test.js`. It never touches the `chrome` namespace and never reads the
clock itself — callers pass `now` — so everything about it is deterministic.

## Known limitations

- **`chrome://` pages, the Chrome Web Store and other extension pages cannot be
  blocked.** Chrome forbids content scripts there, so no modal can appear. This
  is a platform restriction, not a bug.
- **SPA navigation is detected within ~1 second.** In-app route changes (e.g.
  clicking through YouTube) are caught by a 1 s poll, so the modal can lag a
  beat behind the URL change.
- **URL entries match their query string exactly.** `…/watch?v=abc` and
  `…/watch?v=abc&t=30` are different entries; the fragment (`#…`) is ignored and
  a trailing slash is normalized away. Allow the whole domain if you want
  everything under it.
- **System clock changes are not defended against.** Elapsed time is derived
  from stored timestamps, so moving the clock forward or back will skew a
  running session (values are clamped so they can never go negative).
- **The icon is the 16 px starter PNG.** Chrome scales it up for the timer-done
  notification, which looks soft. Drop a 128x128 PNG in and point
  `manifest.json`'s `default_icon` plus the notification `iconUrl` in
  `background.js` at it for a crisper result.
