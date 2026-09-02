(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;
  const detectionBaselines = new Map();
  const linkedInVideoSourceCache = new Map();
  let completedMediaSignature = "";
  const COMPOSER_FIELD_SELECTOR = [
    "[role='dialog'] [contenteditable='true'][role='textbox']",
    "[role='dialog'] .ql-editor[contenteditable='true']",
    "[role='dialog'] [contenteditable='true'][data-placeholder]",
    "[role='dialog'] [contenteditable='true'][aria-label]"
  ].join(", ");
  const COMPOSER_WAIT_MS = 30000;
  const AUTO_OPEN_WAIT_MS = 15000;
  const adapter = {
    id: "linkedin",
    matches: host => host.endsWith("linkedin.com"),
    postSelectors: [".feed-shared-update-v2", "article", "[role='article']", "[role='listitem']:has(h2)"],
    sourceAuthor: linkedInSourceAuthor,
    sourceUrl: linkedInSourceUrl,
    isOwnPost: linkedInIsOwnPost,
    captureText: linkedInCaptureText,
    captureMedia: linkedInCaptureMedia,
    videoInfo: linkedInVideoInfo,
    prepareCapture: ({ post, helpers }) => expandLinkedInText(post, helpers),
    inlineActionText: "Crosspost",
    inlineActionMount: ({ post, helpers }) => {
      // LinkedIn localizes the action labels ("Kommentera", "Skicka", …) but
      // keeps stable SVG symbol ids on the icons, so match those first.
      const actions = helpers.queryAllDeep("button, a", post);
      const comment = findAction(actions, ACTION_ICONS.comment, helpers);
      const repost = findAction(actions, ACTION_ICONS.repost, helpers);
      const send = findAction(actions, ACTION_ICONS.send, helpers);
      const container = send?.parentElement;
      return container && comment?.parentElement === container && repost?.parentElement === container
        ? { container, template: send, templateLabel: helpers.normalizeText(send) || "Send" }
        : null;
    },
    ownsPage: ({ helpers }) => linkedInOwnsPage(helpers),
    async openComposer({ handoff, files, helpers }) {
      if (!location.hostname.endsWith("linkedin.com")) throw new Error("Open LinkedIn in this tab, then use the Crossposter sidebar.");
      const selector = COMPOSER_FIELD_SELECTOR;
      const mediaSignature = files.map(file => `${file.name}:${file.size}:${file.lastModified}`).join("|");
      let field = helpers.findVisible(selector);
      let mediaInserted = files.length && mediaSignature === completedMediaSignature ? files.length : 0;
      const existingInput = files.length ? helpers.findCompatibleFileInput(files, document, true) : null;
      if (!field && existingInput) {
        mediaInserted = await finishMediaHandoff(existingInput, files, helpers, selector);
        if (mediaInserted) completedMediaSignature = mediaSignature;
        try { field = await helpers.waitForElement(() => helpers.findVisible(selector), COMPOSER_WAIT_MS); }
        catch {}
      }
      if (!field && composerAutoOpens()) {
        // LinkedIn opens the share box itself several seconds after the tab
        // reports "complete". Clicking the launcher in the meantime races its
        // own open, so give the automatic one a chance first.
        try { field = await helpers.waitForElement(() => helpers.findVisible(selector), AUTO_OPEN_WAIT_MS); }
        catch {}
      }
      if (!field) {
        const launch = findStartPostLauncher(helpers);
        if (!launch) return helpers.manualResult("Open LinkedIn’s post composer, then use the Crossposter sidebar.");
        launch.click();
        try { field = await helpers.waitForElement(() => helpers.findVisible(selector), COMPOSER_WAIT_MS); }
        catch { return helpers.manualResult("Open LinkedIn’s post composer, then use the Crossposter sidebar."); }
      }
      if (files.length && !mediaInserted) {
        const composer = helpers.closestDeep(field, "[role='dialog'], dialog") || document;
        let input = helpers.findCompatibleFileInput(files, document, true);
        if (!input) {
          const addMedia = helpers.findIconControl?.(composer, ACTION_ICONS.addMedia, "button")
            || helpers.findClickable("Add media", composer);
          if (addMedia) {
            addMedia.click();
            try { input = await helpers.waitForElement(() => helpers.findCompatibleFileInput(files, document, true), 20000); }
            catch {}
          }
        }
        if (input) {
          mediaInserted = await finishMediaHandoff(input, files, helpers, selector);
          if (mediaInserted) completedMediaSignature = mediaSignature;
        }
      }
      if (files.length) {
        field = null;
        try { field = await helpers.waitForElement(() => helpers.findVisible(selector), COMPOSER_WAIT_MS); }
        catch {}
      }
      const textInserted = field
        ? await helpers.pasteComposerText(field, handoff.text || "")
        : false;
      const errors = [];
      if (handoff.text && !textInserted) errors.push("LinkedIn did not accept the post text.");
      if (files.length && !mediaInserted) errors.push("LinkedIn did not finish attaching the media.");
      return { ok: true, composerOpened: true, textInserted, mediaInserted, error: errors.join(" ") };
    },
    messages: {
      ARM_LINKEDIN_POST_DETECTION: ({ message, helpers }) => {
        detectionBaselines.set(message.candidate?.requestId || "", new Set(linkedInPosts(helpers).map(post => linkedInPostKey(post, helpers))));
        return { ok: true };
      },
      DETECT_LINKEDIN_POST: ({ message, helpers }) => detectNewLinkedInPost(message.candidate || {}, helpers)
    }
  };
  core.register(adapter);

  // Stable, language-independent hooks: LinkedIn's icon sprites keep the same
  // symbol id (svg#comment-small / <use href="#comment-small">) whatever the
  // UI language. Labels are a last-resort fallback for older markup.
  const ACTION_ICONS = Object.freeze({
    comment: { ids: ["comment-small", "comment-medium"], labels: ["comment"] },
    repost: { ids: ["repost-small", "repost-medium"], labels: ["repost"] },
    send: { ids: ["send-privately-small", "send-privately-medium"], labels: ["send"] },
    addMedia: { ids: ["image-medium", "image-small"], labels: ["add media"] }
  });

  function findAction(actions, icon, helpers) {
    return actions.find(element => helpers.iconMatches?.(element, { ids: icon.ids }))
      || actions.find(element => icon.labels.includes(helpers.normalizeText(element).toLowerCase()))
      || null;
  }

  function composerAutoOpens() {
    return /[?&]shareActive=true(?:&|$)/i.test(location.search || "");
  }

  function findStartPostLauncher(helpers) {
    const usable = element => Boolean(element) && helpers.isVisible(element) && !helpers.closestDeep(element, "[role='dialog']");
    // Current feed: the share box pairs the viewer's avatar (a stable id) with
    // the launcher; legacy feed: a dedicated trigger class. Neither depends on
    // the localized "Start a post" label, which stays as the final fallback.
    const structural = helpers.queryAllDeep("#shareboxProfilePictureComponentRef")
      .map(avatar => avatar.parentElement?.querySelector?.("[role='button'], button"))
      .find(usable)
      || helpers.queryAllDeep(".share-box-feed-entry__trigger").find(usable);
    if (structural) return structural;
    return helpers.queryAllDeep("button, [role='button']")
      .find(element => usable(element) && helpers.normalizeText(element).startsWith("start a post")) || null;
  }

  function isTopFrame() {
    try { return globalThis.top === globalThis.self; }
    catch { return true; }
  }

  // LinkedIn loads a full-window "preload" iframe next to the document that
  // renders the feed and the share composer. Only the document with that UI
  // (or, before it renders, the top document) may answer composer messages.
  function linkedInOwnsPage(helpers) {
    if (helpers.findVisible(COMPOSER_FIELD_SELECTOR)) return true;
    if (findStartPostLauncher(helpers)) return true;
    return isTopFrame() && Boolean(helpers.findVisible("main, [role='main']"));
  }

  function linkedInVideoInfo({ post, video, helpers }) {
    const assetId = linkedInVideoAssetId(post, video, helpers);
    const embeddedSources = linkedInEmbeddedVideoSources(post, video, helpers, assetId);
    const networkSources = linkedInPerformanceVideoSources(assetId);
    const currentSrc = video?.currentSrc || video?.src || "";
    return {
      source: "linkedin",
      assetId,
      playerId: playerIdForVideo(video, helpers),
      sources: video?.getAttribute("data-sources") || embeddedSources || networkSources,
      // A MediaSource blob belongs to this LinkedIn document and cannot be
      // played or downloaded from the extension's Compose page.
      src: /^https?:/i.test(currentSrc) ? currentSrc : ""
    };
  }

  function playerIdForVideo(video, helpers) {
    const player = helpers.closestDeep(video, "[data-vjs-player], .video-js");
    return player?.id || video?.id || "";
  }

  function linkedInEmbeddedVideoSources(post, video, helpers, assetId = linkedInVideoAssetId(post, video, helpers)) {
    if (!assetId) return null;
    if (linkedInVideoSourceCache.has(assetId)) return linkedInVideoSourceCache.get(assetId);
    const metadataNodes = [...helpers.queryAllDeep("code"), ...helpers.queryAllDeep("script[type='application/json']")];
    for (const code of metadataNodes) {
      const text = code.textContent || "";
      if (!text.includes(assetId) || !text.includes("progressiveStreams")) continue;
      let payload;
      try { payload = JSON.parse(text); } catch { continue; }
      const stack = [payload];
      while (stack.length) {
        const value = stack.pop();
        if (!value || typeof value !== "object") continue;
        const identity = `${value.entityUrn || ""} ${value.media || ""}`;
        if (identity.includes(assetId) && Array.isArray(value.progressiveStreams)) {
          const sources = value.progressiveStreams.flatMap(stream => (stream.streamingLocations || []).map(location => ({
            src: location.url || "",
            type: stream.mediaType || stream.mimeType || "video/mp4",
            "data-bitrate": Number(stream.bitRate || stream.bitrate || 0)
          }))).filter(source => /^https?:/i.test(source.src));
          if (sources.length) {
            const serialized = JSON.stringify(sources);
            linkedInVideoSourceCache.set(assetId, serialized);
            return serialized;
          }
        }
        stack.push(...Object.values(value));
      }
    }
    return null;
  }

  function linkedInPerformanceVideoSources(assetId) {
    if (!assetId || !globalThis.performance?.getEntriesByType) return null;
    const candidates = performance.getEntriesByType("resource")
      .map(entry => ({ url: entry.name || "", time: Number(entry.startTime || 0) }))
      .filter(entry => {
        const value = entry.url;
        return value.includes(assetId)
          && /https?:\/\/[^/]*\.licdn\.com\//i.test(value)
          && !/(?:videocover|thumbnail|\/dms\/image\/)/i.test(value)
          && /\.(?:mp4|m3u8)(?:[?#]|$)/i.test(value);
      })
      .sort((a, b) => b.time - a.time);
    const hls = candidates.filter(entry => /\.m3u8(?:[?#]|$)/i.test(entry.url));
    const selected = hls.length ? hls : candidates;
    if (!selected.length) return null;
    return JSON.stringify(selected.slice(0, 8).map(entry => ({
      src: entry.url,
      type: /\.m3u8(?:[?#]|$)/i.test(entry.url) ? "application/x-mpegURL" : "video/mp4",
      "data-bitrate": 0
    })));
  }

  function linkedInVideoAssetId(post, video, helpers) {
    const player = helpers.closestDeep(video, "[data-vjs-player], .video-js") || post;
    const poster = player && helpers.queryAllDeep(".vjs-poster-background, .vjs-poster", player)[0];
    const candidates = [
      video?.poster,
      video?.getAttribute?.("poster"),
      poster?.style?.backgroundImage,
      player?.outerHTML
    ];
    for (const value of candidates) {
      const match = String(value || "").match(/\/playlist\/vid\/v\d+\/([^/\"')]+)\/(?:thumbnail|videocover)/i)
        || String(value || "").match(/\/dms\/image\/v\d+\/([^/\"')]+)\/videocover-/i);
      if (match) return match[1];
    }
    return "";
  }

  function linkedInSourceAuthor({ post, helpers }) {
    const actorSelectors = ".update-components-actor__name, .feed-shared-actor__name, .update-components-actor__title, [data-anonymize='person-name']";
    const actor = helpers.queryAllDeep(actorSelectors, post)[0];
    // LinkedIn commonly renders the actor name twice: once in an
    // aria-hidden visual span and once for assistive technology. Reading the
    // parent textContent concatenates both copies without a separator.
    const visibleName = actor && helpers.queryAllDeep("[aria-hidden='true']", actor)
      .map(node => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())
      .find(Boolean);
    if (visibleName) return visibleName;
    const legacy = helpers.firstText(post, actorSelectors.split(", "));
    if (legacy) return legacy;
    const actorLink = helpers.queryAllDeep("a[href*='/in/'], a[href*='/company/']", post)
      .find(link => (link.innerText || link.textContent || "").trim());
    return (actorLink?.innerText || actorLink?.textContent || "").split("\n").map(value => value.trim()).find(Boolean) || "";
  }

  function linkedInSourceUrl({ post, helpers }) {
    const links = helpers.queryAllDeep("a[href]", post);
    const permalink = links.map(link => link.href || link.getAttribute("href") || "").find(href => /\/feed\/update\/urn:li:(?:activity|ugcPost|share):|\/posts\//i.test(href));
    return permalink || location.href;
  }

  function linkedInIsOwnPost({ post, helpers }) {
    const profilePattern = /\/in\/([^/?#]+)/i;
    const authoredLink = helpers.queryAllDeep("a[href*='/in/']", post)[0];
    const signedInLink = helpers.queryAllDeep("[aria-label='Sidebar'] a[href*='/in/'], .global-nav__me a[href*='/in/'], a[aria-label*='profile' i][href*='/in/']")[0]
      // The feed's left rail starts with the viewer's own profile card; its
      // landmark label is localized, so fall back to the first aside there.
      || (/^\/feed(?:\/|$)/.test(location.pathname || "") ? helpers.queryAllDeep("main aside a[href*='/in/']")[0] : null);
    const authoredBy = helpers.identityFromHref(authoredLink?.getAttribute("href"), profilePattern);
    const signedInAs = helpers.identityFromHref(signedInLink?.getAttribute("href"), profilePattern);
    return Boolean(authoredBy && signedInAs && authoredBy === signedInAs);
  }

  function linkedInCaptureText({ post, helpers }) {
    const textElement = linkedInTextElement(post, helpers);
    if (!textElement) return "";
    const collapsed = helpers.queryAllDeep("[data-testid='expandable-text-button']", textElement).length > 0;
    // Drop the "… more" expander by element rather than by its localized label.
    const text = typeof helpers.textWithout === "function" && typeof textElement.cloneNode === "function"
      ? helpers.textWithout(textElement, "[data-testid='expandable-text-button']")
      : textElement.innerText || textElement.textContent || "";
    return (collapsed ? text.replace(/\s*(?:…|\.\.\.)\s*more\s*$/iu, "").replace(/\s*(?:…|\.\.\.)\s*$/u, "") : text).trim();
  }

  function linkedInTextElement(post, helpers) {
    const selectors = [
      "[data-testid='expandable-text-box']", ".update-components-text", ".feed-shared-update-v2__description", ".feed-shared-inline-show-more-text", "[data-test-id*='commentary']"
    ];
    for (const selector of selectors) {
      const element = helpers.queryAllDeep(selector, post)[0];
      if (element) return element;
    }
    return null;
  }

  async function expandLinkedInText(post, helpers) {
    const textElement = linkedInTextElement(post, helpers);
    if (!textElement) return;
    const controls = helpers.queryAllDeep("[data-testid='expandable-text-button']", textElement);
    for (const control of controls) {
      const target = control.querySelector?.(":scope > span") || control;
      target.click?.();
    }
    if (controls.length) await new Promise(resolve => setTimeout(resolve, 0));
  }

  function linkedInCaptureMedia({ post, helpers }) {
    let nodes = helpers.queryAllDeep(".update-components-image__image, .feed-shared-image__image, [data-testid*='media'] img, [data-test-id*='media'] img, img[alt='View image'], video", post);
    if (!nodes.length) {
      nodes = helpers.queryAllDeep("img, video", post).filter(node => node.tagName === "VIDEO"
        || ((node.naturalWidth || node.width || 0) >= 180 && (node.naturalHeight || node.height || 0) >= 100
          && !/(?:avatar|profile|logo|emoji)/i.test(`${node.alt || ""} ${node.className || ""}`)));
    }
    return helpers.mediaFromNodes(nodes);
  }

  function linkedInPosts(helpers) {
    const legacy = adapter.postSelectors.slice(0, 3).flatMap(selector => helpers.queryAllDeep(selector));
    // Each current feed item starts with a screen-reader heading whose text is
    // localized; recognise it by the action bar it introduces instead.
    const current = helpers.queryAllDeep("h2")
      .map(heading => helpers.closestDeep(heading, "[role='listitem']") || heading.parentElement)
      .filter(item => item && (helpers.normalizeText(item.querySelector?.("h2")) === "feed post"
        || helpers.queryAllDeep("button, a", item).some(element => helpers.iconMatches?.(element, { ids: ACTION_ICONS.send.ids }))));
    return [...new Set([...legacy, ...current])].filter(post => helpers.isVisible(post));
  }

  function linkedInPostKey(post, helpers) {
    if (post.getAttribute?.("componentkey")) return post.getAttribute("componentkey");
    const url = linkedInSourceUrl({ post, helpers });
    if (/urn:li:|\/posts\//i.test(url)) return url;
    return `${linkedInCaptureText({ post, helpers }).replace(/\s+/g, " ").trim().slice(0, 500)}|${linkedInCaptureMedia({ post, helpers }).map(item => item.url).join("|")}`;
  }

  function comparableText(value) { return String(value || "").replace(/\s+/g, " ").trim().toLowerCase(); }

  async function detectNewLinkedInPost(candidate, helpers) {
    const requestId = candidate.requestId || "";
    const baseline = detectionBaselines.get(requestId) || new Set();
    const hint = comparableText(candidate.textHint);
    const deadline = Date.now() + 45000;
    try {
      while (Date.now() < deadline) {
        const post = linkedInPosts(helpers).find(element => {
          if (!linkedInIsOwnPost({ post: element, helpers })) return false;
          const key = linkedInPostKey(element, helpers);
          const text = comparableText(linkedInCaptureText({ post: element, helpers }));
          if (!baseline.size && !hint) return false;
          return !baseline.has(key) && (!hint || text.includes(hint) || hint.includes(text));
        });
        if (post) return { ok: true, captured: helpers.capturePost(post) };
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return { ok: false, error: "The new LinkedIn post did not appear in the open feed." };
    } finally { detectionBaselines.delete(requestId); }
  }

  async function finishMediaHandoff(input, files, helpers, composerSelector) {
    const inserted = helpers.attachFilesToInput(files, input);
    if (!inserted) return 0;
    let next;
    try {
      // The media editor's footer keeps a stable primary-button class; the
      // "Next" label is localized, so it is only the fallback.
      const inDialog = element => Boolean(helpers.closestDeep(element, "[role='dialog'], dialog"));
      const findNext = () => helpers.queryAllDeep?.(".share-box-footer__primary-btn")
        ?.find(element => helpers.isVisible(element) && !element.disabled && inDialog(element))
        || helpers.findClickable("Next", document, inDialog);
      next = await helpers.waitForElement(findNext, 30000);
    } catch { return 0; }
    next.click();
    try {
      await helpers.waitForElement(() => {
        const nextFinished = !next.isConnected || !helpers.isVisible(next);
        return nextFinished ? helpers.findVisible(composerSelector) : null;
      }, 20000);
    } catch { return 0; }
    return inserted;
  }
})();
