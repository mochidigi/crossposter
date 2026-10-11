(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;
  // Facebook localizes button labels and the composer placeholder with the
  // account language. Its feed keeps stable data-ad-rendering-role hooks for
  // post parts; the composer is recognized by shape, with English fallbacks.
  const hasIcon = element => Boolean(element?.querySelector?.("svg, img, i"));
  const textOnly = (element, helpers) => helpers.isVisible(element) && !hasIcon(element) && Boolean(helpers.normalizeText(element));

  // The feed/profile composer card is a labelled region (its label, "Create a
  // post", is localized) holding the viewer's timeline link, one text-only
  // trigger button, and icon shortcuts (live, photo/video, feeling).
  function composerLauncher(helpers) {
    const outsideDialog = element => !element.closest("[role='dialog']");
    const region = composerRegion(helpers);
    return (region && regionTrigger(region, helpers))
      || helpers.queryAllDeep("[role='button']")
        .find(element => helpers.isVisible(element) && outsideDialog(element) && /what.s on your mind/i.test(element.innerText || ""))
      || null;
  }

  function composerRegion(helpers) {
    return helpers.queryAllDeep("[role='region'], [data-pagelet$='Composer']")
      .find(region => !region.closest("[role='dialog']") && region.querySelector?.("a[href]") && regionTrigger(region, helpers)) || null;
  }

  function regionTrigger(region, helpers) {
    const buttons = helpers.queryAllDeep("[role='button']", region).filter(element => helpers.isVisible(element));
    const text = buttons.filter(element => textOnly(element, helpers));
    return buttons.length >= 3 && text.length === 1 && buttons.length - text.length >= 2 ? text[0] : null;
  }

  // Profile links come as /<username>, /profile.php?id=<id>, or in groups as
  // /groups/<group>/user/<id>/, each with varying tracking parameters.
  const RESERVED_PATHS = new Set(["home.php", "watch", "groups", "marketplace", "gaming", "events", "friends", "pages", "reel", "reels", "stories", "photo", "photo.php", "photos", "videos", "permalink.php", "story.php", "notifications", "messages", "bookmarks", "saved", "me", "settings", "help", "search", "hashtag", "login", "share"]);
  function facebookProfileIdentity(href) {
    let url;
    try { url = new URL(href, location.origin || "https://www.facebook.com"); } catch { return ""; }
    if (!/(?:^|\.)facebook\.com$/i.test(url.hostname)) return "";
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/profile.php") return url.searchParams.get("id") ? `id:${url.searchParams.get("id")}` : "";
    const numeric = path.match(/^\/(?:groups\/[^/]+\/user|people\/[^/]+)\/(\d+)$/);
    if (numeric) return `id:${numeric[1]}`;
    const vanity = path.match(/^\/([A-Za-z0-9.]+)$/);
    return vanity && !RESERVED_PATHS.has(vanity[1].toLowerCase()) ? vanity[1].toLowerCase() : "";
  }

  // The post's author link against the viewer's own timeline link, which the
  // feed's "create a post" card leads with. Pages without that card (a single
  // post, a Page) leave the viewer unknown, so nothing counts as their own.
  function facebookIsOwnPost({ post, helpers }) {
    const author = helpers.queryAllDeep("[data-ad-rendering-role='profile_name'] a[href]", post)[0];
    const authoredBy = facebookProfileIdentity(author?.getAttribute?.("href"));
    const region = authoredBy ? composerRegion(helpers) : null;
    const signedInAs = region ? [...region.querySelectorAll("a[href]")].map(link => facebookProfileIdentity(link.getAttribute("href"))).find(Boolean) : "";
    return Boolean(authoredBy && signedInAs && authoredBy === signedInAs);
  }

  // The create-post dialog ends with its submit button, the last text-only
  // control in it (the audience selector and attachment shortcuts carry
  // icons; "Add to your post" is a text label but precedes the footer).
  function submitButton(composer, helpers) {
    const candidates = helpers.queryAllDeep("button, [role='button']", composer)
      .filter(element => textOnly(element, helpers) && !element.getAttribute?.("aria-haspopup"));
    const submit = candidates.find(element => helpers.normalizeText(element) === "post") || candidates.at(-1) || null;
    return submit && submit.getAttribute?.("aria-disabled") !== "true" ? submit : null;
  }

  core.register({
    id: "facebook",
    matches: host => host === "facebook.com" || host.endsWith(".facebook.com"),
    postSelectors: ["[data-virtualized]"],
    sourceAuthor: facebookSourceAuthor,
    isOwnPost: facebookIsOwnPost,
    captureText: facebookCaptureText,
    captureMedia: facebookCaptureMedia,
    videoInfo: facebookVideoInfo,
    prepareCapture: ({ post, helpers }) => expandFacebookText(post, helpers),
    inlineActionMount: ({ post }) => {
      const shareMarker = post.querySelector("[data-ad-rendering-role='share_button']");
      const like = post.querySelector("[data-ad-rendering-role='like_button']");
      const reference = shareMarker?.closest("[role='button']");
      const template = reference?.parentElement;
      const container = template?.parentElement;
      return like && container?.contains(like) && container.contains(reference)
        ? { container, template, actionSelector: "[role='button']", iconOnly: true }
        : null;
    },
    nativePostSubmission: ({ target, helpers }) => {
      const button = helpers.closestDeep(target, "button, [role='button']");
      const composer = helpers.closestDeep(button, "[role='dialog'], dialog");
      const submit = Boolean(button) && (helpers.normalizeText(button) === "post" || button === submitButton(composer, helpers));
      const field = composer && helpers.findVisible("[contenteditable='true'][role='textbox']", composer);
      if (!button || !composer || !submit || !field) return null;
      return { isOpen: () => composer.isConnected && helpers.isVisible(composer) };
    },
    async openComposer({ handoff, files, helpers }) {
      if (!(location.hostname === "facebook.com" || location.hostname.endsWith(".facebook.com"))) throw new Error("Open Facebook in this tab, then use the Crossposter sidebar.");
      const report = stage => helpers.reportComposerStage?.(handoff.handoffId, "facebook", stage);
      const selector = "[role='dialog'] [contenteditable='true'][role='textbox']";
      report("locate");
      let field = helpers.findVisible(selector);
      if (!field) {
        const launch = composerLauncher(helpers);
        if (!launch) return helpers.composerNotFound("Open Facebook’s Create post dialog, then use the Crossposter sidebar.");
        report("open");
        launch.click();
        try { field = await helpers.waitForElement(() => helpers.findVisible(selector)); }
        catch { return helpers.composerNotFound("Open Facebook’s Create post dialog, then use the Crossposter sidebar."); }
      }
      report("fill-text");
      // Facebook's composer is a Lexical editor: in Chrome a synthetic paste
      // is the reliable route where execCommand-style writes are not, and in
      // Firefox a single native insertText is. Either way the caption goes in
      // exactly once per composer — a verified paste followed by an insertText
      // fallback duplicated it when Lexical published its DOM late.
      const root = helpers.closestDeep(field, "[role='dialog'], dialog") || document;
      const textInserted = await helpers.fillComposerTextOnce(field, root, handoff.text || "");
      let mediaInserted = 0;
      if (files.length) {
        report("attach");
        try { await helpers.waitForElement(() => helpers.findCompatibleFileInput(files, root, false), 15000); } catch {}
        mediaInserted = helpers.attachNativeFiles(files, root);
      }
      if (textInserted && (!files.length || mediaInserted)) report("ready");
      return { ok: true, composerOpened: true, textInserted, mediaInserted, error: textInserted ? "" : "Use the Crossposter sidebar to finish the handoff." };
    }
  });

  function facebookMessageElement(post, helpers) {
    const selectors = [
      "[data-ad-rendering-role='story_message']",
      "[data-ad-preview='message']",
      "[data-testid='post_message']"
    ];
    for (const selector of selectors) {
      const element = helpers.queryAllDeep(selector, post)[0];
      if (element) return element;
    }
    return null;
  }

  function facebookCaptureText({ post, helpers }) {
    const message = facebookMessageElement(post, helpers);
    // Expanders ("See more" / "Visa mer") are buttons inside the message; drop
    // them by element so the trailing-label regex is only a fallback.
    const raw = message && typeof helpers.textWithout === "function"
      ? helpers.textWithout(message, "[role='button'], button")
      : message?.innerText || message?.textContent || "";
    const text = raw
      .replace(/\r\n?/g, "\n")
      .replace(/\s*(?:…|\.\.\.)?\s*see (?:more|less)\s*$/iu, "")
      .trim();
    // Facebook uses adjacent block elements for paragraphs. innerText emits a
    // single newline between them, so restore the blank line users see.
    return text.replace(/\n(?:[ \t]*\n)*/g, "\n\n");
  }

  function facebookSourceAuthor({ post, helpers }) {
    const author = helpers.queryAllDeep("[data-ad-rendering-role='profile_name']", post)[0];
    return (author?.innerText || author?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function facebookCaptureMedia({ post, helpers }) {
    const video = post.querySelector?.("video");
    if (video) {
      const captured = helpers.mediaFromNodes([video]);
      if (captured.length) return captured;
      const videoId = facebookVideoId(post);
      return videoId ? [{
        kind: "video",
        url: `https://www.facebook.com/watch/?v=${videoId}`,
        poster: video.poster || ""
      }] : [];
    }
    const nodes = helpers.queryAllDeep("img, video", post).filter(node => {
      const source = node.currentSrc || node.src || "";
      const width = node.naturalWidth || node.width || 0;
      const height = node.naturalHeight || node.height || 0;
      return /^https?:/i.test(source) && width >= 180 && height >= 100
        && !/(?:avatar|profile|emoji|reaction|icon)/i.test(`${node.alt || ""} ${node.getAttribute?.("aria-label") || ""}`);
    });
    return helpers.mediaFromNodes(nodes);
  }

  function facebookVideoId(post) {
    return post.querySelector?.("[data-video-id]")?.getAttribute("data-video-id") || "";
  }

  function facebookVideoInfo({ post, video }) {
    return {
      source: "facebook",
      videoId: facebookVideoId(post),
      src: video?.currentSrc || video?.src || ""
    };
  }

  async function expandFacebookText(post, helpers) {
    const message = facebookMessageElement(post, helpers);
    if (!message) return;
    // Only expanders live inside the message body as buttons; match them by
    // shape (short, text-only) rather than by the localized "See more" label.
    const controls = helpers.queryAllDeep("button, [role='button']", message)
      .filter(element => /^(?:…|\.\.\.)?\s*see more$/iu.test(helpers.normalizeText(element))
        || (!hasIcon(element) && helpers.normalizeText(element).length <= 24 && helpers.normalizeText(element).length > 0));
    controls.forEach(control => control.click?.());
    if (controls.length) await new Promise(resolve => setTimeout(resolve, 0));
  }
})();
