/* Lock In — content script.
   Reads state straight out of chrome.storage and decides locally whether this
   page should be blocked. The service worker is only ever asked to mutate. */

(async () => {
  "use strict";

  const L = globalThis.LockInLib;
  if (!L) return;

  const HOST_TAG = "lock-in-overlay";
  const TICK_MS = 1000;

  /* Styles forced onto the host element so page CSS (including `* { ... }`
     rules) can never hide, shrink or reposition the overlay. */
  const HOST_STYLE = {
    position: "fixed",
    top: "0px",
    right: "0px",
    bottom: "0px",
    left: "0px",
    width: "100%",
    height: "100%",
    "max-width": "none",
    "max-height": "none",
    margin: "0px",
    padding: "0px",
    border: "0px",
    display: "block",
    visibility: "visible",
    opacity: "1",
    transform: "none",
    filter: "none",
    "clip-path": "none",
    "pointer-events": "auto",
    "z-index": "2147483647",
  };

  /* Used only if modal.html / modal.css cannot be fetched, so a broken
     resource load can never turn into a silently unblocked page. */
  const FALLBACK_HTML = `
    <div class="lockin-backdrop">
      <div class="lockin-card" role="dialog" aria-modal="true">
        <h1 class="lockin-title">You're supposed to be LOCKED IN.</h1>
        <p class="lockin-copy">This page isn't on your list. The clock is still running, twin.</p>
        <div class="lockin-actions">
          <button class="lockin-btn lockin-btn--primary" type="button" data-action="close-tab">You Right</button>
          <div class="lockin-actions-row">
            <button class="lockin-btn" type="button" data-action="allow-url">Allow Webpage</button>
            <button class="lockin-btn" type="button" data-action="allow-domain">Allow Domain</button>
            <button class="lockin-btn" type="button" data-action="pause">Just 1 Time</button>
          </div>
        </div>
      </div>
    </div>`;

  const FALLBACK_CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .lockin-backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px;
      background: rgba(8,8,12,.92); color: #f2f2f6; text-align: left;
      font: 400 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
    .lockin-card { width: 100%; max-width: 460px; padding: 28px; border-radius: 18px; background: #15151d;
      border: 1px solid rgba(255,255,255,.1); }
    .lockin-title { margin-bottom: 12px; font-size: 26px; font-weight: 800; line-height: 1.15; }
    .lockin-copy { margin-bottom: 22px; font-size: 15px; color: #9c9cb0; }
    .lockin-actions { display: flex; flex-direction: column; gap: 10px; }
    .lockin-actions-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .lockin-btn { width: 100%; min-height: 44px; padding: 12px 14px; border: 1px solid rgba(255,255,255,.12);
      border-radius: 11px; background: #232330; color: #e6e6ee; font-family: inherit; font-size: 13px;
      font-weight: 600; cursor: pointer; }
    .lockin-btn--primary { min-height: 52px; border-color: #ff5c3a; background: #ff5c3a; color: #1a0a06;
      font-size: 16px; font-weight: 800; }`;

  let template = null;
  let host = null;
  let showing = false;
  let savedOverflow = null;
  let lastHref = location.href;

  async function fetchResource(name) {
    const response = await fetch(chrome.runtime.getURL(name));
    if (!response.ok) throw new Error(`${name} ${response.status}`);
    return response.text();
  }

  async function loadTemplate() {
    if (template) return template;
    try {
      const [html, css] = await Promise.all([
        fetchResource("modal.html"),
        fetchResource("modal.css"),
      ]);
      template = { html, css };
    } catch {
      template = { html: FALLBACK_HTML, css: FALLBACK_CSS };
    }
    return template;
  }

  async function readState() {
    try {
      const data = await chrome.storage.local.get([L.KEY_SESSION, L.KEY_ALLOWLIST]);
      return {
        session: data[L.KEY_SESSION] || null,
        allowlist: data[L.KEY_ALLOWLIST] || [],
      };
    } catch {
      return null;
    }
  }

  function shouldBlock(session, allowlist, url) {
    if (!session) return false;
    return (
      L.isBlockableUrl(url) &&
      L.isBlockingActive(session) &&
      !L.isUrlAllowed(url, allowlist, session.tagScope)
    );
  }

  /* The single decision point. Everything else just calls this. */
  async function evaluate() {
    const state = await readState();
    if (!state) return;
    if (shouldBlock(state.session, state.allowlist, location.href)) showModal();
    else hideModal();
  }

  function lockScroll() {
    const root = document.documentElement;
    if (!root) return;
    savedOverflow = root.style.overflow;
    root.style.overflow = "hidden";
  }

  function unlockScroll() {
    const root = document.documentElement;
    if (root && savedOverflow !== null) root.style.overflow = savedOverflow;
    savedOverflow = null;
  }

  function buildShadow(shadow) {
    const style = document.createElement("style");
    style.textContent = template.css;
    shadow.appendChild(style);

    // DOMParser + importNode instead of innerHTML: sites with Trusted Types
    // enabled throw on any innerHTML assignment.
    const parsed = new DOMParser().parseFromString(template.html, "text/html");
    const fragment = document.createDocumentFragment();
    for (const node of Array.from(parsed.body.childNodes)) {
      fragment.appendChild(document.importNode(node, true));
    }
    shadow.appendChild(fragment);
  }

  function showModal() {
    if (showing) {
      ensureAttached();
      return;
    }
    showing = true;

    host = document.createElement(HOST_TAG);
    for (const [prop, value] of Object.entries(HOST_STYLE)) {
      host.style.setProperty(prop, value, "important");
    }

    const shadow = host.attachShadow({ mode: "closed" });
    buildShadow(shadow);
    shadow.addEventListener("click", onShadowClick, true);

    if (document.documentElement) document.documentElement.appendChild(host);
    lockScroll();
  }

  function hideModal() {
    if (!showing) return;
    showing = false;
    if (host) host.remove();
    host = null;
    unlockScroll();
  }

  /* Watchdog: some pages wipe or replace documentElement's children. */
  function ensureAttached() {
    if (showing && host && !host.isConnected && document.documentElement) {
      document.documentElement.appendChild(host);
    }
  }

  function onShadowClick(event) {
    const target = event.target;
    const button = target instanceof Element ? target.closest("[data-action]") : null;
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    onAction(button.getAttribute("data-action"));
  }

  function messageFor(action) {
    switch (action) {
      case "close-tab":
        return { type: "CLOSE_TAB" };
      case "allow-url":
        return { type: "ALLOW_URL", url: location.href };
      case "allow-domain":
        return { type: "ALLOW_DOMAIN", url: location.href };
      case "pause":
        return { type: "PAUSE_SESSION" };
      default:
        return null;
    }
  }

  /* Buttons never touch the DOM themselves: mutate, then re-decide. */
  async function onAction(action) {
    const message = messageFor(action);
    if (!message) return;
    const response = await send(message);
    // CLOSE_TAB legitimately never answers — the tab is gone first.
    if (response && response.ok) evaluate();
  }

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      // Extension reloaded / service worker gone: stay quiet, keep the page usable.
      return null;
    }
  }

  function tick() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      evaluate();
      return;
    }
    ensureAttached();
  }

  function wire() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      // Ignore everything else, notably the heartbeat key the SW writes often.
      if (!(L.KEY_SESSION in changes) && !(L.KEY_ALLOWLIST in changes)) return;
      evaluate();
    });

    window.addEventListener("popstate", evaluate);
    window.addEventListener("hashchange", evaluate);
    window.addEventListener("pageshow", evaluate);
    document.addEventListener("visibilitychange", evaluate);

    setInterval(tick, TICK_MS);
  }

  await loadTemplate();
  wire();
  evaluate();
})();
