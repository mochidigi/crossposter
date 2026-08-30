(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;
  core.register({
    id: "instagram",
    matches: host => host === "instagram.com" || host.endsWith(".instagram.com"),
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
})();
