(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;
  core.register({
    id: "bluesky",
    matches: host => host === "bsky.app" || host.endsWith(".bsky.app"),
    postSelectors: ["[data-testid='postThreadItem']", "article"],
    // Keep capture focused on the authored copy. Besides excluding post chrome,
    // this prevents the generic fallback from cloning a live video player.
    captureText: ({ post }) => {
      const text = post.querySelector("[data-testid='postText']");
      return (text?.innerText || text?.textContent || "").trim();
    },
    sourceAuthor: ({ post, helpers }) => helpers.firstText(post, ["[data-testid='displayName']", "a[href*='/profile/'] span"])
      || helpers.identityFromHref(post.querySelector("a[href*='/profile/']")?.getAttribute("href"), /\/profile\/([^/?#]+)/i),
    isOwnPost: ({ post, helpers }) => {
      const profilePattern = /\/profile\/([^/?#]+)/i;
      const authoredBy = helpers.identityFromHref(post.querySelector("a[href*='/profile/']")?.getAttribute("href"), profilePattern);
      const signedInAs = helpers.identityFromHref(document.querySelector("nav a[href*='/profile/'], a[aria-label*='profile' i][href*='/profile/']")?.getAttribute("href"), profilePattern);
      return Boolean(authoredBy && signedInAs && authoredBy === signedInAs);
    },
    videoInfo: ({ target }) => {
      const link = target?.closest?.("a[href*='/post/']") || document.querySelector("a[href*='/post/']");
      const href = link?.getAttribute?.("href") || location.pathname;
      const post = href.match(/\/profile\/([^/]+)\/post\/([^/?#]+)/) || location.pathname.match(/\/profile\/([^/]+)\/post\/([^/?#]+)/);
      return { source: "bluesky", actor: post?.[1] || null, rkey: post?.[2] || null };
    },
    nativePostSubmission: ({ target, helpers }) => {
      const button = helpers.closestDeep(target, "button, [role='button']");
      const composer = helpers.closestDeep(button, "[role='dialog'], dialog");
      const submit = button?.matches?.("[data-testid='composerPostButton']") || helpers.normalizeText(button) === "post";
      const field = composer && helpers.findVisible("textarea, [contenteditable='true'][role='textbox']", composer);
      if (!button || !composer || !submit || !field || button.disabled) return null;
      return { isOpen: () => composer.isConnected && helpers.isVisible(composer) };
    },
    async openComposer({ handoff, files, helpers }) {
      if (!(location.hostname === "bsky.app" || location.hostname.endsWith(".bsky.app"))) throw new Error("Open Bluesky in this tab, then use the Crossposter sidebar.");
      const selector = "textarea[placeholder*='What'], [data-testid='composePostTextArea'], [role='dialog'] textarea, [role='dialog'] [contenteditable='true']";
      let field = helpers.findVisible(selector);
      if (!field) {
        const launch = helpers.findVisible("[data-testid='composeFAB'], button[aria-label*='compose' i][aria-label*='post' i], a[href*='/intent/compose']")
          || helpers.findClickable("New post", document, element => !element.closest("[role='dialog']"), false);
        if (!launch) return helpers.manualResult("Open Bluesky’s post composer, then use the Crossposter sidebar.");
        launch.click();
        try { field = await helpers.waitForElement(() => helpers.findVisible(selector)); }
        catch { return helpers.manualResult("Open Bluesky’s post composer, then use the Crossposter sidebar."); }
      }
      return helpers.fillNativeComposer(field, handoff.text || "", files);
    }
  });
})();
