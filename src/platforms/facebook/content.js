(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;
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
      const submit = helpers.normalizeText(button) === "post";
      const field = composer && helpers.findVisible("[contenteditable='true'][role='textbox']", composer);
      if (!button || !composer || !submit || !field) return null;
      return { isOpen: () => composer.isConnected && helpers.isVisible(composer) };
    },
    async openComposer({ handoff, files, helpers }) {
      if (!(location.hostname === "facebook.com" || location.hostname.endsWith(".facebook.com"))) throw new Error("Open Facebook in this tab, then use the Crossposter sidebar.");
      const selector = "[role='dialog'] [contenteditable='true'][role='textbox']";
      let field = helpers.findVisible(selector);
      if (!field) {
        const launch = helpers.queryAllDeep("[role='button']")
          .find(element => helpers.isVisible(element) && !element.closest("[role='dialog']") && /what.s on your mind/i.test(element.innerText || ""));
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
    const text = (message?.innerText || message?.textContent || "")
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
    const controls = helpers.queryAllDeep("button, [role='button']", message)
      .filter(element => /^(?:…|\.\.\.)?\s*see more$/iu.test(helpers.normalizeText(element)));
    controls.forEach(control => control.click?.());
    if (controls.length) await new Promise(resolve => setTimeout(resolve, 0));
  }
})();
