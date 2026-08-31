(() => {
  const runtime = (globalThis.browser ?? globalThis.chrome).runtime;
  try { globalThis.CrossposterContent?.dispose?.(); } catch {}
  document.querySelectorAll?.("[data-crossposter-inline-action], [data-crossposter-menu-action]").forEach(node => node.remove());
  document.querySelector?.("#crossposter-inline-action-styles")?.remove();

  const adapters = [];
  let lastContextTarget = document.activeElement;
  let nativePostAttempt = 0;
  let postedMarkerObserver = null;
  let applyingPostedMarker = false;
  let inlineActionsObserver = null;
  let inlineActionsEnabled = false;
  let inlineActionScanQueued = false;
  let nativeMenuActionContext = null;

  const contextHandler = event => { lastContextTarget = event.target; };
  const nativePostHandler = event => {
    noteNativeMenuActionSource(event);
    monitorNativePost(event).catch(() => {});
  };
  document.addEventListener("contextmenu", contextHandler, true);
  document.addEventListener("click", nativePostHandler, true);

  function register(adapter) {
    if (!adapter?.id || typeof adapter.matches !== "function") throw new Error("Invalid Crossposter platform adapter.");
    const index = adapters.findIndex(item => item.id === adapter.id);
    if (index >= 0) adapters[index] = adapter;
    else adapters.push(adapter);
    if (adapter.matches(location.hostname) && (typeof adapter.inlineActionMount === "function" || typeof adapter.nativeMenuActionMount === "function")) {
      Promise.resolve(runtime.sendMessage({ type: "GET_PLATFORM_PREFERENCES" }))
        .then(response => setInlineActionsEnabled(response?.ok && response.showInlineActions !== false))
        .catch(() => {});
    }
  }

  function currentAdapter() { return adapters.find(adapter => adapter.matches(location.hostname)) || null; }
  function adapterById(id) { return adapters.find(adapter => adapter.id === id) || null; }

  function closestPost(target = document.activeElement) {
    const selectors = [
      ...(currentAdapter()?.postSelectors || []),
      "article", "[role='article']"
    ];
    for (const selector of new Set(selectors)) {
      const found = target?.closest?.(selector);
      if (found) return found;
    }
    return document.body;
  }

  function capture(post) {
    const adapter = currentAdapter();
    let rawText = adapter?.captureText?.({ post, helpers });
    if (rawText == null) {
      // Cloning a post can construct custom media elements (for example
      // UpScrolled's mux-player). Only make the generic cleanup clone when an
      // adapter has not already extracted its text from a safe, focused copy.
      const clone = post.cloneNode(true);
      clone.querySelectorAll("button, nav, [aria-hidden='true'], script, style").forEach(node => node.remove());
      rawText = clone.innerText ?? clone.textContent ?? "";
    }
    const media = adapter?.captureMedia?.({ post, helpers }) ?? mediaFromNodes(post.querySelectorAll("img, video"));
    return {
      text: String(rawText).replace(/\n{3,}/g, "\n\n").trim().slice(0, 3000),
      media,
      sourceUrl: adapter?.sourceUrl?.({ post, helpers }) || location.href,
      sourceAuthor: adapter?.sourceAuthor?.({ post, helpers }) || firstText(post, ["[rel='author']", ".author", "[itemprop='author']"]),
      sourceIsOwn: Boolean(adapter?.isOwnPost?.({ post, helpers })),
      capturedFromPost: post !== document.body
    };
  }

  function setInlineActionsEnabled(enabled) {
    inlineActionsEnabled = Boolean(enabled);
    inlineActionsObserver?.disconnect();
    inlineActionsObserver = null;
    inlineActionScanQueued = false;
    if (!inlineActionsEnabled) {
      document.querySelectorAll("[data-crossposter-inline-action]").forEach(node => node.remove());
      document.querySelectorAll("[data-crossposter-menu-action]").forEach(node => node.remove());
      document.querySelector("#crossposter-inline-action-styles")?.remove();
      nativeMenuActionContext = null;
      return;
    }
    const adapter = currentAdapter();
    if (typeof adapter?.inlineActionMount !== "function" && typeof adapter?.nativeMenuActionMount !== "function") return;
    if (typeof adapter.inlineActionMount === "function") ensureInlineActionStyles();
    scanInlineActions(adapter);
    inlineActionsObserver = new MutationObserver(() => scheduleInlineActionScan(adapter));
    inlineActionsObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function scheduleInlineActionScan(adapter) {
    if (inlineActionScanQueued || !inlineActionsEnabled) return;
    inlineActionScanQueued = true;
    requestAnimationFrame(() => {
      inlineActionScanQueued = false;
      if (inlineActionsEnabled && adapter === currentAdapter()) scanInlineActions(adapter);
    });
  }

  function scanInlineActions(adapter) {
    if (typeof adapter.inlineActionMount === "function") {
      const posts = new Set();
      for (const selector of adapter.postSelectors || ["article", "[role='article']"]) {
        if (document.documentElement.matches?.(selector)) posts.add(document.documentElement);
        document.querySelectorAll(selector).forEach(post => posts.add(post));
      }
      for (const post of posts) {
        const mount = adapter.inlineActionMount({ post, helpers });
        const container = mount?.container || mount;
        if (!container || container.querySelector("[data-crossposter-inline-action]") || !post.isConnected) continue;
        container.appendChild(createInlineAction(post, adapter, mount));
      }
    }
    if (typeof adapter.nativeMenuActionMount === "function" && nativeMenuActionContext?.post?.isConnected) {
      for (const menu of document.querySelectorAll("[role='menu']")) {
        const mount = adapter.nativeMenuActionMount({ menu, context: nativeMenuActionContext, helpers });
        if (!mount?.container || !mount.template || mount.container.querySelector("[data-crossposter-menu-action]")) continue;
        mount.container.appendChild(createNativeMenuAction(nativeMenuActionContext, adapter, mount.template));
      }
    }
  }

  function noteNativeMenuActionSource(event) {
    if (!inlineActionsEnabled) return;
    const adapter = currentAdapter();
    if (typeof adapter?.nativeMenuActionSource !== "function") return;
    const context = adapter.nativeMenuActionSource({ target: event.target, helpers });
    if (context?.post) {
      nativeMenuActionContext = context;
      scheduleInlineActionScan(adapter);
    }
  }

  function ensureInlineActionStyles() {
    if (document.querySelector("#crossposter-inline-action-styles")) return;
    const style = document.createElement("style");
    style.id = "crossposter-inline-action-styles";
    style.textContent = `
      [data-crossposter-inline-action][data-crossposter-inline-generated] { display:flex; flex:1 1 0; min-width:38px; align-items:center; justify-content:center; color:inherit; }
      [data-crossposter-inline-action="threads"][data-crossposter-inline-generated] { flex:0 0 42px; }
      .crossposter-inline-button { all:unset; box-sizing:border-box; display:grid; width:34px; height:34px; place-items:center; border-radius:999px; color:inherit; cursor:pointer; }
      .crossposter-inline-button-labeled { display:flex; width:auto; min-width:34px; padding:0 10px; gap:6px; font:inherit; }
      .crossposter-inline-button-labeled span { font-size:inherit; font-weight:inherit; }
      .crossposter-inline-button:hover { background:rgba(127,127,127,.14); }
      .crossposter-inline-button:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
      .crossposter-inline-button[aria-busy="true"] { cursor:wait; opacity:.55; }
      .crossposter-inline-button svg { display:block; width:19px; height:19px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createInlineAction(post, adapter, mount) {
    if (mount?.template) return createNativeInlineAction(post, adapter, mount);
    const wrapper = document.createElement("div");
    wrapper.dataset.crossposterInlineAction = adapter.id;
    wrapper.dataset.crossposterInlineGenerated = "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "crossposter-inline-button";
    button.setAttribute("aria-label", "Crosspost");
    button.title = "Crosspost";
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11m0 0-3-3m3 3-3 3M17 17H6m0 0 3 3m-3-3 3-3"/></svg>`;
    if (adapter.inlineActionText) {
      const label = document.createElement("span");
      label.textContent = adapter.inlineActionText;
      button.appendChild(label);
      button.classList.add("crossposter-inline-button-labeled");
    }
    bindInlineAction(button, post, adapter, "Crossposter inline action failed:");
    wrapper.appendChild(button);
    return wrapper;
  }

  function createNativeInlineAction(post, adapter, mount) {
    const wrapper = mount.template.cloneNode(true);
    wrapper.dataset.crossposterInlineAction = adapter.id;
    const action = mount.actionSelector ? wrapper.querySelector(mount.actionSelector) : wrapper;
    for (const element of [wrapper, ...wrapper.querySelectorAll("*")]) {
      element.removeAttribute?.("id");
      element.removeAttribute?.("componentkey");
      element.removeAttribute?.("href");
      element.removeAttribute?.("aria-expanded");
      element.removeAttribute?.("aria-haspopup");
      element.removeAttribute?.("aria-disabled");
      element.removeAttribute?.("disabled");
      element.removeAttribute?.("data-ad-rendering-role");
    }
    action.setAttribute("aria-label", "Crosspost");
    action.setAttribute("title", "Crosspost");
    if (action.tagName === "A") {
      action.setAttribute("role", "button");
      action.setAttribute("tabindex", "0");
    }
    if (mount.iconOnly) {
      const hoverLayer = action.querySelector("[role='none'][data-visualcompletion='ignore']")?.cloneNode(true);
      action.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--secondary-icon, currentColor)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h11m0 0-3-3m3 3-3 3M17 17H6m0 0 3 3m-3-3 3-3"/></svg>`;
      if (hoverLayer) action.appendChild(hoverLayer);
    } else {
      const label = [...action.querySelectorAll("span")]
        .find(element => !element.querySelector("span") && helpers.normalizeText(element).toLowerCase() === String(mount.templateLabel || "").toLowerCase());
      if (label) label.textContent = adapter.inlineActionText || "Crosspost";
      const svg = action.querySelector("svg");
      if (svg) {
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.innerHTML = `<path d="M7 7h11m0 0-3-3m3 3-3 3M17 17H6m0 0 3 3m-3-3 3-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
      } else {
        const iconSlot = action.querySelector("[data-dynamic-icon-loading]");
        if (iconSlot) iconSlot.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h11m0 0-3-3m3 3-3 3M17 17H6m0 0 3 3m-3-3 3-3"/></svg>`;
      }
    }
    bindInlineAction(action, post, adapter, "Crossposter native action failed:");
    return wrapper;
  }

  function bindInlineAction(button, post, adapter, warning) {
    const activate = async event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (button.getAttribute("aria-busy") === "true") return;
      button.setAttribute("aria-busy", "true");
      try {
        await openCapturedPost(post, adapter, button);
      } catch (error) {
        console.warn(warning, error);
      } finally {
        button.removeAttribute("aria-busy");
      }
    };
    button.addEventListener("click", activate, true);
    if (button.tagName !== "BUTTON") button.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    }, true);
  }

  function createNativeMenuAction(context, adapter, template) {
    const item = template.cloneNode(true);
    item.dataset.crossposterMenuAction = adapter.id;
    item.setAttribute("role", "menuitem");
    item.setAttribute("tabindex", "0");
    item.setAttribute("aria-label", "Crosspost");
    item.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
    const label = item.querySelector("span");
    if (label) label.textContent = "Crosspost";
    const svg = item.querySelector("svg");
    if (svg) {
      svg.setAttribute("aria-hidden", "true");
      svg.innerHTML = `<g><path d="M7 7h11m0 0-3-3m3 3-3 3M17 17H6m0 0 3 3m-3-3 3-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></g>`;
    }
    const activate = async event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (item.getAttribute("aria-busy") === "true") return;
      item.setAttribute("aria-busy", "true");
      const pending = capturedPostRequest(context.post, adapter, item);
      if (context.trigger?.isConnected && context.trigger.getAttribute("aria-expanded") === "true") context.trigger.click();
      try {
        await sendCapturedPost(pending);
      } catch (error) {
        console.warn("Crossposter Share menu action failed:", error);
      } finally {
        item.removeAttribute("aria-busy");
      }
    };
    item.addEventListener("click", activate, true);
    item.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    }, true);
    return item;
  }

  function capturedPostRequest(post, adapter, target) {
    const draft = capture(post);
    const video = post.querySelector("video");
    const videoHint = draft.media.some(item => item.kind === "video")
      ? adapter.videoInfo?.({ target, post, video, helpers }) || {}
      : {};
    return { draft, videoHint };
  }

  async function sendCapturedPost(request) {
    const response = await runtime.sendMessage({ type: "OPEN_CAPTURED_POST", ...request });
    if (!response?.ok) throw new Error(response?.error || "Crossposter could not open the draft.");
    return response;
  }

  async function openCapturedPost(post, adapter, target) {
    await adapter.prepareCapture?.({ post, target, helpers });
    return sendCapturedPost(capturedPostRequest(post, adapter, target));
  }

  function mediaFromNodes(nodes) {
    return [...nodes].map(node => ({
      kind: node.tagName === "VIDEO" ? "video" : "image",
      url: node.currentSrc || node.src,
      poster: node.tagName === "VIDEO" ? node.poster || "" : "",
      sources: node.tagName === "VIDEO" ? node.getAttribute("data-sources") || null : null
    })).filter(item => item.url && !item.url.startsWith("data:")).slice(0, 4);
  }

  function identityFromHref(href = "", pattern = /^\/([^/?#]+)/) {
    let path;
    try { path = new URL(href, location.origin).pathname; } catch { return ""; }
    const value = path.match(pattern)?.[1] || "";
    try { return decodeURIComponent(value).replace(/^@/, "").toLowerCase(); }
    catch { return value.replace(/^@/, "").toLowerCase(); }
  }

  function firstText(root, selectors) {
    if (!root) return "";
    for (const selector of selectors) {
      const value = root.querySelector?.(selector)?.textContent?.replace(/\s+/g, " ").trim();
      if (value) return value;
    }
    return "";
  }

  function videoUnderContext() {
    const target = lastContextTarget;
    const post = closestPost(target);
    return target?.closest?.("video") || target?.querySelector?.("video")
      || (post !== document.body ? post.querySelector?.("video") : document.querySelector("video"));
  }

  function videoInfo() {
    const adapter = currentAdapter(), video = videoUnderContext(), post = closestPost(lastContextTarget);
    return adapter?.videoInfo?.({ target: lastContextTarget, post, video, helpers })
      || { source: "web", src: video?.currentSrc || video?.src || "" };
  }

  async function openNativeComposer(network, handoff) {
    const adapter = adapterById(network);
    if (!adapter?.openComposer) throw new Error("This native composer is not supported.");
    const files = await handoffFiles(handoff.media || []);
    return adapter.openComposer({ handoff, files, helpers });
  }

  function manualResult(error) { return { ok: true, composerOpened: false, textInserted: false, mediaInserted: 0, error }; }
  function queryAllDeep(selector, root = document) {
    const matches = [], roots = [root], visited = new Set();
    while (roots.length) {
      const current = roots.shift();
      if (!current?.querySelectorAll || visited.has(current)) continue;
      visited.add(current);
      matches.push(...current.querySelectorAll(selector));
      if (current.shadowRoot) roots.push(current.shadowRoot);
      for (const element of current.querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    return [...new Set(matches)];
  }

  function closestDeep(element, selector) {
    let current = element;
    while (current) {
      const match = current.closest?.(selector);
      if (match) return match;
      const root = current.getRootNode?.();
      current = root?.host || null;
    }
    return null;
  }

  function findVisible(selector, root = document) { return queryAllDeep(selector, root).find(isVisible) || null; }
  function normalizeText(element) {
    const visible = (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    return (visible || element?.getAttribute?.("aria-label") || "").trim().toLowerCase();
  }
  function isVisible(element) { return Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length)); }

  function findDialogWithText(text) {
    return queryAllDeep("[role='dialog'], dialog")
      .find(element => isVisible(element) && normalizeText(element).includes(String(text).toLowerCase())) || null;
  }

  function findClickable(text, root = document, filter = () => true, exact = true) {
    const wanted = text.toLowerCase();
    return queryAllDeep("button, [role='button'], a", root).find(element => {
      const value = normalizeText(element);
      return isVisible(element) && !element.disabled && filter(element) && (exact ? value === wanted : value.startsWith(wanted));
    }) || null;
  }

  function waitForElement(find, timeoutMs = 12000) {
    const existing = find();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(null, new Error("The native composer did not appear.")), timeoutMs);
      const interval = setInterval(() => { const element = find(); if (element) finish(element); }, 75);
      const observer = new MutationObserver(() => { const element = find(); if (element) finish(element); });
      function finish(element, error) {
        clearTimeout(timeout); clearInterval(interval); observer.disconnect(); error ? reject(error) : resolve(element);
      }
      observer.observe(document.documentElement, {
        childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ["aria-hidden", "open", "disabled", "accept"]
      });
    });
  }

  function waitForCondition(check, timeoutMs = 45000) {
    if (check()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("The native post was not confirmed.")), timeoutMs);
      const interval = setInterval(() => { if (check()) finish(); }, 100);
      const observer = new MutationObserver(() => { if (check()) finish(); });
      function finish(error) {
        clearTimeout(timeout); clearInterval(interval); observer.disconnect(); error ? reject(error) : resolve();
      }
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-hidden", "disabled", "open"] });
    });
  }

  async function monitorNativePost(event) {
    const adapter = currentAdapter();
    const confirmation = adapter?.nativePostSubmission?.({ target: event.target, helpers });
    if (!confirmation?.isOpen || confirmation.isOpen() !== true) return;
    const attempt = ++nativePostAttempt;
    await new Promise(resolve => setTimeout(resolve, 350));
    await waitForCondition(() => confirmation.isOpen() !== true);
    if (attempt !== nativePostAttempt) return;
    const response = await runtime.sendMessage({ type: "NATIVE_POST_CONFIRMED", network: adapter.id });
    if (response?.ok && response.posted) markPagePosted();
  }

  function markPagePosted() {
    ensurePostedMarker();
    if (postedMarkerObserver) return;
    postedMarkerObserver = new MutationObserver(ensurePostedMarker);
    postedMarkerObserver.observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function ensurePostedMarker() {
    if (applyingPostedMarker) return;
    applyingPostedMarker = true;
    try {
      const title = document.title.replace(/^(?:✓\s*)+/, "");
      if (title && document.title !== `✓ ${title}`) document.title = `✓ ${title}`;
      let favicon = document.querySelector("link[data-crossposter-posted-icon]");
      if (!favicon) {
        favicon = document.createElement("link");
        favicon.rel = "icon"; favicon.type = "image/svg+xml"; favicon.dataset.crossposterPostedIcon = "true";
        favicon.href = runtime.getURL("icons/posted.svg");
      }
      const icons = [...document.head.querySelectorAll("link[rel~='icon']")];
      if (icons.at(-1) !== favicon) document.head.append(favicon);
    } finally { applyingPostedMarker = false; }
  }

  function composerElementText(element) {
    return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value
      : element?.innerText ?? element?.textContent ?? "";
  }

  function composerHasText(element) {
    return Boolean(String(composerElementText(element) || "")
      .replace(/[\u200b-\u200d\u2060\ufeff]/gi, "")
      .trim());
  }

  function selectComposerContents(element) {
    if (!element || element.isConnected === false) return false;
    const selection = element.ownerDocument.defaultView?.getSelection?.();
    if (!selection) return false;
    try {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      if (element.isConnected === false) return false;
      selection.addRange(range);
      return true;
    } catch { return false; }
  }

  function setComposerText(element, value) {
    if (!element || element.isConnected === false) return false;
    if (!value) return true;
    if (composerHasText(element)) return true;
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter ? setter.call(element, value) : (element.value = value);
    } else {
      selectComposerContents(element);
      try { document.execCommand("insertText", false, value); } catch {}
      if (!composerHasText(element)) {
        const lines = String(value).split("\n");
        element.replaceChildren(...lines.map(line => {
          const paragraph = element.ownerDocument.createElement("p");
          if (line) paragraph.textContent = line;
          else paragraph.append(element.ownerDocument.createElement("br"));
          return paragraph;
        }));
      }
    }
    try { element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); }
    catch { element.dispatchEvent(new Event("input", { bubbles: true })); }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return composerHasText(element);
  }

  async function pasteComposerText(element, value, options = {}) {
    if (!element || element.isConnected === false) return false;
    if (!value) return true;
    if (composerHasText(element)) return true;
    element.focus(); selectComposerContents(element);
    try {
      const transfer = new DataTransfer(); transfer.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
      // Some controlled editors accept the paste but update their readable DOM
      // late. For those editors, a second insertText fallback duplicates the
      // caption; allow the platform adapter to make paste the single attempt.
      // Firefox is the exception: a content-script ClipboardEvent's data does
      // not cross the Xray boundary into page editors (Threads' Lexical never
      // sees it), so there the paste must be verified and the insertText
      // fallback kept. Firefox content scripts are detected by the `browser`
      // global, which Chrome does not define.
      if (options.fallback === false && !globalThis.browser?.runtime) return true;
      await waitForElement(() => composerHasText(element) ? element : null, options.timeoutMs || 1800);
    } catch {}
    if (composerHasText(element)) return true;
    setComposerText(element, value);
    try { await waitForElement(() => composerHasText(element) ? element : null, options.timeoutMs || 1800); }
    catch {}
    return composerHasText(element);
  }

  function compatibleFiles(files) {
    const wantsVideo = files.some(file => file.type.startsWith("video/"));
    return files.filter(file => wantsVideo ? file.type.startsWith("video/") : file.type.startsWith("image/"));
  }

  function acceptsFiles(input, files) {
    const accept = input.accept || "";
    if (!accept || !files.length) return true;
    return files.every(file => accept.split(",").some(rule => {
      const value = rule.trim().toLowerCase();
      return value === "*/*" || value === file.type.toLowerCase()
        || (value.endsWith("/*") && file.type.toLowerCase().startsWith(value.slice(0, -1)));
    }));
  }

  function findCompatibleFileInput(files, root = document, includeDocument = true) {
    const compatible = compatibleFiles(files);
    const scoped = queryAllDeep("input[type='file']", root);
    const global = includeDocument && root !== document ? queryAllDeep("input[type='file']") : [];
    return [...new Set([...scoped, ...global])].find(element => !element.disabled && acceptsFiles(element, compatible)) || null;
  }

  function fileTransfer(files) {
    const transfer = new DataTransfer();
    files.forEach(file => transfer.items.add(file));
    return transfer;
  }

  function attachFilesToInput(files, input) {
    const compatible = compatibleFiles(files);
    if (!input || !compatible.length) return 0;
    const transfer = fileTransfer(compatible);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return compatible.length;
  }

  function attachNativeFiles(files, root) {
    if (!files.length) return 0;
    const compatible = compatibleFiles(files), input = findCompatibleFileInput(files, root, true);
    if (input) return attachFilesToInput(files, input);
    const dropTarget = queryAllDeep("button, [role='button'], [role='presentation'], div", root)
      .find(element => isVisible(element) && /select (?:a )?(?:photos?|videos?)|add media|add photos|drag.*drop|upload/i.test(normalizeText(element)));
    if (!dropTarget) return 0;
    const transfer = fileTransfer(compatible);
    try {
      for (const type of ["dragenter", "dragover", "drop"]) {
        dropTarget.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }
      return compatible.length;
    } catch { return 0; }
  }

  function fillNativeComposer(field, text, files) {
    const textInserted = setComposerText(field, text);
    const root = closestDeep(field, "[role='dialog'], dialog") || document;
    const mediaInserted = attachNativeFiles(files, root);
    return { ok: true, composerOpened: true, textInserted, mediaInserted, error: textInserted ? "" : "Use the Crossposter sidebar to finish the handoff." };
  }

  function dataUrlToFile(item) {
    const match = String(item.dataUrl || "").match(/^data:([^;,]*)(;base64)?,(.*)$/s);
    if (!match) throw new Error("A media item could not be transferred.");
    const type = item.type || match[1] || "application/octet-stream";
    const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], item.name || "crossposter-media", { type, lastModified: item.lastModified || Date.now() });
  }

  async function handoffFiles(media) {
    const files = [];
    for (const item of media) {
      if (item.dataUrl) { files.push(dataUrlToFile(item)); continue; }
      if (!item.mediaId) throw new Error("A handoff media item is missing its storage reference.");
      const chunks = [];
      let offset = 0, totalSize = Number(item.size) || 0;
      do {
        const response = await runtime.sendMessage({ type: "GET_HANDOFF_MEDIA_CHUNK", mediaId: item.mediaId, offset, length: 2 * 1024 * 1024 });
        if (!response?.ok) throw new Error(response?.error || "A stored media item could not be transferred.");
        totalSize = Number(response.totalSize);
        const binary = atob(response.data || ""), bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        if (bytes.byteLength !== Number(response.byteLength) || (!bytes.byteLength && offset < totalSize)) {
          throw new Error("A stored media transfer was incomplete.");
        }
        chunks.push(bytes); offset += bytes.byteLength;
        if (response.done) break;
      } while (offset < totalSize);
      if (offset !== totalSize) throw new Error("A stored media transfer was incomplete.");
      files.push(new File(chunks, item.name || "crossposter-media", {
        type: item.type || "application/octet-stream", lastModified: item.lastModified || Date.now()
      }));
    }
    return files;
  }

  const helpers = Object.freeze({
    mediaFromNodes, identityFromHref, firstText, capturePost: capture,
    manualResult, queryAllDeep, closestDeep, findVisible, normalizeText, isVisible, findDialogWithText, findClickable, waitForElement,
    setComposerText, pasteComposerText, composerHasText,
    attachNativeFiles, fillNativeComposer, findCompatibleFileInput, attachFilesToInput
  });

  const listener = (message, _sender, sendResponse) => {
    if (message.type === "DISABLE_CROSSPOSTER") { sendResponse({ ok: true }); globalThis.CrossposterContent?.dispose?.(); return; }
    if (message.type === "SET_INLINE_ACTIONS") { setInlineActionsEnabled(message.enabled); sendResponse({ ok: true }); return; }
    if (message.type === "CAPTURE_POST") {
      const post = closestPost(lastContextTarget), adapter = currentAdapter();
      Promise.resolve(adapter?.prepareCapture?.({ post, target: lastContextTarget, helpers }))
        .then(() => sendResponse(capture(post)))
        .catch(() => sendResponse(capture(post)));
      return true;
    }
    if (message.type === "VIDEO_INFO") { sendResponse(videoInfo()); return; }
    if (message.type === "MARK_NATIVE_POSTED") { markPagePosted(); sendResponse({ ok: true }); return; }
    const adapterHandler = currentAdapter()?.messages?.[message.type];
    if (adapterHandler) {
      Promise.resolve(adapterHandler({ message, helpers })).then(sendResponse).catch(error => sendResponse({ error: error.message }));
      return true;
    }
    if (message.type === "OPEN_NATIVE_COMPOSER") {
      openNativeComposer(message.network, message.handoff || {}).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
  };

  runtime.onMessage.addListener(listener);
  try {
    const statusRequest = runtime.sendMessage?.({ type: "GET_NATIVE_TAB_STATUS" });
    statusRequest?.then?.(response => { if (response?.posted) markPagePosted(); }).catch?.(() => {});
  } catch {}
  globalThis.CrossposterContent = {
    register,
    helpers,
    dispose() {
      nativePostAttempt++;
      document.removeEventListener("contextmenu", contextHandler, true);
      document.removeEventListener("click", nativePostHandler, true);
      postedMarkerObserver?.disconnect();
      setInlineActionsEnabled(false);
      try { runtime.onMessage.removeListener(listener); } catch {}
    }
  };
})();
