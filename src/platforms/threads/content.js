(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;

  const isThreadsHost = host => host === "threads.com" || host.endsWith(".threads.com");
  const postLink = post => post.querySelector("a[href*='/post/']");
  const profileLink = post => [...post.querySelectorAll("a[href^='/@']")]
    .find(link => !link.getAttribute("href")?.includes("/post/")) || null;
  const youtubeVideoUrl = (href = "") => {
    try {
      const url = new URL(href, location.origin);
      const host = url.hostname.toLowerCase().replace(/^(?:www\.|m\.)/, "");
      if (host === "youtu.be") {
        const id = url.pathname.split("/").filter(Boolean)[0] || "";
        return /^[a-z0-9_-]{6,}$/i.test(id) ? `https://youtu.be/${id}` : "";
      }
      if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return "";
      const watchId = url.pathname === "/watch" ? url.searchParams.get("v") || "" : "";
      if (/^[a-z0-9_-]{6,}$/i.test(watchId)) return `https://www.youtube.com/watch?v=${watchId}`;
      const videoPath = url.pathname.match(/^\/(shorts|live|embed)\/([^/?#]+)/i);
      return videoPath && /^[a-z0-9_-]{6,}$/i.test(videoPath[2])
        ? `https://www.youtube.com/${videoPath[1].toLowerCase()}/${videoPath[2]}`
        : "";
    } catch { return ""; }
  };
  const externalUrl = (href = "") => {
    const youtube = youtubeVideoUrl(href);
    if (youtube) return youtube;
    try {
      const url = new URL(href, location.origin);
      return /^https?:$/.test(url.protocol) && !isThreadsHost(url.hostname) ? url.href : "";
    } catch { return ""; }
  };

  core.register({
    id: "threads",
    matches: isThreadsHost,
    // Threads does not currently expose feed items as articles. This stable
    // pressable container wraps the author, permalink, body, media, and actions.
    postSelectors: ["[data-pressable-container='true']"],
    inlineActionMount: ({ post }) => {
      if (!postLink(post)) return null;
      const share = [...post.querySelectorAll("[role='button']")].find(button => button.querySelector("svg[aria-label='Share']"));
      const row = share?.parentElement?.parentElement;
      return row && row.querySelectorAll(":scope > *").length >= 4 ? row : null;
    },
    captureText: ({ post }) => {
      const permalink = postLink(post);
      let shell = permalink;
      while (shell?.parentElement && shell.parentElement !== post) shell = shell.parentElement;
      let header = permalink;
      while (header?.parentElement && header.parentElement !== shell) header = header.parentElement;
      const body = header?.nextElementSibling || post;
      const candidates = [...body.querySelectorAll("[dir='auto']")].filter(element => {
        if (!String(element.innerText || element.textContent || "").trim()) return false;
        if (element.closest("button, [role='button']")) return false;
        const preview = element.closest("a[href]");
        if (preview && externalUrl(preview.href || preview.getAttribute("href"))) return false;
        return true;
      });
      const copy = candidates
        .filter(element => !candidates.some(other => other !== element && other.contains(element)))
        .map(element => {
          // Translation controls and carousel counters are direct DIV children
          // inside the otherwise textual span; they are page chrome, not copy.
          return [...element.childNodes]
            .filter(node => node.nodeType === 3 || node.nodeName !== "DIV")
            .map(node => node.nodeName === "A"
              ? externalUrl(node.href || node.getAttribute?.("href")) || node.textContent || ""
              : node.textContent || "")
            .join("")
            .replace(/\u00a0+/g, " ")
            .trim();
        })
        .filter(Boolean)
        .join("\n");
      const externalLinks = [...new Set([...body.querySelectorAll("a[href]")]
        .map(link => externalUrl(link.href || link.getAttribute("href")))
        .filter(Boolean))];
      const missingLinks = externalLinks.filter(url => !copy.includes(url));
      return [copy, missingLinks.join("\n")].filter(Boolean).join("\n\n");
    },
    captureMedia: ({ post, helpers }) => {
      const nodes = post.querySelectorAll("video, a[href*='/post/'][href$='/media'] img, img[alt^='Photo by']");
      return helpers.mediaFromNodes(nodes);
    },
    sourceUrl: ({ post }) => {
      const href = postLink(post)?.getAttribute("href") || "";
      try { return href ? new URL(href, location.origin).href : ""; }
      catch { return ""; }
    },
    videoInfo: ({ video }) => ({ source: "threads", src: video?.currentSrc || video?.src || "" }),
    sourceAuthor: ({ post }) => (profileLink(post)?.innerText || profileLink(post)?.textContent || "").replace(/^@/, "").trim(),
    isOwnPost: ({ post, helpers }) => {
      const authoredBy = helpers.identityFromHref(profileLink(post)?.getAttribute("href"));
      const signedInProfile = [...document.querySelectorAll("a[href^='/@']")].find(link => {
        const label = `${link.getAttribute("aria-label") || ""} ${link.innerText || ""}`.replace(/\s+/g, " ").trim();
        return /^profile(?:\s+profile)?$/i.test(label) || Boolean(link.querySelector("img[alt='Profile'], svg[aria-label='Profile']"));
      });
      const signedInAs = helpers.identityFromHref(signedInProfile?.getAttribute("href"));
      return Boolean(authoredBy && signedInAs && authoredBy === signedInAs);
    },
    nativePostSubmission: ({ target, helpers }) => {
      const button = helpers.closestDeep(target, "button, [role='button']");
      const composer = helpers.closestDeep(button, "[role='dialog'], dialog");
      const field = composer && helpers.findVisible("[contenteditable='true'][role='textbox'][aria-label*='compose' i], [contenteditable='true'][role='textbox'][aria-label*='text field' i]", composer);
      if (!button || !composer || !field || helpers.normalizeText(button) !== "post" || button.getAttribute("aria-disabled") === "true") return null;
      return { isOpen: () => composer.isConnected && helpers.isVisible(composer) };
    },
    async openComposer({ handoff, files, helpers }) {
      if (!isThreadsHost(location.hostname)) throw new Error("Open Threads in this tab, then use the Crossposter sidebar.");
      const selector = "[role='dialog'] [contenteditable='true'][role='textbox'][aria-label*='compose' i], [role='dialog'] [contenteditable='true'][role='textbox'][aria-label*='text field' i]";
      let field = helpers.findVisible(selector);
      if (!field) {
        const launch = helpers.findClickable("New thread", document, element => !element.closest("[role='dialog'], dialog"))
          || helpers.findVisible("[role='button'][aria-label^='Empty text field']");
        if (!launch) return helpers.manualResult("Open Threads’ New thread composer, then use the Crossposter sidebar.");
        launch.click();
        try { field = await helpers.waitForElement(() => helpers.findVisible(selector), 20000); }
        catch { return helpers.manualResult("Open Threads’ New thread composer, then use the Crossposter sidebar."); }
      }
      const textInserted = await helpers.pasteComposerText(field, String(handoff.text || "").slice(0, 500));
      let mediaInserted = 0;
      if (files.length) {
        const root = helpers.closestDeep(field, "[role='dialog'], dialog") || document;
        try { await helpers.waitForElement(() => helpers.findCompatibleFileInput(files, root, false), 15000); } catch {}
        mediaInserted = helpers.attachNativeFiles(files, root);
      }
      return {
        ok: true, composerOpened: true, textInserted, mediaInserted,
        error: textInserted ? "" : "Use the Crossposter sidebar to finish the handoff."
      };
    }
  });
})();
