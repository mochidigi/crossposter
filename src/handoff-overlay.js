// Covers a destination tab while Crossposter fills its composer, so the
// site's own loading and the automated steps stay out of sight. It starts
// with the document (registered at document_start, top frame only), asks the
// background whether this tab is being filled, and follows its updates until
// the destination is ready or has failed. It lists every destination of the
// crosspost with the same rows as Compose's status panel and the sidebar
// (handoffNetworkStatuses), so each tab that comes to the front looks the
// same. The page underneath keeps working; the overlay only takes clicks, and
// "Show the page" dismisses it.
(() => {
  if (globalThis.__crossposterHandoffOverlay) return;
  globalThis.__crossposterHandoffOverlay = true;
  const runtime = globalThis.browser.runtime;
  let host = null, title = null, list = null, dismissed = false, rootStyle = null, shown = 0;
  // Remembered in the tab's sessionStorage, so a page that reloads during its
  // turn (X in Chrome) is covered from the first frame, before the background
  // has answered.
  const FLAG = "crossposter-handoff-overlay";
  const dark = () => Boolean(globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches);

  // Until the site's own CSS loads, a page paints the browser's blank white.
  // Give the root the overlay's colour instead, while the overlay is up.
  function coverRoot() {
    const root = document.documentElement;
    if (!root || rootStyle) return;
    rootStyle = ["background-color", "color-scheme"].map(name => [name, root.style.getPropertyValue(name), root.style.getPropertyPriority(name)]);
    root.style.setProperty("background-color", dark() ? "#121211" : "#f4f4f1", "important");
    root.style.setProperty("color-scheme", dark() ? "dark" : "light", "important");
  }

  function uncoverRoot() {
    const root = document.documentElement;
    if (!root || !rootStyle) return;
    for (const [name, value, priority] of rootStyle) {
      if (value) root.style.setProperty(name, value, priority); else root.style.removeProperty(name);
    }
    rootStyle = null;
  }

  function remember(on) {
    try { if (on) sessionStorage.setItem(FLAG, "1"); else sessionStorage.removeItem(FLAG); } catch {}
  }

  function build() {
    host = document.createElement("crossposter-handoff-overlay");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
          --ink: #111; --muted: #626262; --line: #c8c8c3; --surface: #fff; --current: #f4f4f1; --tile: #fff;
          --done: #147a3d; --action: #8a5300; --error: #a12424;
          color: var(--ink); background: rgb(244 244 241 / .96); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
        .card { display: grid; gap: 14px; width: min(420px, calc(100vw - 48px)); padding: 24px; border: 1px solid var(--line); background: var(--surface); }
        .title { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -.01em; }
        .rows { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
        .row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--line); }
        .row.current { border-color: var(--ink); background: var(--current); }
        /* Network logos are drawn for a light background, so they sit on a light tile in both themes (as in Compose and the sidebar). */
        .icon { display: grid; width: 28px; height: 28px; box-sizing: border-box; place-items: center; border: 1px solid var(--line); background: var(--tile); }
        .icon img { display: block; width: 18px; height: 18px; object-fit: contain; }
        .name { overflow: hidden; font-size: 14px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
        .state { display: flex; align-items: center; justify-content: flex-end; gap: 7px; color: var(--muted); font-size: 13px; text-align: right; }
        .row.current .state { color: var(--ink); font-weight: 600; }
        .state::before { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--muted); content: ""; }
        .tone-done .state::before { background: var(--done); }
        .tone-action .state::before { background: var(--action); }
        .tone-error .state::before { background: var(--error); }
        .tone-progress.current .state::before { width: 10px; height: 10px; border: 2px solid currentColor; border-top-color: transparent; background: transparent; animation: spin .9s linear infinite; }
        .note { margin: 0; color: var(--muted); font-size: 13px; }
        .show { justify-self: start; padding: 4px 0; border: 0; color: var(--muted); background: none; font: inherit; font-size: 13px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
        @media (prefers-color-scheme: dark) {
          :host { --ink: #f0f0eb; --muted: #a8a8a2; --line: #4b4b48; --surface: #1c1c1b; --current: #2b2b29; --tile: #f0f0eb;
            --done: #4fbf7a; --action: #f0b45a; --error: #ff8f84; background: rgb(18 18 17 / .96); }
        }
        @keyframes spin { to { transform: rotate(1turn); } }
        @media (prefers-reduced-motion: reduce) { .tone-progress.current .state::before { animation-duration: 2.4s; } }
      </style>
      <div class="card">
        <p class="title" role="status" aria-live="polite"></p>
        <ul class="rows"></ul>
        <p class="note">Crossposter is filling in your post. You review each one before anything is posted.</p>
        <button class="show" type="button">Show the page</button>
      </div>`;
    title = root.querySelector(".title");
    list = root.querySelector(".rows");
    root.querySelector(".show").onclick = () => { dismissed = true; remove(); };
    (document.documentElement || document).append(host);
  }

  function row({ label, icon, text, tone, current }) {
    const item = document.createElement("li");
    item.className = `row tone-${tone || "progress"}${current ? " current" : ""}`;
    if (current) item.setAttribute("aria-current", "step");
    const tile = document.createElement("span");
    tile.className = "icon";
    const image = document.createElement("img");
    image.alt = ""; image.src = icon || "";
    tile.append(image);
    const name = document.createElement("span");
    name.className = "name"; name.textContent = label || "";
    const state = document.createElement("span");
    state.className = "state"; state.textContent = text || "";
    item.append(tile, name, state);
    return item;
  }

  function show(state) {
    if (dismissed) return;
    if (!host) build();
    if (!host.isConnected) (document.documentElement || document).append(host);
    coverRoot(); remember(true);
    title.textContent = state.title || "Filling composers…";
    list.replaceChildren(...(state.rows || []).map(row));
  }

  function remove() {
    host?.remove();
    host = null;
    uncoverRoot(); remember(false);
  }

  // States can arrive out of order; apply only ones newer than the last.
  const apply = state => {
    if (Number(state?.sequence) < shown) return;
    shown = Number(state?.sequence) || shown;
    if (state?.active) show(state); else remove();
  };
  const ask = () => {
    try { runtime.sendMessage({ type: "GET_HANDOFF_OVERLAY" }).then(apply).catch(() => {}); } catch {}
  };
  runtime.onMessage.addListener(message => {
    if (message?.type === "HANDOFF_OVERLAY") apply(message);
    // Crossposter's own waiting page (handoff-wait.html) isn't reached by
    // tabs.sendMessage; it follows the session broadcast instead.
    if (message?.type === "CROSSPOST_SESSIONS_UPDATED" && location.protocol.endsWith("-extension:")) ask();
  });
  let remembered = false;
  try { remembered = sessionStorage.getItem(FLAG) === "1"; } catch {}
  if (remembered) show({});
  ask();
})();
