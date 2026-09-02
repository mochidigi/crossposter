(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;
  core.register({
    id: "upscrolled",
    matches: host => host.endsWith("upscrolled.com"),
    postSelectors: ["article", "[role='article']"],
    prepareCapture: ({ post, helpers }) => expandUpscrolledText(post, helpers),
    captureText: ({ post }) => upscrolledCaptureText(post),
    captureMedia: ({ post, helpers }) => {
      const video = upscrolledVideoDetails(post, helpers);
      return video.url
        ? [{ kind: "video", url: video.url, poster: video.poster }]
        : helpers.mediaFromNodes(post.querySelectorAll("img[alt='Post image']"));
    },
    sourceAuthor: ({ post, helpers }) => {
      const profiles = [...post.querySelectorAll("a[href^='/@']")];
      return profiles.map(link => (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim())
        .find(value => value && !value.startsWith("@")) || helpers.authorHandle(profiles[0]?.getAttribute("href"));
    },
    isOwnPost: ({ post, helpers }) => {
      const profilePattern = /^\/@([^/?#]+)/i;
      const authoredBy = helpers.identityFromHref(post.querySelector("a[href^='/@']")?.getAttribute("href"), profilePattern);
      const signedInAs = helpers.identityFromHref(document.querySelector("nav[aria-label='Primary'] a[aria-label='Profile'][href^='/@']")?.getAttribute("href"), profilePattern);
      return Boolean(authoredBy && signedInAs && authoredBy === signedInAs);
    },
    videoInfo: ({ post, video, helpers }) => {
      const details = upscrolledVideoDetails(post, helpers, video);
      return { source: "upscrolled", thumbnail: details.poster, src: details.url };
    },
    nativePostSubmission: ({ target, helpers }) => {
      const button = helpers.closestDeep(target, "button, [role='button']");
      const composer = helpers.closestDeep(button, "[role='dialog'], dialog");
      if (!button || !composer || button.disabled || helpers.normalizeText(button) !== "post") return null;
      const field = helpers.findVisible("textarea, input[type='text'], [contenteditable='true'], [role='textbox']", composer);
      return field ? { isOpen: () => composer.isConnected && helpers.isVisible(composer) } : null;
    },
    async openComposer({ handoff, files, helpers }) {
      if (!location.hostname.endsWith("upscrolled.com")) throw new Error("This handoff only runs on UpScrolled.");
      const findCaption = () => {
        for (const dialog of [...document.querySelectorAll("[role='dialog'], dialog")].filter(helpers.isVisible)) {
          const field = [...dialog.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']")]
            .find(element => helpers.isVisible(element) && /caption|what.*mind|write|share/i.test(`${element.getAttribute("placeholder") || ""} ${element.getAttribute("aria-label") || ""}`))
            || [...dialog.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']")].find(helpers.isVisible);
          if (field) return field;
        }
        return null;
      };
      const findLauncher = () => helpers.findClickable("Post", document, element => !element.closest("[role='dialog'], dialog"));
      let caption = findCaption(), textInserted = false, mediaInserted = 0, error = "";
      try {
        if (!caption) {
          // The tab reports "complete" before UpScrolled's client app has
          // rendered its navigation, so the launcher may still be on its way.
          const launch = await helpers.waitForElement(findLauncher, LAUNCHER_WAIT_MS)
            .catch(() => { throw new Error("Open UpScrolled's composer, then use the Crossposter sidebar."); });
          launch.click();
          const chooser = await helpers.waitForElement(() => helpers.findDialogWithText("Create a post"));
          const choice = files.some(file => file.type.startsWith("video/")) ? "Video post" : files.length ? "Photo post" : "Text post";
          const choiceButton = await helpers.waitForElement(() => helpers.findClickable(choice, chooser, () => true, false), CHOICE_WAIT_MS)
            .catch(() => { throw new Error(`Choose “${choice}” in UpScrolled, then use the Crossposter sidebar.`); });
          choiceButton.click();
          caption = await helpers.waitForElement(findCaption);
        }
        textInserted = helpers.setComposerText(caption, handoff.text || "");
        if (files.length) {
          // The upload input mounts after the dialog's caption field, so wait
          // for it instead of attaching into a not-yet-rendered form.
          const root = caption.closest("[role='dialog'], dialog") || document;
          let preview = findAttachedMediaPreview(files, helpers, root);
          let cover = findCoverDialog(files, helpers);
          // A retry can arrive while UpScrolled's mandatory cover picker is
          // still sitting above an already accepted video. Do not assign the
          // file again: that removes the accepted item and restarts the flow.
          if (!preview && !cover) {
            await helpers.waitForElement(() => helpers.findCompatibleFileInput(files, root, false), 15000).catch(() => null);
            mediaInserted = helpers.attachNativeFiles(files, root);
            if (mediaInserted) {
              if (files.some(file => file.type.startsWith("video/"))) {
                // UpScrolled renders its ordinary video preview one React
                // commit before opening the cover picker. Waiting on either
                // element can therefore return just before the picker mounts.
                // A freshly attached video must wait for that next step.
                cover = await helpers.waitForElement(
                  () => findCoverDialog(files, helpers),
                  PREVIEW_WAIT_MS
                ).catch(() => null);
                preview = findAttachedMediaPreview(files, helpers, root);
                if (!cover && !preview) mediaInserted = 0;
              } else {
                preview = await helpers.waitForElement(
                  () => findAttachedMediaPreview(files, helpers, root),
                  PREVIEW_WAIT_MS
                ).catch(() => null);
                if (!preview) mediaInserted = 0;
              }
            }
          } else mediaInserted = files.length;

          // UpScrolled opens a cover picker as soon as a video is accepted.
          // Cancel only skips cover customization (it does not remove the
          // video), and the user can still choose a cover from the attached
          // video's controls before posting. Close this intermediate step so
          // the handoff lands on the reviewable, attached composer.
          if (mediaInserted && cover) {
            // This lookup is exact and scoped to the cover dialog. Never use
            // its Done button or the parent composer's Post button.
            const cancel = await helpers.waitForElement(
              () => helpers.findClickable("Cancel", cover),
              COVER_ACTION_WAIT_MS
            ).catch(() => null);
            cancel?.click();
            preview = await helpers.waitForElement(
              () => !findCoverDialog(files, helpers) && findAttachedMediaPreview(files, helpers, root),
              PREVIEW_WAIT_MS
            ).catch(() => null);
            if (!preview) mediaInserted = 0;
          }
          if (!mediaInserted) {
            error = "UpScrolled did not show the attached media.";
          }
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : "Use the Crossposter sidebar to finish the handoff.";
      }
      return { ok: true, composerOpened: Boolean(caption), textInserted, mediaInserted, error };
    }
  });

  const LAUNCHER_WAIT_MS = 15000;
  const CHOICE_WAIT_MS = 10000;
  const PREVIEW_WAIT_MS = 20000;
  const COVER_ACTION_WAIT_MS = 5000;

  function findCoverDialog(files, helpers) {
    if (!files.some(file => file.type.startsWith("video/"))) return null;
    const heading = helpers.queryAllDeep("h1, h2, h3, [role='heading']")
      .find(element => helpers.isVisible(element) && helpers.normalizeText(element) === "choose cover");
    return heading ? helpers.closestDeep(heading, "[role='dialog'], dialog") : null;
  }

  function findAttachedMediaPreview(files, helpers, root) {
    const wantsVideo = files.some(file => file.type.startsWith("video/"));
    if (wantsVideo) {
      return helpers.queryAllDeep("video", root).find(helpers.isVisible) || null;
    }
    return helpers.queryAllDeep("img", root)
      .find(image => helpers.isVisible(image) && /^(?:blob|data):/i.test(image.currentSrc || image.src || "")) || null;
  }

  function upscrolledCaptureText(post) {
    return [...post.querySelectorAll("p")].map(textWithoutExpansionControls).find(Boolean) || "";
  }

  function upscrolledVideoDetails(post, helpers, knownVideo) {
    const player = post.querySelector("mux-player");
    const playbackId = player?.getAttribute("playback-id") || "";
    const customDomain = player?.getAttribute("custom-domain") || "";
    const video = knownVideo || helpers?.queryAllDeep("video", post)?.[0] || post.querySelector("video");
    const buttonPoster = post.querySelector("button[aria-label='Play video'] img[src]")?.src || "";
    const playerPoster = player?.getAttribute("poster") || player?.poster || "";
    const poster = playerPoster || buttonPoster || video?.poster || "";
    const videoDomain = customDomain.replace(/^(?:image|stream)\./i, "");
    const manifest = playbackId && videoDomain ? `https://stream.${videoDomain}/${playbackId}.m3u8` : "";
    const source = video?.currentSrc || video?.src || "";
    return { poster, url: manifest || (/^https?:/i.test(source) ? source : "") || poster };
  }

  async function expandUpscrolledText(post, helpers) {
    const controls = helpers.queryAllDeep("button, a, [role='button']", post)
      .filter(control => /^(?:show|see|read) more$/iu.test(helpers.normalizeText(control)));
    if (!controls.length) return;
    const collapsedText = upscrolledCaptureText(post);
    controls.forEach(control => control.click?.());
    await helpers.waitForElement(
      () => upscrolledCaptureText(post).length > collapsedText.length ? post : null,
      5000
    ).catch(() => {});
  }

  function textWithoutExpansionControls(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll("button, [role='button']").forEach(control => control.remove());
    clone.querySelectorAll("a").forEach(link => {
      const label = (link.innerText || link.textContent || link.getAttribute?.("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim();
      if (/^(?:show|see) (?:more|less)$/iu.test(label)) link.remove();
    });
    return (clone.innerText || clone.textContent || "").trim();
  }
})();
