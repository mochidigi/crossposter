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
  // Threads localizes every aria-label and SVG <title> ("Dela", "Gilla", …)
  // with the account language. Icon geometry and layout stay the same, so the
  // structural checks come first and English labels are only a fallback.
  const ICONS = Object.freeze({
    share: { paths: ["M7.2474 1.49853"], labels: ["share"] },
    profile: { paths: ["M12 0.75C8.82431"], labels: ["profile"] },
    create: { paths: ["M13.25 3.00001"], labels: ["create", "new thread"] }
  });
  const hasIcon = element => Boolean(element?.querySelector?.("svg"));
  const directChildren = element => [...(element?.querySelectorAll?.(":scope > *") || [])];
  // The action bar is a row of at least four cells, each wrapping one icon
  // button (like, comment, repost, share).
  const actionRowFor = button => {
    const row = button?.parentElement?.parentElement;
    const cells = directChildren(row);
    return row && cells.length >= 4 && cells.every(cell => hasIcon(cell.querySelector?.("[role='button']") || cell)) ? row : null;
  };
  function threadsActionRow(post, helpers) {
    const buttons = [...post.querySelectorAll("[role='button']")].filter(hasIcon);
    const share = buttons.find(button => helpers?.iconMatches?.(button, ICONS.share));
    return (share && actionRowFor(share)) || buttons.map(actionRowFor).find(Boolean) || null;
  }
  const externalUrl = (href = "") => {
    const youtube = youtubeVideoUrl(href);
    if (youtube) return youtube;
    try {
      const url = new URL(href, location.origin);
      return /^https?:$/.test(url.protocol) && !isThreadsHost(url.hostname) ? url.href : "";
    } catch { return ""; }
  };

  // The composer's editable is a contenteditable textbox whose aria-label
  // ("Compose new thread…") is localized. Threads no longer wraps the composer
  // in a role=dialog: it renders in a popover (a role=menu ancestor), so the
  // composer root is the nearest ancestor that holds the heading, the media
  // file input, and the footer buttons.
  const COMPOSER_FIELD = "[contenteditable='true'][role='textbox']";
  const insertedTextByComposer = new WeakMap();
  function composerRoot(element, helpers) {
    const dialog = helpers.closestDeep(element, "[role='dialog'], dialog");
    if (dialog) return dialog;
    let current = element?.parentElement || null;
    while (current && current !== document.body) {
      if (current.querySelector?.("[data-pressable-container]")) return null;
      if (current.querySelector?.("input[type='file']") && current.querySelector?.("h1, h2, h3, [role='heading']")
        && helpers.queryAllDeep("button, [role='button']", current).some(button => !hasIcon(button) && helpers.normalizeText(button))) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }
  // The submit control is the dialog's text-only button (the reply-audience
  // dropdown and toolbar buttons all carry icons).
  function submitButton(composer, helpers) {
    const candidates = helpers.queryAllDeep("button, [role='button']", composer).filter(element =>
      helpers.isVisible(element) && !hasIcon(element) && helpers.normalizeText(element)
      && !element.getAttribute?.("aria-haspopup") && !element.closest?.(COMPOSER_FIELD));
    return candidates.find(element => helpers.normalizeText(element) === "post") || candidates.at(-1) || null;
  }

  core.register({
    id: "threads",
    matches: isThreadsHost,
    // Threads does not currently expose feed items as articles. This stable
    // pressable container wraps the author, permalink, body, media, and actions.
    postSelectors: ["[data-pressable-container='true']"],
    inlineActionMount: ({ post, helpers }) => {
      if (!postLink(post)) return null;
      return threadsActionRow(post, helpers);
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
      // The navigation's profile entry is an icon-only link to the viewer's
      // own handle; feed links to /@handle carry text or an avatar instead.
      const navLinks = [...document.querySelectorAll("a[href^='/@']")].filter(link => !link.closest?.("[data-pressable-container]"));
      const signedInProfile = navLinks.find(link => helpers.iconMatches?.(link, ICONS.profile))
        || navLinks.find(link => hasIcon(link) && !String(link.innerText || "").trim())
        || navLinks.find(link => {
          const label = `${link.getAttribute("aria-label") || ""} ${link.innerText || ""}`.replace(/\s+/g, " ").trim();
          return /^profile(?:\s+profile)?$/i.test(label) || Boolean(link.querySelector("img[alt='Profile'], svg[aria-label='Profile']"));
        });
      const signedInAs = helpers.identityFromHref(signedInProfile?.getAttribute("href"));
      return Boolean(authoredBy && signedInAs && authoredBy === signedInAs);
    },
    nativePostSubmission: ({ target, helpers }) => {
      const button = helpers.closestDeep(target, "button, [role='button']");
      const composer = button && composerRoot(button, helpers);
      const field = composer && helpers.findVisible(COMPOSER_FIELD, composer);
      if (!button || !composer || !field || button.getAttribute("aria-disabled") === "true") return null;
      if (button !== submitButton(composer, helpers) && helpers.normalizeText(button) !== "post") return null;
      return { isOpen: () => composer.isConnected && helpers.isVisible(composer) };
    },
    async openComposer({ handoff, files, helpers }) {
      if (!isThreadsHost(location.hostname)) throw new Error("Open Threads in this tab, then use the Crossposter sidebar.");
      const selector = COMPOSER_FIELD;
      const findField = () => helpers.queryAllDeep(selector).find(element => helpers.isVisible(element) && composerRoot(element, helpers)) || null;
      let field = findField();
      if (!field) {
        const outsideDialog = element => !element.closest("[role='dialog'], dialog");
        const launch = helpers.findIconControl?.(document, ICONS.create, "[role='button'], a")
          || helpers.findClickable("New thread", document, outsideDialog)
          || helpers.findVisible("[role='button'][aria-label^='Empty text field']");
        if (!launch) return helpers.manualResult("Open Threads’ New thread composer, then use the Crossposter sidebar.");
        launch.click();
        try { field = await helpers.waitForElement(findField, 20000); }
        catch { return helpers.manualResult("Open Threads’ New thread composer, then use the Crossposter sidebar."); }
      }
      // Threads can accept a synthetic paste before its contenteditable text
      // becomes readable. Do not follow that successful paste with insertText,
      // which would append a duplicate caption.
      const root = composerRoot(field, helpers) || document;
      const caption = String(handoff.text || "").slice(0, 500);
      let textInserted = !caption || insertedTextByComposer.get(root) === caption;
      if (!textInserted) {
        // Firefox can deliver the synthetic paste to Threads while its Xray
        // wrapper still reports an empty editor. pasteComposerText then runs
        // its insertText fallback and duplicates the whole caption. Use one
        // directly observable insertion method in Firefox.
        textInserted = globalThis.browser?.runtime
          ? helpers.insertComposerTextOnce(field, caption)
          : await helpers.pasteComposerText(field, caption, { fallback: false });
        if (textInserted) insertedTextByComposer.set(root, caption);
      }
      let mediaInserted = 0;
      if (files.length) {
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
