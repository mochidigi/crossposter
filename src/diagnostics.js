// Page diagnostics for problem reports. The background injects this file only
// when it needs it: to check whether a destination tab that showed no
// composer is a sign-in page, and when the user chooses to report a failed
// handoff. It never runs on its own and sends nothing anywhere.
//
// The page outline keeps what selectors need (element names, ids, classes,
// roles, data-testid and other attribute hooks, SVG icon geometry, link
// patterns) and removes what identifies a person: every text node and
// free-text attribute is masked to placeholder characters, URLs keep only
// their site and route words, form values, scripts, styles, inline styles,
// and srcsets are dropped, and long numbers and token-like strings are
// replaced.
(() => {
  const MAX_CHARS = 250_000, MAX_ELEMENTS = 15_000, MAX_TEXT = 60, MAX_VALUE = 200, MAX_GEOMETRY = 300;
  const DROPPED_ELEMENTS = new Set(["script", "style", "noscript", "template", "link", "meta", "head", "base", "object", "embed"]);
  const VOID_ELEMENTS = new Set(["area", "br", "col", "embed", "hr", "img", "input", "source", "track", "wbr"]);
  // Shown as an empty element: their content is cross-origin, binary, or the
  // user's own media.
  const OPAQUE_ELEMENTS = new Set(["iframe", "canvas", "video", "audio", "picture"]);
  const TEXT_ATTRIBUTES = new Set(["aria-label", "aria-description", "aria-roledescription", "aria-placeholder", "aria-valuetext", "aria-keyshortcuts", "title", "alt", "placeholder", "label", "data-placeholder", "data-tooltip", "data-text"]);
  const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "xlink:href", "data-href", "data-src"]);
  const GEOMETRY_ATTRIBUTES = new Set(["d", "points", "transform", "viewbox", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "x2", "y1", "y2", "width", "height", "fill-rule", "clip-rule", "stroke-width"]);
  const KEPT_ATTRIBUTES = new Set(["id", "class", "role", "type", "name", "dir", "lang", "tabindex", "contenteditable", "spellcheck", "disabled", "hidden", "inert", "multiple", "accept", "autocomplete", "inputmode", "draggable", "open", "slot", "part", "componentkey", "for", "method", "target", "rel", "checked", "selected", "readonly", "required", "translate"]);
  // Attribute names that tend to carry a person's identity or a credential;
  // their values are always masked, whatever they look like.
  const SENSITIVE_NAME = /user|name|handle|mail|author|account|profile|owner|viewer|actor|token|csrf|session|auth|secret|key|cookie|nonce|tracking/i;
  // Path words that describe a route rather than a person or post.
  const ROUTE_WORDS = new Set(("home feed compose post posts status statuses photo photos video videos reel reels p i intent share messages notifications search explore " +
    "settings hashtag groups pages watch stories story create new notes note profile login signup flow in company school jobs mynetwork events lists bookmarks " +
    "communities premium help about privacy terms legal marketplace friends saved activity media likes replies following followers inbox chat direct accounts " +
    "edit emailsignup t tv live publication dashboard subscribe account recover checkpoint authwall uas overlay detail recent-activity articles pulse newsletters " +
    "preferences onboarding upload drafts discover trending topics feeds starter-pack moderation reply web sharing static assets images emoji").split(" "));

  function maskText(value, max = MAX_TEXT) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    const masked = text.replace(/[\p{L}\p{M}]/gu, "x").replace(/\p{N}/gu, "0");
    return masked.length > max ? `${masked.slice(0, max)}…` : masked;
  }

  function cleanToken(value, max = MAX_VALUE) {
    const text = String(value ?? "").slice(0, max * 2)
      .replace(/[A-Za-z0-9+/_=-]{24,}/g, match => /\d/.test(match) && /[A-Za-z]/.test(match) ? "{token}" : match)
      .replace(/\d{6,}/g, "{n}");
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function cleanPath(pathname = "") {
    const segments = String(pathname).split("/").map(segment => {
      if (!segment) return segment;
      let decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch {}
      const word = decoded.toLowerCase();
      if (decoded.startsWith("@")) return "@*";
      if (ROUTE_WORDS.has(word) || /^[\w-]+\.(?:php|html?)$/i.test(word) && ROUTE_WORDS.has(word.replace(/\.\w+$/, ""))) return word;
      return "*";
    });
    return segments.join("/") || "/";
  }

  // forEach rather than keys(): in a Firefox content script the iterator that
  // keys() returns is not iterable (FormData and Headers likewise), and the
  // TypeError ended collect() before its sign-in checks (2026-10-12).
  function queryNames(search = "") {
    const names = [];
    new URLSearchParams(String(search)).forEach((value, name) => names.push(cleanToken(name, 40)));
    return [...new Set(names)].slice(0, 12);
  }

  function cleanUrl(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    if (raw.startsWith("#")) return cleanToken(raw, 80);
    const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
    if (scheme === "data") return `data:${raw.slice(5).split(/[;,]/)[0].slice(0, 40)}`;
    if (scheme && !["http", "https"].includes(scheme)) return `${scheme}:`;
    let url;
    try { url = new URL(raw, globalThis.location?.href); }
    catch { return "{url}"; }
    const query = queryNames(url.search);
    const suffix = `${cleanPath(url.pathname)}${query.length ? `?${query.map(name => `${name}=*`).join("&")}` : ""}${url.hash ? "#*" : ""}`;
    return url.hostname === globalThis.location?.hostname ? suffix : `${url.protocol}//${url.hostname}${suffix === "/" ? "" : "/…"}`;
  }

  function cleanAttribute(name, value) {
    if (name.startsWith("on") || ["style", "srcset", "sizes", "value", "nonce", "integrity", "ping"].includes(name)) return null;
    if (URL_ATTRIBUTES.has(name)) return cleanUrl(value);
    if (TEXT_ATTRIBUTES.has(name)) return maskText(value);
    if (GEOMETRY_ATTRIBUTES.has(name)) return String(value ?? "").slice(0, MAX_GEOMETRY);
    if (name === "class") return cleanToken(value, 400);
    if (KEPT_ATTRIBUTES.has(name) || name.startsWith("aria-")) return cleanToken(value);
    if (name.startsWith("data-")) {
      if (SENSITIVE_NAME.test(name.slice(5)) && !/^data-test(?:id|-)/.test(name)) return "*";
      const token = cleanToken(value, 80);
      return /^[\w:.{}#/-]*$/.test(token) ? token : maskText(value);
    }
    return null;
  }

  function escapeAttribute(value) { return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"); }
  function escapeText(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
  function tagName(node) { return String(node?.localName || node?.tagName || "").toLowerCase(); }

  function attributesOf(node) {
    let markup = "";
    for (const attribute of Array.from(node.attributes || [])) {
      const name = String(attribute.name || "").toLowerCase();
      if (!/^[a-z][\w:.-]*$/.test(name)) continue;
      const value = cleanAttribute(name, attribute.value);
      if (value === null) continue;
      markup += value === "" ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`;
    }
    return markup;
  }

  function descendantCount(node) {
    try { return node.getElementsByTagName?.("*")?.length || 0; } catch { return 0; }
  }

  // Feeds repeat one large item hundreds of times. Two examples of each
  // repeated shape are enough to see its structure.
  function repeatSignature(node) {
    const role = node.getAttribute?.("role") || "";
    if (role === "dialog" || tagName(node) === "dialog" || descendantCount(node) < 40) return "";
    return [tagName(node), role, node.getAttribute?.("data-testid") || "", node.getAttribute?.("class") || ""].join("|");
  }

  function outline(roots, { maxChars = MAX_CHARS, maxElements = MAX_ELEMENTS, skip = [] } = {}) {
    const state = { parts: [], length: 0, elements: 0, truncated: false, skip: new Set(skip) };
    const emit = text => {
      if (state.truncated) return;
      if (state.length + text.length > maxChars) { state.truncated = true; return; }
      state.parts.push(text); state.length += text.length;
    };
    const children = parent => {
      const repeats = new Map();
      let omitted = 0;
      let nodes = [];
      try { nodes = Array.from(parent.childNodes || []); } catch { emit("<!-- children unreadable -->"); return; }
      for (const child of nodes) {
        if (state.truncated) return;
        // One node the page (or the browser's wrappers) won't let us read
        // must not cost the rest of the outline.
        try {
          const signature = child.nodeType === 1 ? repeatSignature(child) : "";
          if (signature) {
            const count = (repeats.get(signature) || 0) + 1;
            repeats.set(signature, count);
            if (count > 2) { omitted++; continue; }
          }
          visit(child);
        } catch { emit("<!-- unreadable node -->"); }
      }
      if (omitted) emit(`<!-- ${omitted} similar element${omitted === 1 ? "" : "s"} omitted -->`);
    };
    const visit = (node, root = false) => {
      if (state.truncated || !node) return;
      if (node.nodeType === 3) { const text = maskText(node.nodeValue); if (text) emit(escapeText(text)); return; }
      if (node.nodeType === 11) { children(node); return; }
      if (node.nodeType !== 1) return;
      const tag = tagName(node);
      if (!/^[a-z][\w.-]*$/.test(tag) || DROPPED_ELEMENTS.has(tag)) return;
      if (!root && state.skip.has(node)) { emit(`<!-- ${tag} outlined above -->`); return; }
      if (++state.elements > maxElements) { state.truncated = true; return; }
      emit(`<${tag}${attributesOf(node)}>`);
      if (VOID_ELEMENTS.has(tag)) return;
      if (!OPAQUE_ELEMENTS.has(tag)) {
        if (node.shadowRoot) { emit("<shadow-root>"); children(node.shadowRoot); emit("</shadow-root>"); }
        children(node);
      }
      emit(`</${tag}>`);
    };
    roots.forEach((root, index) => {
      if (index) emit("\n");
      visit(root, true);
    });
    const html = state.parts.join("");
    return { snapshot: state.truncated ? `${html}\n<!-- outline truncated -->` : html, elements: Math.min(state.elements, maxElements), truncated: state.truncated };
  }

  function isVisible(element) {
    return Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects?.().length));
  }

  function visibleDialogs() {
    const dialogs = [...document.querySelectorAll("[role='dialog'], [role='alertdialog'], dialog[open], [aria-modal='true']")].filter(isVisible);
    return dialogs.filter(dialog => !dialogs.some(other => other !== dialog && other.contains(dialog)));
  }

  function hasVisiblePasswordField() {
    return [...document.querySelectorAll("input[type='password'], input[autocomplete='current-password']")].some(isVisible);
  }

  // Signed-out pages link to their sign-in or sign-up route (Threads shows
  // only a localized "Log in" button). The caller passes the route pattern so
  // it lives in one place (SIGN_IN_PATH in shared/feedback.js).
  function hasVisibleSignInLink(pattern) {
    let expression;
    try { expression = pattern ? new RegExp(pattern, "i") : null; } catch { return false; }
    if (!expression) return false;
    return [...document.querySelectorAll("a[href]")].some(anchor => {
      if (!isVisible(anchor)) return false;
      try {
        const url = new URL(anchor.getAttribute("href"), location.href);
        return url.hostname === location.hostname && expression.test(url.pathname);
      } catch { return false; }
    });
  }

  function collect({ snapshot = true, maxChars = MAX_CHARS, signInPattern = "" } = {}) {
    const dialogs = visibleDialogs();
    const result = {
      page: {
        host: location.hostname,
        path: cleanPath(location.pathname),
        query: queryNames(location.search),
        lang: document.documentElement?.lang || "",
        dir: document.documentElement?.dir || "",
        readyState: document.readyState,
        viewport: `${globalThis.innerWidth || 0}x${globalThis.innerHeight || 0}`,
        topFrame: globalThis.top === globalThis,
        dialogs: dialogs.length
      },
      passwordField: hasVisiblePasswordField(),
      signInLink: hasVisibleSignInLink(signInPattern)
    };
    if (snapshot) {
      const outlined = outline([...dialogs, document.body].filter(Boolean), { maxChars, skip: dialogs });
      result.snapshot = outlined.snapshot;
      result.snapshotStats = { elements: outlined.elements, chars: outlined.snapshot.length, truncated: outlined.truncated };
    }
    return result;
  }

  globalThis.CrossposterDiagnostics = Object.freeze({ collect, outline, maskText, cleanToken, cleanPath, cleanUrl, cleanAttribute });
})();
