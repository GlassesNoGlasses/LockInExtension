
# ![lock-in](./icon32.png) Lock In Extension
Chrome Store Status: Pending

### This ever happen to you? 

![doomscroll](https://media.tenor.com/Xm1L7-otNRwAAAAM/pengu-pudgy.gif) ... then it's 3 am.

You know exactly how it goes. You open your laptop to do one thing, and 45 minutes later you're 3 YouTube videos, 5 reddit posts, 13 TikTok's deep. You need to focus. You need to Lock In.

Hit "Start" and you're locked in: stopwatch if you're built different, timer if you need a deadline (1 minute to 24 hours, whatever works for you). While a session's running, every site that's not on your "allowlist" gets bodied with in bold text "You're supposed to be LOCKED IN." No scrolling past it. But there's 4 ways out:

✅ "You Right": closes the tab. The correct answer.
🧐 "Allow Webpage" / "Allow Domain": maybe you actually need this one site/domain. It gets added to your allowlist with full access.
🙏 "Just 1 Time": pauses the whole session. You get access, but at what cost?

Control what you can access by adding whole domains or single pages. Add color-tags for custom groupings when starting a session, or keep it untagged for all-inclusive. It's easy to get distracted, let's make it easier to stay on tack.

🫡🫡 Lock in twin. We got this. 🫡🫡

## Manual Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repository folder.
4. Pin the extension so the badge is visible: puzzle icon -> pin **Lock In**.
5. Click the icon to open the popup, add a couple of allowlist entries, and press **Start**.

`google.com` and all of its subdomains (docs.google.com, mail.google.com, …) are always allowed. This is built into the extension (`BUILTIN_DOMAINS` in `lib.js`) so you can still search in chrome.

After editing any file, hit the **Reload** (circular arrow) button on the extension's card at `chrome://extensions`. Service-worker logs live behind the card's **service worker** link.

Badge states: no badge (idle), `ON` (locked in), `II` (paused), `DONE` (a timer just finished — click the notification to clear it).
