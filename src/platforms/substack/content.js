(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;

  // Substack Notes live on substack.com itself; publication sites
  // (*.substack.com, custom domains) only render posts.
  const isSubstackHost = host => host === "substack.com" || host === "www.substack.com";
  // Notes in the feed and in reply threads are feed units keyed by their
  // comment id ("c-123"); posts in the feed use "p-". A directly loaded note
  // permalink renders its main note in an unkeyed permalink unit instead, and
  // the note id is then only in the URL.
  const NOTE_SELECTOR = "[data-entity-key^='c-'], [class*='feedPermalinkUnit-']";
  // Substack localizes aria-labels, so controls are matched by icon geometry
  // and data-testid; the English labels are only a last fallback.
  const ICONS = Object.freeze({
    share: { paths: ["M10.2171 2.2793"], labels: ["share"] }
  });
  const COMPOSER_FIELD = "[contenteditable='true'][role='textbox']";
  const POST_BUTTON = "[data-testid='composer-post']";
  const ATTACHMENT_REMOVE = "[data-testid='remove-attachment']";
  const VIDEO_PREVIEW = "video[data-video-id]";
  const COMPOSER_WAIT_MS = 20000;
  const DOCUMENT_POSITION_FOLLOWING = 4;

  const noteByPost = new WeakMap();
  const noteRequests = new Map();
  const composerStates = new WeakMap();

  core.register({
    id: "substack",
    matches: isSubstackHost,
    postSelectors: [NOTE_SELECTOR],
    inlineActionMount: ({ post, helpers }) => {
      if (!noteId(post)) return null;
      // Clone Share so the Crosspost action matches the native row. A reply
      // thread nests notes, so the Share button must belong to this note.
      const share = helpers.queryAllDeep("button", post)
        .find(button => button.closest?.(NOTE_SELECTOR) === post && helpers.iconMatches(button, ICONS.share));
      const row = share?.parentElement;
      if (!row || row.querySelectorAll(":scope > button").length < 4) return null;
      return { container: row, template: share };
    },
    prepareCapture: async ({ post }) => {
      if (!post || noteByPost.has(post)) return;
      const id = noteId(post);
      if (!id) { noteByPost.set(post, null); return; }
      let request = noteRequests.get(id);
      if (!request) {
        request = fetchNote(id);
        noteRequests.set(id, request);
      }
      try { noteByPost.set(post, await request); }
      catch { noteByPost.set(post, null); }
    },
    // The note API's plain body already carries every inline link as its full
    // URL. The rendered body shows links as truncated labels instead.
    captureText: ({ post, helpers }) => {
      const note = noteByPost.get(post);
      if (typeof note?.body === "string") return note.body.trim();
      const body = noteBody(post);
      if (!body) return "";
      const anchors = [...body.querySelectorAll("a[href]")].filter(anchor => externalUrl(anchor.href || anchor.getAttribute("href")));
      return helpers.textWithLinkUrls(body, anchors);
    },
    captureMedia: ({ post, helpers }) => {
      const note = noteByPost.get(post);
      if (Array.isArray(note?.attachments)) return attachmentMedia(note.attachments, post);
      const videos = [...post.querySelectorAll("video[data-video-id]")].filter(video => video.closest(NOTE_SELECTOR) === post);
      const images = [...post.querySelectorAll("img")].filter(image => image.closest(NOTE_SELECTOR) === post
        && !image.closest("a[href]") && /substack-post-media|substackcdn\.com/i.test(image.currentSrc || image.src || ""));
      return [
        ...videos.map(video => ({ kind: "video", url: videoUrl(video.dataset.videoId), poster: video.poster || "" })),
        ...helpers.mediaFromNodes(images)
      ].slice(0, 4);
    },
    // Link cards and restacked posts sit beside the note text. Inline links
    // are already in the body text.
    captureLinks: ({ post }) => {
      const note = noteByPost.get(post);
      const body = typeof note?.body === "string" ? note.body : "";
      return (note?.attachments || []).map(attachment => {
        const url = attachment?.type === "post" ? attachment.post?.canonical_url
          : attachment?.type === "link" ? attachment.linkMetadata?.url || attachment.url
          : "";
        const title = attachment?.post?.title || attachment?.linkMetadata?.title || "";
        return url ? { url, display: "", title, inText: body.includes(url) } : null;
      }).filter(Boolean);
    },
    sourceUrl: ({ post }) => {
      const id = noteId(post);
      const permalink = id && post.querySelector(`a[href*='/note/c-${id}']`)?.getAttribute("href");
      if (permalink) {
        try { return new URL(permalink, location.origin).href; } catch {}
      }
      const handle = noteByPost.get(post)?.handle;
      return id && handle ? `https://substack.com/@${handle}/note/c-${id}` : location.href;
    },
    sourceAuthor: ({ post }) => {
      const note = noteByPost.get(post);
      if (note?.name) return String(note.name).trim();
      const link = profileLinks(post).find(anchor => String(anchor.innerText || anchor.textContent || "").trim());
      return String(link?.innerText || link?.textContent || "").replace(/\s+/g, " ").trim();
    },
    isOwnPost: ({ post, helpers }) => {
      const authoredBy = String(noteByPost.get(post)?.handle || "").toLowerCase()
        || helpers.identityFromHref(profileLinks(post)[0]?.getAttribute("href"), /^\/@([^/?#]+)/);
      const signedInAs = helpers.identityFromHref(signedInProfileLink()?.getAttribute("href"), /^\/@([^/?#]+)/);
      return Boolean(authoredBy && signedInAs && authoredBy === signedInAs);
    },
    videoInfo: ({ post, video }) => {
      const id = video?.dataset?.videoId
        || (noteByPost.get(post)?.attachments || []).find(attachment => attachment?.type === "video")?.media_upload_id;
      return { source: "substack", src: id ? videoUrl(id) : video?.currentSrc || video?.src || "" };
    },
    // A cancelled or posted composer stays in the DOM with data-state
    // "closed", so visibility alone does not mean it is still open.
    nativePostSubmission: ({ target, helpers }) => {
      const button = helpers.closestDeep(target, "button");
      if (!button?.matches?.(POST_BUTTON) || button.disabled) return null;
      const composer = helpers.closestDeep(button, "[role='dialog']");
      if (!composer || !isOpenDialog(composer)) return null;
      return { isOpen: () => composer.isConnected && isOpenDialog(composer) };
    },
    async openComposer({ handoff, files, helpers }) {
      if (!isSubstackHost(location.hostname)) throw new Error("Open Substack in this tab, then use the Crossposter sidebar.");
      // Each stage waits for evidence that it completed before the next one
      // starts, and a failure names the stage that did not (as on LinkedIn).
      const started = Date.now(), stages = [];
      let stage = "locate", composer = null, textInserted = false, mediaInserted = 0;
      const report = name => {
        stage = name;
        stages.push({ stage, elapsedMs: Date.now() - started });
        helpers.reportComposerStage?.(handoff.handoffId, "substack", stage);
      };
      const result = (error, extra = {}) => ({ ok: true, composerOpened: Boolean(composer), textInserted, mediaInserted,
        stage, stages, retryable: false, error, ...extra });
      const wait = (check, timeout = COMPOSER_WAIT_MS, stableMs = 0) => {
        let previous = null, since = 0;
        return helpers.waitForElement(() => {
          const value = check();
          if (!value) { previous = null; since = 0; return null; }
          if (value !== previous) { previous = value; since = Date.now(); }
          return Date.now() - since >= stableMs ? value : null;
        }, timeout);
      };
      const current = () => {
        if (!composer.isConnected || !isOpenDialog(composer)) throw new Error(MESSAGES.closed);
        return composer;
      };
      const editor = () => helpers.findVisible(COMPOSER_FIELD, current());
      const expected = normalizeComposerText(handoff.text);
      try {
        report("locate");
        composer = findComposer(helpers);
        if (!composer) {
          // The destination tab may still be rendering the feed. A signed-out
          // page never shows the launcher, so stop waiting as soon as it is
          // recognizable instead of timing out.
          let launch;
          try { launch = await wait(() => findLauncher(helpers) || findComposer(helpers) || (signedOut() ? "signed-out" : null)); }
          catch { return result(MESSAGES.locate); }
          if (launch === "signed-out") return result(MESSAGES["signed-out"], { reason: "signed-out" });
          if (isOpenDialog(launch)) composer = launch;
          else {
            report("open");
            launch.click();
            try { composer = await wait(() => findComposer(helpers), COMPOSER_WAIT_MS, 250); }
            catch { return result(MESSAGES.open); }
          }
        }

        report("inspect");
        let state = composerStates.get(composer);
        const id = handoff.handoffId || "legacy";
        if (!state || state.id !== id) state = { id, mediaStarted: false };
        const existing = normalizeComposerText(composerText(editor()));
        if (expected && existing && existing !== expected) throw new Error(MESSAGES["existing-text"]);
        if (files.length && !state.mediaStarted && attachmentCount(current(), helpers)) throw new Error(MESSAGES["existing-media"]);

        if (files.length) {
          report("attach");
          let expectedMedia = state.expectedMedia || 0;
          if (!state.mediaStarted) {
            const input = await wait(() => helpers.findCompatibleFileInput(files, current(), false));
            composerStates.set(composer, state);
            state.mediaStarted = true;
            expectedMedia = state.expectedMedia = helpers.attachFilesToInput(files, input);
            if (!expectedMedia) throw new Error(MESSAGES.attach);
          }
          // Each preview gets its remove control once Substack has taken the
          // file; a redelivered handoff observes the same upload again.
          report("process-media");
          await wait(() => attachmentCount(current(), helpers) >= expectedMedia, 120000);
          report("verify-media");
          await wait(() => attachmentCount(current(), helpers) >= expectedMedia && !uploading(current(), helpers) ? current() : null, 120000, 600);
          mediaInserted = expectedMedia;
        }

        report("fill-text");
        const field = await wait(editor);
        if (expected && !normalizeComposerText(composerText(field))) {
          // Chrome: a synthetic paste becomes proper paragraphs and linked
          // URLs in Substack's Tiptap editor. Firefox: one native insertText.
          await helpers.fillComposerTextOnce(field, composer, String(handoff.text || ""));
        }
        report("verify-text");
        if (expected) await wait(() => normalizeComposerText(composerText(editor())) === expected ? current() : null, 10000, 500);
        textInserted = Boolean(expected);

        report("verify");
        await wait(() => {
          const dialog = current();
          if (expected && normalizeComposerText(composerText(editor())) !== expected) return null;
          if (files.length && attachmentCount(dialog, helpers) < mediaInserted) return null;
          const post = dialog.querySelector(POST_BUTTON);
          return (!expected && !files.length) || (post && !post.disabled) ? dialog : null;
        }, 120000, 750);
        report("ready");
        return result("");
      } catch (error) {
        return result(error?.message === "The native composer did not appear." ? MESSAGES[stage] || MESSAGES.verify : error?.message || MESSAGES.verify);
      }
    }
  });

  // What the sidebar shows when a stage does not complete. Each message names
  // the step so the user knows how far the handoff got.
  const MESSAGES = Object.freeze({
    "signed-out": "You are not signed in to Substack in this browser. Sign in to Substack, then use the Crossposter sidebar.",
    locate: "Substack’s note composer and its launcher were not found. Open Substack’s note composer, then use the Crossposter sidebar.",
    open: "Substack’s note composer did not open. Open it yourself, then use the Crossposter sidebar.",
    closed: "The Substack note composer was closed. Open a new composer to try again.",
    "existing-text": "The Substack note composer already contains different text. Your existing text was preserved.",
    "existing-media": "This Substack note already has attachments. Review them before attaching more.",
    inspect: "Substack’s note composer did not become ready.",
    attach: "Substack’s note composer did not accept the media. Drag the media from the sidebar.",
    "process-media": "Substack has not finished uploading the media. Check the note before trying again.",
    "verify-media": "The expected media previews did not appear in the Substack note.",
    "fill-text": "Substack’s note editor did not become ready. Copy the text from the sidebar.",
    "verify-text": "Substack did not keep the expected note text. Copy the text from the sidebar.",
    verify: "Substack has not finished preparing the note. Review the text and attachments."
  });

  function noteId(post) {
    const keyed = String(post?.getAttribute?.("data-entity-key") || "").match(/^c-(\d+)$/)?.[1];
    if (keyed) return keyed;
    return /(?:^|\s)feedPermalinkUnit-/.test(String(post?.className || "")) ? location.pathname.match(/\/note\/c-(\d+)/)?.[1] || "" : "";
  }

  async function fetchNote(id) {
    const response = await fetch(new URL(`/api/v1/reader/comment/${encodeURIComponent(id)}`, location.origin).href, { credentials: "include" });
    if (!response.ok) return null;
    return (await response.json())?.item?.comment || null;
  }

  // Substack redirects this to the upload's current MP4 rendition (Mux), so
  // the URL stays valid after the signed stream token would have expired.
  function videoUrl(id) {
    return `https://substack.com/api/v1/video/upload/${encodeURIComponent(id)}/src?type=mp4`;
  }

  function attachmentMedia(attachments, post) {
    return attachments.map(attachment => {
      if (attachment?.type === "image" && /^https?:/i.test(attachment.imageUrl || "")) return { kind: "image", url: attachment.imageUrl };
      if (attachment?.type === "video" && attachment.media_upload_id) {
        const video = [...(post?.querySelectorAll?.("video[data-video-id]") || [])].find(node => node.dataset?.videoId === attachment.media_upload_id);
        return { kind: "video", url: videoUrl(attachment.media_upload_id), poster: video?.poster || "" };
      }
      return null;
    }).filter(Boolean).slice(0, 4);
  }

  function noteBody(post) {
    return [...post.querySelectorAll(".FeedProseMirror, .ProseMirror")].find(node => node.closest(NOTE_SELECTOR) === post) || null;
  }

  function externalUrl(href = "") {
    try {
      const url = new URL(href, location.origin);
      return /^https?:$/.test(url.protocol) && !isSubstackHost(url.hostname) ? url.href : "";
    } catch { return ""; }
  }

  // Author links point at /@handle; the note's own permalink is /@handle/note/….
  function profileLinks(post) {
    return [...post.querySelectorAll("a[href^='/@']")]
      .filter(anchor => anchor.closest(NOTE_SELECTOR) === post && !anchor.getAttribute("href").includes("/note/"));
  }

  function signedInProfileLink() {
    return document.querySelector("[role='navigation'] a[href^='/@']");
  }

  function signedOut() {
    return !signedInProfileLink() && Boolean(document.querySelector("a[href*='substack.com/signup'], a[href^='/signup'], a[href*='/sign-in']"));
  }

  function isOpenDialog(element) {
    return element?.getAttribute?.("role") === "dialog" && element.getAttribute("data-state") === "open";
  }

  function findComposer(helpers) {
    return helpers.queryAllDeep("[role='dialog'][data-state='open']")
      .find(dialog => dialog.querySelector(POST_BUTTON) && helpers.findVisible(COMPOSER_FIELD, dialog)) || null;
  }

  // The feed's "What's on your mind?" launcher is the only avatar-only button
  // above the notes feed. Its aria-label ("New post") is localized.
  function findLauncher(helpers) {
    const candidates = helpers.queryAllDeep("button").filter(button => helpers.isVisible(button) && !button.disabled
      && button.querySelector("img") && !button.querySelector("svg")
      && !button.closest(`[role='article'], [role='dialog'], [role='navigation'], ${NOTE_SELECTOR}`));
    const feed = [...document.querySelectorAll("[role='region']")].find(region => region.querySelector(NOTE_SELECTOR));
    return (feed && candidates.find(button => button.compareDocumentPosition(feed) & DOCUMENT_POSITION_FOLLOWING))
      || candidates.find(button => /^new post$/i.test(button.getAttribute("aria-label") || ""))
      || null;
  }

  // Images get a remove-attachment control each; an uploaded video shows as
  // a player keyed by its upload id, whose remove button has no test id.
  function attachmentCount(composer, helpers) {
    return helpers.queryAllDeep(ATTACHMENT_REMOVE, composer).length
      + helpers.queryAllDeep(VIDEO_PREVIEW, composer).length;
  }

  function uploading(composer, helpers) {
    return helpers.queryAllDeep("[role='progressbar'], progress, [aria-busy='true']", composer).some(helpers.isVisible);
  }

  function composerText(field) {
    return field?.innerText ?? field?.textContent ?? "";
  }

  // Tiptap renders each line as a paragraph (Firefox's insertText adds an
  // empty one per blank line) and links URLs, so compare the words only.
  function normalizeComposerText(value) {
    return String(value || "").replace(/[​-‍⁠﻿]/g, "").replace(/\s+/g, " ").trim();
  }
})();
