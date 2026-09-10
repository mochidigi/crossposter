(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;
  const detectionBaselines = new Map();
  const linkedInVideoSourceCache = new Map();
  // Find the dialog and then its editor. An ancestor CSS selector cannot
  // cross shadow boundaries, even when queryAllDeep visits both roots.
  // LinkedIn serves two share boxes: the classic Ember modal (Quill editor in
  // a shadow root) and the SDUI one it is rolling out per account — a native
  // <dialog> whose obfuscated class names change per build, rendering the
  // "sharing.ShareCompose" screen with a Tiptap/ProseMirror editor keyed
  // ShareBox_textEditor. Only the language-neutral attributes are matched.
  const SDUI_DIALOG_SELECTOR = "dialog:has([data-sdui-screen*='sharing.ShareCompose']), dialog:has([componentkey='ShareBox_textEditor'])";
  const SHARE_DIALOG_SELECTOR = `.share-box-v2__modal, [data-test-modal-id='sharebox'] [role='dialog'], [role='dialog'][aria-labelledby='share-to-linkedin-modal__header'], ${SDUI_DIALOG_SELECTOR}`;
  const EDITOR_SELECTOR = "[data-test-ql-editor-contenteditable='true'][contenteditable='true'], .ql-editor[contenteditable='true'], [componentkey='ShareBox_textEditor'][contenteditable='true'], [data-testid='ui-core-tiptap-text-editor-wrapper'] [contenteditable='true'][role='textbox'], .ProseMirror[contenteditable='true']";
  const MEDIA_EDITOR_SELECTOR = ".media-detour__container, .media-editor__container";
  const PREVIEW_SELECTOR = ".share-creation-state__preview-container, #ShareBoxpreviewCard";
  const POST_BUTTON_SELECTOR = ".share-actions__primary-action";
  const COMPOSER_WAIT_MS = 30000;
  const composerStates = new WeakMap();
  let runningHandoff = null;
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
    composerReadiness: ({ helpers }) => {
      const composer = findShareDialog(helpers);
      return composer ? (findEditor(composer, helpers) ? 3 : 2) : findStartPostLauncher(helpers) ? 1 : 0;
    },
    openComposer(context) {
      const id = context.handoff.handoffId || "legacy";
      if (runningHandoff) {
        return runningHandoff.id === id ? runningHandoff.promise
          : Promise.resolve({ ...context.helpers.manualResult("Another LinkedIn handoff is still running."), retryable: false });
      }
      const promise = runHandoff(context).finally(() => { runningHandoff = null; });
      runningHandoff = { id, promise };
      return promise;
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

  function linkedInOwnsPage(helpers) {
    return Boolean(findShareDialog(helpers) || findStartPostLauncher(helpers));
  }

  function usable(element, helpers) {
    return Boolean(element && element.isConnected !== false && helpers.isVisible(element)
      && !element.disabled && element.getAttribute?.("aria-disabled") !== "true"
      && !helpers.closestDeep(element, "[aria-hidden='true'], [inert]"));
  }

  function findShareDialog(helpers) {
    const dialogs = helpers.queryAllDeep(SHARE_DIALOG_SELECTOR).filter(element => usable(element, helpers));
    return dialogs.length === 1 ? dialogs[0] : null;
  }

  function findEditor(composer, helpers) {
    return composer && helpers.queryAllDeep(EDITOR_SELECTOR, composer).find(element => usable(element, helpers)) || null;
  }

  function normalizeComposerText(value) {
    return String(value || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/[\u200b\ufeff]/g, "").trim();
  }

  function editorText(editor) {
    // Quill renders newlines as paragraphs; innerText alone doubles them.
    if (!editor) return "";
    const blocks = [...(editor.children || [])];
    const value = blocks.length ? blocks.map(block => {
      if (block.childNodes?.length === 1 && block.firstChild?.nodeName === "BR") return "";
      return String(block.innerText ?? block.textContent ?? "").replace(/\n$/, "");
    }).join("\n") : editor.innerText ?? editor.textContent ?? "";
    return normalizeComposerText(value);
  }

  function mediaRootOf(dialog, files, helpers) {
    if (!dialog) return null;
    const classic = helpers.findVisible(MEDIA_EDITOR_SELECTOR, dialog);
    if (classic || !dialog.matches?.(SDUI_DIALOG_SELECTOR)) return classic;
    // The SDUI share box has shown no media detour so far (its Media control
    // is marked aria-haspopup="dialog"). Best effort until that flow has been
    // observed: accept a compatible file input inside the share dialog or a
    // sibling dialog, so a picker that is still mounting keeps the wait going.
    const roots = [dialog, ...helpers.queryAllDeep("dialog[open], [role='dialog']").filter(element => element !== dialog && usable(element, helpers))];
    return roots.find(root => helpers.findCompatibleFileInput(files, root, false)) || null;
  }

  function findPostButton(composer, helpers) {
    if (!composer) return null;
    const classic = helpers.queryAllDeep(POST_BUTTON_SELECTOR, composer).find(element => usable(element, helpers));
    if (classic) return classic;
    // SDUI: the footer's submit control is the dialog's only text-only
    // <button>; every other button there carries an SVG icon. Its label is
    // localized ("Post", "Publicera"), so the shape is the hook.
    const icons = new Set(helpers.iconControls?.(composer, "button") || []);
    const textButtons = helpers.queryAllDeep("button", composer)
      .filter(button => !icons.has(button) && helpers.normalizeText(button) && usable(button, helpers)
        && !helpers.closestDeep(button, "[contenteditable='true']"));
    return textButtons[textButtons.length - 1] || null;
  }

  function mediaPreviewCount(composer, helpers, video) {
    if (!composer) return 0;
    const preview = helpers.queryAllDeep(PREVIEW_SELECTOR, composer)[0];
    if (!preview) return 0;
    const sdui = preview.id === "ShareBoxpreviewCard";
    const count = helpers.queryAllDeep(sdui ? (video ? "video" : "img") : video ? "video, .update-components-video" : ".update-components-image__image, .share-images__image", preview)
      // LinkedIn marks decorative image wrappers aria-hidden even though the
      // preview is visibly rendered. That is not a hidden upload.
      .filter(element => element.isConnected !== false && helpers.isVisible(element)).length;
    if (video) return count ? 1 : 0;
    // The post preview displays four images and a +N overlay for larger sets.
    const overflow = helpers.findVisible(".update-components-image__excess-image-count-text", preview);
    const extra = String(overflow?.textContent || "").match(/^\s*\+\s*(\d+)\s*$/)?.[1];
    return count + (count && extra ? Number(extra) : 0);
  }

  async function runHandoff({ handoff, files, helpers }) {
    const started = Date.now(), stages = [];
    let stage = "locate", composer = null, textInserted = false, mediaInserted = 0;
    let releaseFilePickerGuard = () => {};
    const report = name => {
      stage = name;
      stages.push({ stage, elapsedMs: Date.now() - started });
      helpers.reportComposerStage?.(handoff.handoffId, "linkedin", stage);
    };
    const result = error => ({ ok: true, composerOpened: Boolean(composer), textInserted, mediaInserted,
      stage, stages, retryable: false, error });
    const wait = (check, timeout = COMPOSER_WAIT_MS, stableMs = 0) => {
      let previous = null, since = 0;
      return helpers.waitForElement(() => {
        const value = check();
        if (!value) { previous = null; since = 0; return null; }
        if (value !== previous) { previous = value; since = Date.now(); }
        return Date.now() - since >= stableMs ? value : null;
      }, timeout);
    };
    try {
      report("locate");
      // The destination tab opens the feed with ?shareActive=true, so LinkedIn
      // opens the share box itself; this adapter never clicks the launcher.
      // LinkedIn mounts a placeholder share dialog first and replaces the node
      // about half a second later. Only a dialog that already renders its
      // editor or media editor is the composer; anchoring to the placeholder
      // reads as "composer closed" once it is swapped out.
      composer = await wait(() => {
        const dialog = findShareDialog(helpers);
        return dialog && (findEditor(dialog, helpers) || helpers.findVisible(MEDIA_EDITOR_SELECTOR, dialog)) ? dialog : null;
      }, COMPOSER_WAIT_MS, 250);
      report("inspect");
      const anchor = helpers.closestDeep(composer, "[data-test-modal-id='sharebox']") || composer;
      const current = () => {
        // Reacquire replaced editors without switching to another post after
        // the user closes the composer that this handoff belongs to.
        if (anchor.isConnected === false || !usable(anchor, helpers)) throw new Error("The LinkedIn composer was closed. Open a new composer to try again.");
        const dialog = findShareDialog(helpers);
        const nativeError = dialog && helpers.findVisible(".media-editor-file-selector__container-error .artdeco-empty-state__message, .artdeco-inline-feedback--error", dialog);
        if (nativeError) throw new Error(`LinkedIn: ${String(nativeError.innerText || nativeError.textContent || "The media was rejected.").trim()}`);
        return dialog && (dialog === anchor || helpers.closestDeep(dialog, "[data-test-modal-id='sharebox']") === anchor) ? dialog : null;
      };
      let state = composerStates.get(anchor);
      const id = handoff.handoffId || "legacy";
      if (!state || state.id !== id) {
        state = { id, mediaStarted: false, mediaComplete: false };
      }
      const expected = normalizeComposerText(handoff.text);
      const existingEditor = findEditor(current(), helpers);
      if (expected && editorText(existingEditor) && editorText(existingEditor) !== expected) {
        throw new Error("The LinkedIn composer already contains different text. Your existing text was preserved.");
      }
      const video = files.some(file => file.type.startsWith("video/"));
      if (files.some(file => !file.type.startsWith(video ? "video/" : "image/")) || (video && files.length > 1)) {
        throw new Error("LinkedIn needs images or a single video. Attach this selection manually.");
      }
      if (files.length) {
        if (state.mediaComplete && mediaPreviewCount(current(), helpers, video) >= files.length) mediaInserted = files.length;
        else {
          report("attach");
          if (!state.mediaStarted) {
            if (mediaPreviewCount(current(), helpers, false) || mediaPreviewCount(current(), helpers, true)) {
              throw new Error("This LinkedIn composer already has media. Review it before attaching more.");
            }
            // LinkedIn clicks its new file input automatically after Add media.
            // With a live user activation that opens an OS chooser, even though
            // we supply File objects ourselves. Cancel only that synthetic
            // default action, scoped to this composer and this opening step.
            const preventAutomaticPicker = event => {
              if (!event.isTrusted && event.composedPath().some(node => node.matches?.("input[type='file']"))) event.preventDefault();
            };
            anchor.addEventListener("click", preventAutomaticPicker, true);
            releaseFilePickerGuard = () => anchor.removeEventListener("click", preventAutomaticPicker, true);
            let mediaEditor = mediaRootOf(current(), files, helpers);
            if (mediaEditor && helpers.queryAllDeep(".media-editor-file-manager__file-preview", mediaEditor).length) {
              throw new Error("LinkedIn’s media editor already contains files. Review them before attaching more.");
            }
            if (!mediaEditor) {
              const button = helpers.findIconControl(current(), ACTION_ICONS.addMedia, "button");
              if (!usable(button, helpers)) throw new Error("LinkedIn’s Add media control is not available.");
              button.click();
              mediaEditor = await wait(() => mediaRootOf(current(), files, helpers));
            }
            const input = await wait(() => {
              const mediaRoot = mediaRootOf(current(), files, helpers);
              return mediaRoot && helpers.findCompatibleFileInput(files, mediaRoot, false);
            });
            if ((!input.multiple && files.length > 1) || (Number(input.getAttribute?.("filecountlimit")) > 0 && files.length > Number(input.getAttribute("filecountlimit")))) {
              throw new Error("The LinkedIn media picker cannot accept this many files.");
            }
            composerStates.set(anchor, state);
            state.mediaStarted = true;
            helpers.attachFilesToInput(files, input);
            releaseFilePickerGuard();
          }
          report("process-media");
          // On a repeated request, observe the same upload instead of sending
          // the files again. Only the media detour's Next button is actionable.
          const next = await wait(() => {
            const dialog = current();
            if (!dialog) return null;
            const mediaRoot = helpers.findVisible(MEDIA_EDITOR_SELECTOR, dialog);
            if (!mediaRoot) return findEditor(dialog, helpers) && mediaPreviewCount(dialog, helpers, video) >= files.length ? "attached" : null;
            // The file manager is collapsed for a single video. Its file
            // entries still establish the count; Next must be visibly usable.
            const previews = helpers.queryAllDeep(".media-editor-file-manager__file-preview", mediaRoot);
            const button = helpers.queryAllDeep(".media-detour__container .share-box-footer__primary-btn", dialog).find(e => usable(e, helpers));
            return previews.length >= files.length && button ? button : null;
          }, 120000, 350);
          if (next !== "attached") next.click();
          report("verify-media");
          await wait(() => {
            const dialog = current();
            return dialog && findEditor(dialog, helpers) && mediaPreviewCount(dialog, helpers, video) >= files.length ? dialog : null;
          }, 120000, 600);
          state.mediaComplete = true;
          mediaInserted = files.length;
        }
      }
      report("fill-text");
      const editor = await wait(() => findEditor(current(), helpers), COMPOSER_WAIT_MS, 250);
      if (editorText(editor) && editorText(editor) !== expected && expected) {
        throw new Error("The LinkedIn composer already contains different text. Your existing text was preserved.");
      }
      if (expected && !editorText(editor)) {
        // LinkedIn's shadow-root Quill can ignore synthetic paste. Use native
        // editing with a shadow-local selection, never direct DOM replacement.
        editor.focus();
        const root = editor.getRootNode();
        const selection = root.getSelection?.() || editor.ownerDocument.defaultView.getSelection();
        const range = editor.ownerDocument.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges(); selection.addRange(range);
        if (editor.isConnected === false) throw new Error("LinkedIn replaced the editor before text could be inserted.");
        editor.ownerDocument.execCommand("insertText", false, handoff.text);
      }
      report("verify-text");
      if (expected) await wait(() => {
        const liveEditor = findEditor(current(), helpers);
        return liveEditor && editorText(liveEditor) === expected ? liveEditor : null;
      }, 10000, 750);
      textInserted = true;
      report("verify");
      await wait(() => {
        const dialog = current();
        if (!dialog || (expected && editorText(findEditor(dialog, helpers)) !== expected)) return null;
        if (files.length && mediaPreviewCount(dialog, helpers, video) < files.length) return null;
        return (!expected && !files.length) || findPostButton(dialog, helpers) ? dialog : null;
      }, 120000, 750);
      report("ready");
      return result("");
    } catch (error) {
      const messages = {
        locate: "LinkedIn’s post composer did not open. Check that you are logged in, then try again.",
        attach: "LinkedIn’s media picker did not become ready.", "process-media": "LinkedIn has not finished preparing the media. Check its media editor before trying again.",
        "verify-media": "The expected media previews did not appear in the LinkedIn post.",
        "fill-text": "LinkedIn’s text editor did not become ready.", "verify-text": "LinkedIn did not retain the expected post text.",
        verify: "LinkedIn has not finished preparing the post. Review the text and attachments."
      };
      return result(error.message === "The native composer did not appear." ? messages[stage] : error.message);
    } finally {
      releaseFilePickerGuard();
    }
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
    const text = typeof helpers.textWithout === "function"
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

})();
