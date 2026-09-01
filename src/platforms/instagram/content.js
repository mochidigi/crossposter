(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;

  // Instagram's feed video elements use document-scoped MediaSource blob URLs,
  // and a generic article clone includes usernames, counters, and action chrome.
  // Resolve the post's permalink once at capture time so the draft receives the
  // canonical caption and CDN media URLs embedded in the post page.
  const metadataByPost = new WeakMap();
  const metadataRequests = new Map();

  core.register({
    id: "instagram",
    matches: host => host === "instagram.com" || host.endsWith(".instagram.com"),
    postSelectors: ["article"],
    inlineActionMount: ({ post }) => {
      const shareIcon = post.querySelector("svg[aria-label='Share']");
      const share = shareIcon?.closest("button, [role='button']");
      const container = share?.parentElement;
      const likeIcon = post.querySelector("svg[aria-label='Like'], svg[aria-label='Unlike']");
      const commentIcon = post.querySelector("svg[aria-label='Comment']");
      if (!share || !container || !likeIcon || !commentIcon) return null;
      if (!container.contains(likeIcon) || !container.contains(commentIcon)) return null;
      return { container, template: share, iconOnly: true };
    },
    prepareCapture: async ({ post }) => {
      if (!post || metadataByPost.has(post)) return;
      const url = instagramSourceUrl(post);
      const code = instagramShortcode(url);
      if (!url || !code) { metadataByPost.set(post, null); return; }
      let request = metadataRequests.get(url);
      if (!request) {
        const embedded = instagramMetadataFromDocument(document, code);
        request = instagramMetadataComplete(embedded, Boolean(post.querySelector("video")))
          ? embedded
          : fetchInstagramMetadata(url, code);
        metadataRequests.set(url, Promise.resolve(request));
      }
      try { metadataByPost.set(post, await request); }
      catch { metadataByPost.set(post, null); }
    },
    captureText: ({ post }) => {
      const metadata = metadataByPost.get(post);
      if (metadata && typeof metadata.caption?.text === "string") return metadata.caption.text.trim();
      const candidates = [...post.querySelectorAll("span[dir='auto']")]
        .filter(element => !element.closest?.("a, button, [role='button']"))
        .map(element => (element.innerText || element.textContent || "").replace(/\u00a0/g, " ").trim())
        .filter(text => text && !/^more$/i.test(text));
      return candidates.sort((left, right) => right.length - left.length)[0]
        ?.replace(/(?:\.\.\.|…)?\s*more\s*$/iu, "").trim() || "";
    },
    captureMedia: ({ post, helpers }) => {
      const resolved = instagramMetadataMedia(metadataByPost.get(post));
      if (resolved.length) return resolved;
      const video = post.querySelector("video");
      if (video) {
        const media = helpers.mediaFromNodes([video]);
        const poster = instagramPostImages(post)[0];
        if (media[0] && poster) media[0].poster = poster.currentSrc || poster.src || "";
        return media;
      }
      return helpers.mediaFromNodes(instagramPostImages(post));
    },
    sourceUrl: ({ post }) => instagramSourceUrl(post),
    sourceAuthor: ({ post }) => {
      const metadata = metadataByPost.get(post);
      if (metadata?.user?.username) return metadata.user.username;
      const link = [...post.querySelectorAll("a[href]")].find(element => {
        const href = element.getAttribute("href") || "";
        return /^\/[A-Za-z0-9._]+\/(?:[?#].*)?$/.test(href) && Boolean((element.innerText || element.textContent || "").trim());
      });
      return (link?.innerText || link?.textContent || "").trim();
    },
    videoInfo: ({ post, video }) => {
      const item = instagramMetadataMedia(metadataByPost.get(post)).find(media => media.kind === "video");
      const currentSrc = item?.url || video?.currentSrc || video?.src || "";
      return {
        source: "instagram",
        shortcode: instagramShortcode(instagramSourceUrl(post)),
        // MediaSource blob URLs only exist inside this Instagram document.
        src: /^https?:/i.test(currentSrc) ? currentSrc : ""
      };
    },
    nativePostSubmission: ({ target, helpers }) => {
      const button = helpers.closestDeep(target, "button, [role='button']");
      const composer = helpers.closestDeep(button, "[role='dialog'], dialog");
      const submit = helpers.normalizeText(button) === "share";
      const field = composer && helpers.findVisible("[contenteditable='true'][aria-label], textarea", composer);
      if (!button || !composer || !submit || !field) return null;
      // Sharing keeps the dialog open on a confirmation screen; the caption
      // field disappearing is what marks the post as submitted.
      return { isOpen: () => composer.isConnected && helpers.isVisible(composer) && Boolean(helpers.findVisible("[contenteditable='true'][aria-label], textarea", composer)) };
    },
    async openComposer({ handoff, files, helpers }) {
      if (!(location.hostname === "instagram.com" || location.hostname.endsWith(".instagram.com"))) throw new Error("Open Instagram in this tab, then use the Crossposter sidebar.");
      if (!files.length) return helpers.manualResult("Instagram requires a photo or video. Add media to this crosspost first.");
      const fileInput = () => helpers.findVisible("[role='dialog']") && helpers.queryAllDeep("[role='dialog'] input[type='file']").find(input => !input.disabled) || null;
      let input = fileInput();
      if (!input) {
        const launch = document.querySelector("svg[aria-label='New post'], svg[aria-label='Create']")?.closest("a, [role='link'], [role='button'], button")
          || helpers.findClickable("create", document, element => !element.closest("[role='dialog']"), false);
        if (!launch) return helpers.manualResult("Open Instagram’s Create dialog, then use the Crossposter sidebar.");
        launch.click();
        try { input = await helpers.waitForElement(fileInput); }
        catch { return helpers.manualResult("Open Instagram’s Create dialog, then use the Crossposter sidebar."); }
      }
      const mediaInserted = helpers.attachFilesToInput(files, input);
      if (!mediaInserted) return { ok: true, composerOpened: true, textInserted: false, mediaInserted: 0, error: "Instagram did not accept the media. Use the Crossposter sidebar to finish the handoff." };
      // Advance through the crop/edit steps to the caption screen. Only "Next"
      // (and the occasional video/reels notice "OK") is clicked — never "Share";
      // posting stays manual.
      const dialog = () => helpers.findVisible("[role='dialog']");
      const captionField = () => {
        const root = dialog();
        return root ? helpers.findVisible("[contenteditable='true'][aria-label], textarea[aria-label]", root) : null;
      };
      const caption = String(handoff.text || "").slice(0, 2200);
      const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
      // Instagram keeps one persistent "Next" button across the crop and edit
      // steps, so a state change can only be observed by pacing: click, give the
      // step transition time to render, then look again.
      for (let step = 0; step < 6 && !captionField(); step++) {
        let advance = null;
        try {
          advance = await helpers.waitForElement(() => {
            const root = dialog();
            if (!root) return null;
            return captionField() ? root : (helpers.findClickable("next", root) || helpers.findClickable("ok", root));
          }, 15000);
        } catch { break; }
        if (!advance || captionField()) break;
        advance.click();
        await delay(1500);
      }
      let field = captionField();
      if (!field) { try { field = await helpers.waitForElement(captionField, 8000); } catch {} }
      if (!field) return { ok: true, composerOpened: true, textInserted: false, mediaInserted, error: "Media attached. Continue to the caption step in Instagram, then use the Crossposter sidebar." };
      const textInserted = caption ? await helpers.pasteComposerText(field, caption) : true;
      return { ok: true, composerOpened: true, textInserted, mediaInserted, error: textInserted ? "" : "Use the Crossposter sidebar to finish the handoff." };
    }
  });

  function instagramSourceUrl(post) {
    const href = post?.querySelector?.("a[href^='/p/'], a[href^='/reels/']")?.getAttribute?.("href") || "";
    try { return href ? new URL(href, location.origin).href : location.href; }
    catch { return location.href || ""; }
  }

  function instagramShortcode(url = "") {
    try { return new URL(url, location.origin).pathname.match(/^\/(?:p|reels)\/([^/]+)/i)?.[1] || ""; }
    catch { return ""; }
  }

  async function fetchInstagramMetadata(url, code) {
    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) return null;
      const page = new DOMParser().parseFromString(await response.text(), "text/html");
      return instagramMetadataFromDocument(page, code);
    } catch { return null; }
  }

  function instagramMetadataFromDocument(root, code) {
    if (!root?.querySelectorAll || !code) return null;
    let best = null, bestScore = -1;
    const visit = value => {
      if (!value || typeof value !== "object") return;
      if (value.code === code) {
        const score = (Array.isArray(value.video_versions) ? value.video_versions.length * 10 : 0)
          + (Array.isArray(value.carousel_media) ? value.carousel_media.length * 10 : 0)
          + (Array.isArray(value.image_versions2?.candidates) ? value.image_versions2.candidates.length : 0)
          + (typeof value.caption?.text === "string" ? 5 : 0)
          + (value.user?.username ? 2 : 0);
        if (score > bestScore) { best = value; bestScore = score; }
      }
      for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
    };
    for (const script of root.querySelectorAll("script[type='application/json']")) {
      try { visit(JSON.parse(script.textContent || "")); } catch {}
    }
    return best;
  }

  function instagramMetadataMedia(metadata) {
    if (!metadata) return [];
    const entries = Array.isArray(metadata.carousel_media) && metadata.carousel_media.length
      ? metadata.carousel_media
      : [metadata];
    return entries.map(entry => {
      const videos = Array.isArray(entry.video_versions) ? entry.video_versions.filter(candidate => /^https?:/i.test(candidate?.url || "")) : [];
      const images = Array.isArray(entry.image_versions2?.candidates) ? entry.image_versions2.candidates.filter(candidate => /^https?:/i.test(candidate?.url || "")) : [];
      const bestVideo = largestCandidate(videos);
      const bestImage = largestCandidate(images);
      if (bestVideo) return { kind: "video", url: bestVideo.url, poster: bestImage?.url || "" };
      return bestImage ? { kind: "image", url: bestImage.url } : null;
    }).filter(Boolean).slice(0, 4);
  }

  function instagramMetadataComplete(metadata, expectsVideo) {
    if (!metadata || !("caption" in metadata)) return false;
    const media = instagramMetadataMedia(metadata);
    return expectsVideo ? media.some(item => item.kind === "video") : media.length > 0;
  }

  function largestCandidate(candidates) {
    return candidates.reduce((best, candidate) => {
      const area = Number(candidate.width || 0) * Number(candidate.height || 0);
      const bestArea = Number(best?.width || 0) * Number(best?.height || 0);
      return !best || area > bestArea ? candidate : best;
    }, null);
  }

  function instagramPostImages(post) {
    return [...post.querySelectorAll("img")].filter(image => {
      const source = image.currentSrc || image.src || "";
      const label = `${image.alt || ""} ${image.getAttribute?.("aria-label") || ""}`;
      const width = Number(image.naturalWidth || image.width || 0);
      const height = Number(image.naturalHeight || image.height || 0);
      return /^https?:/i.test(source) && width >= 180 && height >= 100 && !/(?:profile picture|avatar|emoji|icon)/i.test(label);
    });
  }
})();
