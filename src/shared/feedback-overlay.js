// Crossposter's feedback form as an overlay on Compose and the sidebar: a
// dialog frames feedback.html?embedded=1 instead of opening it in a tab. The
// background builds the report (OPEN_FEEDBACK with `overlay`) and returns its
// id; the framed form sends nothing until its own Send click.
import { ext } from "./browser.js";
import { FEEDBACK_FRAME_MESSAGE } from "./feedback.js";

// `dialog` holds the <iframe>. Returns open(request), which rejects when the
// report could not be prepared; the dialog shows once the framed form has
// rendered it. The form has its own close button and handles Escape.
export function feedbackOverlay(dialog) {
  const frame = dialog.querySelector("iframe");
  let unsent = false, preparing = false, showForm = null;

  // Asks first when the user has typed a message that was not sent.
  const close = () => {
    if (!dialog.open || (unsent && !confirm("Discard your unsent feedback?"))) return;
    dialog.close();
  };
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  // Unload the form so the next one starts from its own report.
  dialog.addEventListener("close", () => { unsent = false; showForm = null; frame.src = "about:blank"; });

  window.addEventListener("message", event => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== FEEDBACK_FRAME_MESSAGE) return;
    const { height, ready, unsent: hasUnsent, close: wantsClose } = event.data;
    if (Number.isFinite(height)) frame.style.height = `${Math.ceil(height)}px`;
    if (typeof hasUnsent === "boolean") unsent = hasUnsent;
    if (ready) showForm?.();
    if (wantsClose) close();
  });

  return async function open(request) {
    if (dialog.open || preparing) return;
    preparing = true;
    try {
      const response = await ext.runtime.sendMessage({ ...request, type: "OPEN_FEEDBACK", overlay: true }).catch(() => null);
      if (!response?.ok || typeof response.reportId !== "string") throw new Error(response?.error || "The feedback form could not be opened.");
      showForm = () => { showForm = null; if (!dialog.open) dialog.showModal(); frame.focus(); };
      frame.src = `feedback.html?embedded=1&report=${encodeURIComponent(response.reportId)}`;
    } finally { preparing = false; }
  };
}
