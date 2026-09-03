(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;
  core.register({
    id: "x",
    matches: host => host === "x.com" || host.endsWith("twitter.com"),
    postSelectors: ["article", "[data-testid='tweet']"],
    nativeMenuActionSource: ({ target }) => {
      const trigger = target?.closest?.("button[aria-haspopup='menu']");
      const group = trigger?.closest?.("div[role='group']");
      const post = trigger?.closest?.("article, [data-testid='tweet']");
      if (!post || !group?.querySelector("[data-testid='reply']") || !group.querySelector("[data-testid='like'], [data-testid='unlike']")) return null;
      // The repost trigger also opens a menu from this group; the share
      // trigger is the group's last menu button in every UI language.
      const menuTriggers = [...group.querySelectorAll("button[aria-haspopup='menu']")];
      if (menuTriggers.length && menuTriggers.at(-1) !== trigger) return null;
      return { post, trigger };
    },
    nativeMenuActionMount: ({ menu, context, helpers }) => {
      const container = menu.querySelector("[data-testid='Dropdown']");
      const items = [...(container?.querySelectorAll(":scope > [role='menuitem']") || [])];
      if (items.length < 2) return null;
      // The menu belongs to the share trigger we recorded while it is the one
      // currently expanded; the "Copy link" label is a fallback for markup
      // that omits aria-expanded (labels are localized, e.g. "Kopiera länk").
      const ownMenu = context?.trigger?.getAttribute?.("aria-expanded") === "true";
      if (!ownMenu && !items.some(item => helpers.normalizeText(item).toLowerCase() === "copy link")) return null;
      return { container, template: items.at(-1) };
    },
    captureText: ({ post }) => post.querySelector("[data-testid='tweetText']")?.innerText?.trim() || "",
    captureMedia: ({ post, helpers }) => helpers.mediaFromNodes(post.querySelectorAll("[data-testid='tweetPhoto'] img, [data-testid='videoComponent'] video")),
    sourceUrl: ({ post }) => {
      // Ad tweets have no timestamp permalink; their only status anchor is the
      // /analytics link, so accept any status href and trim it to the canonical URL.
      for (const link of post.querySelectorAll("a[href*='/status/']")) {
        const match = link.href.match(/^(https:\/\/[^/]+\/[^/]+\/status\/\d+)(?:$|[/?#])/);
        if (match) return match[1];
      }
      return "";
    },
    sourceAuthor: ({ post, helpers }) => {
      const author = post.querySelector("[data-testid='User-Name']");
      return [...(author?.querySelectorAll("span") || [])].map(node => node.textContent?.replace(/\s+/g, " ").trim())
        .find(value => value && !value.startsWith("@") && value !== "·")
        || helpers.authorHandle(author?.querySelector("a[href^='/']")?.getAttribute("href"));
    },
    isOwnPost: ({ post, helpers }) => {
      const authoredBy = helpers.identityFromHref(post.querySelector("[data-testid='User-Name'] a[href^='/']")?.getAttribute("href"));
      const signedInAs = helpers.identityFromHref(document.querySelector("a[data-testid='AppTabBar_Profile_Link'][href^='/']")?.getAttribute("href"));
      return Boolean(authoredBy && signedInAs && authoredBy === signedInAs);
    },
    videoInfo: ({ post }) => ({
      source: "x",
      tweetId: (post.querySelector("a[href*='/status/']")?.href || location.href).match(/status\/(\d+)/)?.[1] || null
    }),
    nativePostSubmission: ({ target, helpers }) => {
      const button = target?.closest?.("[data-testid='tweetButton'], [data-testid='tweetButtonInline']");
      const field = helpers.findVisible("[data-testid='tweetTextarea_0'], [role='dialog'] [contenteditable='true'][role='textbox']");
      if (!button || !field || button.disabled) return null;
      const composer = helpers.closestDeep(field, "[role='dialog'], dialog") || field;
      return { isOpen: () => composer.isConnected && helpers.isVisible(composer) };
    },
    async openComposer({ handoff, files, helpers }) {
      if (!(location.hostname === "x.com" || location.hostname.endsWith("twitter.com"))) throw new Error("Open X in this tab, then use the Crossposter sidebar.");
      const selector = "[data-testid='tweetTextarea_0'], [role='dialog'] [contenteditable='true'][role='textbox']";
      let field = helpers.findVisible(selector);
      if (!field) {
        const launch = helpers.findVisible("[data-testid='SideNav_NewTweet_Button'], a[href='/compose/post']");
        if (!launch) return helpers.manualResult("Open X’s post composer, then use the Crossposter sidebar.");
        launch.click();
        try { field = await helpers.waitForElement(() => helpers.findVisible(selector), 20000); }
        catch { return helpers.manualResult("Open X’s post composer, then use the Crossposter sidebar."); }
      }
      // X's composer is Draft.js. execCommand("insertText") mutates the DOM
      // and leaves Draft to reconcile the leaf under the caret with its model;
      // once its link decorator splits the text into several leaves that
      // reconcile truncates or repeats fragments ("t3.gg on X)t3.gg on X)").
      // A plain-text paste goes through Draft's own model instead.
      const textInserted = await helpers.pasteComposerText(field, handoff.text || "");
      if (!files.length) return { ok: true, composerOpened: true, textInserted, mediaInserted: 0, error: "" };
      const root = field.closest("[role='dialog'], dialog") || document;
      let mediaInserted = 0;
      try {
        const input = await helpers.waitForElement(() => helpers.findCompatibleFileInput(files, root, root === document), 20000);
        mediaInserted = helpers.attachFilesToInput(files, input);
      } catch {}
      return {
        ok: true, composerOpened: true, textInserted, mediaInserted,
        error: mediaInserted ? "" : "X is still loading its media control. Crossposter will retry once."
      };
    }
  });
})();
