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
