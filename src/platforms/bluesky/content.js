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
    // A thread's posts are postThreadItem-by-<handle> (2026-10-14).
    postSelectors: ["[data-testid^='feedItem-by-'][role='link']", "[data-testid^='postThreadItem']", "article"],
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
    // The record's text holds only each link's label, often shortened
    // ("blog.example.com/p/a-lo..."); the URL is in its facet (see
    // blueskyLinkFacets), so the label is swapped for it.
    captureText: ({ post, helpers }) => {
      const record = metadataByPost.get(post)?.record;
      if (typeof record?.text === "string") return blueskyTextWithLinks(record).trim();
      const text = post.querySelector("[data-testid='postText']");
      const anchors = [...(text?.querySelectorAll?.("a[href^='http']") || [])];
      return (anchors.length && helpers ? helpers.textWithLinkUrls(text, anchors) : text?.innerText || text?.textContent || "").trim();
    },
    // Inline links (facets) and the link card (an external embed) beside the
    // text; the draft adds the URL of any the text does not carry. A quoted
    // post is a record embed, and its links stay with it.
    captureLinks: ({ post }) => {
      const metadata = metadataByPost.get(post);
      if (!metadata?.record) return [];
      const links = new Map();
      for (const facet of blueskyLinkFacets(metadata.record)) {
        if (!links.has(facet.url)) links.set(facet.url, { url: facet.url, display: facet.label, title: "", inText: facet.replaced });
      }
      const external = blueskyExternalEmbed(metadata.embed);
      const url = String(external?.uri || "");
      const isMedia = blueskyEmbedMedia(metadata.embed).some(item => item.url === url);
      if (/^https?:\/\//i.test(url) && !isMedia) {
        const link = links.get(url) || { url, display: hostOf(url), title: "", inText: false };
        link.title = String(external.title || "");
        links.set(url, link);
      }
      return [...links.values()];
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
      // The tab reports "complete" before Bluesky's app has restored the
      // session and rendered its navigation (150–500 ms later in a measured
      // load), and a retry reloads the tab first, so a single look right
      // away loses that race. Wait until the composer, its launch control,
      // or a signed-out page appears.
      const findStart = () => {
        const field = helpers.findVisible(selector);
        if (field) return { field };
        const launch = blueskyComposeLauncher(helpers);
        if (launch) return { launch };
        return blueskySignedOut() ? { signedOut: true } : null;
      };
      // Opened on Bluesky's compose intent, the app opens the composer with the
      // text 500 ms in, after its New post control has already appeared.
      const prefilled = await helpers.prefilledComposer?.(selector, handoff, { giveUp: blueskySignedOut });
      const start = prefilled ? { field: prefilled } : await helpers.waitForElement(findStart, LAUNCHER_WAIT_MS).catch(() => null);
      // A signed-out bsky.app still renders the public feed but no compose
      // control, so "open the composer" would send the user looking for a
      // button that does not exist. Say why instead; the reason keeps the
      // sidebar from adding its "layout changed" hint.
      if (start?.signedOut) return result(MESSAGES["signed-out"], { reason: "signed-out" });
      if (!start) return result(MESSAGES.locate);
      let field = start.field;
      if (!field) {
        report("open");
        start.launch.click();
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

  const LAUNCHER_WAIT_MS = 10000;

  // Bluesky's compose control is a floating button (composeFAB) below 800px
  // wide and a left-navigation button at 800px and wider, which has no test
  // id and whose label and text follow the UI language. Both draw the
  // EditBig_Stroke2_Corner2_Rounded icon (a box with a pen through its top
  // right corner), so match its path geometry; the English label is only
  // the last fallback. The prefix runs to the gap the pen leaves in the
  // box's top edge, which keeps plain rounded boxes from matching.
  const COMPOSE_ICON = Object.freeze({
    paths: ["M3 16.8V7.2c0-.544-.001-1.011.03-1.395.033-.395.104-.789.297-1.167a3 3 0 0 1 1.31-1.31c.379-.193.772-.265 1.168-.297C6.188 2.999 6.657 3 7.2 3H11"]
  });

  function blueskyComposeLauncher(helpers) {
    const outsideDialog = element => !element.closest("[role='dialog'], dialog");
    return helpers.findVisible("[data-testid='composeFAB'], a[href*='/intent/compose']")
      || helpers.queryAllDeep("button, [role='button']")
        .find(element => outsideDialog(element) && helpers.isVisible(element) && helpers.iconMatches(element, COMPOSE_ICON))
      || helpers.findVisible("button[aria-label*='compose' i][aria-label*='post' i]")
      || helpers.findClickable("New post", document, outsideDialog, false);
  }

  // Signed-in Bluesky always renders its navigation with fixed, language-
  // neutral hrefs plus the compose control; the signed-out landing page shows
  // only the public feed with localized Sign in / Create account buttons that
  // carry no stable attribute. Require rendered feed posts so a page that is
  // still drawing is not mistaken for a signed-out one: below 800px wide a
  // signed-in home screen has no navigation links and shows its test ids
  // about 200 ms before composeFAB, which arrives with the feed list, ahead
  // of the posts that list loads (checked 2026-10-11).
  function blueskySignedOut() {
    const signedIn = document.querySelector(
      "[data-testid='composeFAB'], a[href='/notifications'], a[href='/messages'], a[href^='/settings'], nav a[href*='/profile/']"
    );
    return !signedIn && Boolean(document.querySelector("[data-testid^='feedItem-by-']"));
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

  // Each link facet's URL and label. Facet ranges count UTF-8 bytes, so they
  // are mapped to string indexes. A label that is the URL itself, whole or
  // shortened, is `replaced` by the URL in the text; any other label (some
  // clients link words) stays, and the draft appends the URL.
  function blueskyLinkFacets(record) {
    const text = String(record?.text || "");
    return (Array.isArray(record?.facets) ? record.facets : []).map(facet => {
      const url = String((facet?.features || []).find(feature => /#link$/.test(feature?.["$type"] || ""))?.uri || "");
      const start = utf8Index(text, facet?.index?.byteStart), end = utf8Index(text, facet?.index?.byteEnd);
      const label = start < end ? text.slice(start, end) : "";
      return { url, start, end, label, replaced: labelIsUrl(label, url) };
    }).filter(facet => /^https?:\/\//i.test(facet.url) && facet.label).sort((left, right) => left.start - right.start);
  }

  function blueskyTextWithLinks(record) {
    const text = String(record?.text || "");
    let result = "", cursor = 0;
    for (const facet of blueskyLinkFacets(record)) {
      if (!facet.replaced || facet.start < cursor) continue;
      result += text.slice(cursor, facet.start) + facet.url;
      cursor = facet.end;
    }
    return result + text.slice(cursor);
  }

  function utf8Index(text, byteOffset) {
    if (!Number.isInteger(byteOffset) || byteOffset <= 0) return 0;
    let bytes = 0, index = 0;
    for (const char of text) {
      if (bytes >= byteOffset) break;
      const code = char.codePointAt(0);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      index += char.length;
    }
    return index;
  }

  function labelIsUrl(label, url) {
    const bare = value => String(value).trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    const shown = bare(label).replace(/(?:\.\.\.|…)$/, "");
    return Boolean(shown) && bare(url).startsWith(shown);
  }

  function blueskyExternalEmbed(embed) {
    const type = embed?.["$type"] || "";
    if (type.startsWith("app.bsky.embed.external")) return embed.external || null;
    if (type.startsWith("app.bsky.embed.recordWithMedia")) return blueskyExternalEmbed(embed.media);
    return null;
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./i, ""); }
    catch { return ""; }
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
