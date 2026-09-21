(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;

  const BSKY_API = "https://public.api.bsky.app/xrpc";
  const metadataByPost = new WeakMap();
  const metadataRequests = new Map();

  core.register({
    id: "bluesky",
    matches: host => host === "bsky.app" || host.endsWith(".bsky.app"),
    // Feed posts are pressable DIVs in the current Bluesky web app, not
    // articles. Without this boundary a context-menu capture falls back to the
    // document body and copies the feed header instead of the clicked post.
    postSelectors: ["[data-testid^='feedItem-by-'][role='link']", "[data-testid='postThreadItem']", "article"],
    prepareCapture: async ({ post }) => {
      if (!post || metadataByPost.has(post)) return;
      const url = blueskyPostUrl(post);
      const identity = blueskyPostIdentity(url);
      if (!identity) { metadataByPost.set(post, null); return; }
      let request = metadataRequests.get(url);
      if (!request) {
        request = fetchBlueskyPost(identity.actor, identity.rkey);
        metadataRequests.set(url, request);
      }
      try { metadataByPost.set(post, await request); }
      catch { metadataByPost.set(post, null); }
    },
    // Keep capture focused on the authored copy. Besides excluding post chrome,
    // this prevents the generic fallback from cloning a live video player.
    captureText: ({ post }) => {
      const metadata = metadataByPost.get(post);
      if (typeof metadata?.record?.text === "string") return metadata.record.text.trim();
      const text = post.querySelector("[data-testid='postText']");
      return (text?.innerText || text?.textContent || "").trim();
    },
    captureMedia: ({ post, helpers }) => {
      const resolved = blueskyEmbedMedia(metadataByPost.get(post)?.embed);
      if (resolved.length) return resolved;
      const nodes = [...post.querySelectorAll("video, img")].filter(node => {
        if (node.closest?.("a[aria-label^='Post by']")) return false;
        if (node.tagName === "VIDEO") return true;
        const source = node.currentSrc || node.src || "";
        return /cdn\.bsky\.app\/img\/feed_(?:thumbnail|fullsize)\//i.test(source)
          && !node.closest?.("a[href^='http']");
      });
      return helpers.mediaFromNodes(nodes);
    },
    sourceUrl: ({ post }) => blueskyPostUrl(post),
    sourceAuthor: ({ post, helpers }) => {
      const author = metadataByPost.get(post)?.author;
      return author?.displayName || author?.handle
        || helpers.firstText(post, ["[data-testid='displayName']", "a[href*='/profile/'] span"])
        || helpers.identityFromHref(post.querySelector("a[href*='/profile/']")?.getAttribute("href"), /\/profile\/([^/?#]+)/i);
    },
    isOwnPost: ({ post, helpers }) => {
      const profilePattern = /\/profile\/([^/?#]+)/i;
      const authoredBy = helpers.identityFromHref(post.querySelector("a[href*='/profile/']")?.getAttribute("href"), profilePattern);
      const signedInAs = helpers.identityFromHref(document.querySelector("nav a[href*='/profile/'], a[aria-label*='profile' i][href*='/profile/']")?.getAttribute("href"), profilePattern);
      return Boolean(authoredBy && signedInAs && authoredBy === signedInAs);
    },
    videoInfo: ({ post }) => {
      const identity = blueskyPostIdentity(blueskyPostUrl(post));
      return { source: "bluesky", actor: identity?.actor || null, rkey: identity?.rkey || null };
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
      // Stage bookkeeping mirrors LinkedIn: the sidebar shows the stage while
      // the handoff runs, and a failure names the stage that did not complete
      // instead of a generic "open the composer" message.
      const started = Date.now(), stages = [];
      let stage = "locate", composerOpened = false, textInserted = false, mediaInserted = 0;
      const report = name => {
        stage = name;
        stages.push({ stage, elapsedMs: Date.now() - started });
        helpers.reportComposerStage?.(handoff.handoffId, "bluesky", stage);
      };
      const result = (error, extra = {}) => ({ ok: true, composerOpened, textInserted, mediaInserted, stage, stages, error, ...extra });
      const selector = "textarea[placeholder*='What'], [data-testid='composePostTextArea'], [role='dialog'] textarea, [role='dialog'] [contenteditable='true']";
      report("locate");
      let field = helpers.findVisible(selector);
      if (!field) {
        const launch = helpers.findVisible("[data-testid='composeFAB'], button[aria-label*='compose' i][aria-label*='post' i], a[href*='/intent/compose']")
          || helpers.findClickable("New post", document, element => !element.closest("[role='dialog']"), false);
        if (!launch) {
          // A signed-out bsky.app still renders the public feed but no
          // compose control, so "open the composer" would send the user
          // looking for a button that does not exist. Say why instead; the
          // reason keeps the sidebar from adding its "layout changed" hint.
          if (blueskySignedOut()) return result(MESSAGES["signed-out"], { reason: "signed-out" });
          return result(MESSAGES.locate);
        }
        report("open");
        launch.click();
        try { field = await helpers.waitForElement(() => helpers.findVisible(selector)); }
        catch { return result(MESSAGES.open); }
      }
      composerOpened = true;
      report("fill-text");
      // The composer text is inserted once per composer: the background
      // re-sends the handoff when the media input was not ready in time, and
      // that redelivery must not append the text a second time.
      const root = helpers.closestDeep(field, "[role='dialog'], dialog") || document;
      textInserted = await helpers.fillComposerTextOnce(field, root, handoff.text || "", { method: "set" });
      const failures = [];
      if (handoff.text && !textInserted) failures.push({ stage: "fill-text", message: MESSAGES["fill-text"] });
      if (files.length) {
        report("attach");
        let input = helpers.findCompatibleFileInput(files, root);
        if (!input) {
          // Bluesky does not mount its file input until this control is
          // activated. A synthetic click creates the hidden input without
          // choosing a file; Crossposter then supplies the prepared File.
          helpers.findVisible("[data-testid='openMediaBtn']", root)?.click();
        }
        try {
          input ||= await helpers.waitForElement(() => helpers.findCompatibleFileInput(files, root), 15000);
        } catch {}
        mediaInserted = input
          ? helpers.attachFilesToInput(files, input)
          : helpers.attachNativeFiles(files, root);
        if (!mediaInserted) failures.push({ stage: "attach", message: MESSAGES.attach });
      }
      if (failures.length) {
        // Both steps ran so the sidebar can say everything that went wrong,
        // but the reported stage is the first one that failed.
        stage = failures[0].stage;
        return result(failures.map(failure => failure.message).join(" "));
      }
      report("ready");
      return result("");
    }
  });

  // What the sidebar shows when a stage does not complete. Each message names
  // the step so the user knows how far the handoff got.
  const MESSAGES = Object.freeze({
    "signed-out": "You are not signed in to Bluesky in this browser. Sign in to Bluesky, then use the Crossposter sidebar.",
    locate: "Bluesky’s post composer and its New post control were not found. Open Bluesky’s post composer, then use the Crossposter sidebar.",
    open: "Bluesky’s post composer did not open after its New post control was activated. Open the composer yourself, then use the Crossposter sidebar.",
    "fill-text": "Bluesky’s composer opened but did not accept the post text. Copy the text from the sidebar.",
    attach: "Bluesky’s composer opened but did not expose its media upload control. Drag the media from the sidebar."
  });

  // Signed-in Bluesky always renders its navigation with fixed, language-
  // neutral hrefs plus the compose control; the signed-out landing page shows
  // only the public feed with localized Sign in / Create account buttons that
  // carry no stable attribute. Require some rendered app content so a page
  // that has not painted yet is not mistaken for a signed-out one.
  function blueskySignedOut() {
    const signedIn = document.querySelector(
      "[data-testid='composeFAB'], a[href='/notifications'], a[href='/messages'], a[href^='/settings'], nav a[href*='/profile/']"
    );
    return !signedIn && Boolean(document.querySelector("[data-testid]"));
  }

  function blueskyPostUrl(post) {
    const href = post?.querySelector?.("a[href*='/post/']")?.getAttribute?.("href") || "";
    try { return href ? new URL(href, location.origin).href : location.href; }
    catch { return location.href || ""; }
  }

  function blueskyPostIdentity(url = "") {
    let path;
    try { path = new URL(url, location.origin).pathname; }
    catch { return null; }
    const match = path.match(/^\/profile\/([^/]+)\/post\/([^/?#]+)/i);
    if (!match) return null;
    try { return { actor: decodeURIComponent(match[1]), rkey: decodeURIComponent(match[2]) }; }
    catch { return { actor: match[1], rkey: match[2] }; }
  }

  async function fetchBlueskyPost(actor, rkey) {
    let did = actor;
    if (!did.startsWith("did:")) {
      const response = await fetch(`${BSKY_API}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`);
      if (!response.ok) return null;
      did = (await response.json())?.did || "";
    }
    if (!did) return null;
    const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
    const response = await fetch(`${BSKY_API}/app.bsky.feed.getPostThread?depth=0&uri=${encodeURIComponent(uri)}`);
    if (!response.ok) return null;
    return (await response.json())?.thread?.post || null;
  }

  function blueskyEmbedMedia(embed) {
    const type = embed?.["$type"] || "";
    if (type.startsWith("app.bsky.embed.recordWithMedia")) return blueskyEmbedMedia(embed.media);
    if (type.startsWith("app.bsky.embed.images")) {
      return (embed.images || []).map(image => ({ kind: "image", url: image.fullsize || image.thumb || "" }))
        .filter(item => /^https?:/i.test(item.url)).slice(0, 4);
    }
    if (type.startsWith("app.bsky.embed.video") && /^https?:/i.test(embed.playlist || "")) {
      return [{ kind: "video", url: embed.playlist, poster: embed.thumbnail || "", streamType: "hls" }];
    }
    if (type.startsWith("app.bsky.embed.external")) {
      const url = embed.external?.uri || "";
      return /\.mp4(?:[?#]|$)/i.test(url) ? [{ kind: "video", url }] : [];
    }
    return [];
  }
})();
