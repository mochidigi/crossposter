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
    const regionTrigger = helpers.queryAllDeep("[role='region'], [data-pagelet$='Composer']")
      .filter(region => outsideDialog(region) && region.querySelector?.("a[href]"))
      .map(region => {
        const buttons = helpers.queryAllDeep("[role='button']", region).filter(element => helpers.isVisible(element));
        const text = buttons.filter(element => textOnly(element, helpers));
        return buttons.length >= 3 && text.length === 1 && buttons.length - text.length >= 2 ? text[0] : null;
      })
      .find(Boolean);
    return regionTrigger
      || helpers.queryAllDeep("[role='button']")
        .find(element => helpers.isVisible(element) && outsideDialog(element) && /what.s on your mind/i.test(element.innerText || ""))
      || null;
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
      const selector = "[role='dialog'] [contenteditable='true'][role='textbox']";
      let field = helpers.findVisible(selector);
      if (!field) {
        const launch = composerLauncher(helpers);
        if (!launch) return helpers.manualResult("Open Facebook’s Create post dialog, then use the Crossposter sidebar.");
        launch.click();
        try { field = await helpers.waitForElement(() => helpers.findVisible(selector)); }
        catch { return helpers.manualResult("Open Facebook’s Create post dialog, then use the Crossposter sidebar."); }
      }
      // Facebook's composer is a Lexical editor: paste insertion is reliable
      // where execCommand-style writes are not.
      const textInserted = await helpers.pasteComposerText(field, handoff.text || "");
      let mediaInserted = 0;
      if (files.length) {
        const root = helpers.closestDeep(field, "[role='dialog'], dialog") || document;
        try { await helpers.waitForElement(() => helpers.findCompatibleFileInput(files, root, false), 15000); } catch {}
        mediaInserted = helpers.attachNativeFiles(files, root);
      }
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
    const raw = message && typeof helpers.textWithout === "function" && typeof message.cloneNode === "function"
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
