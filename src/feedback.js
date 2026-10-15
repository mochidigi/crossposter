import { ext } from "./shared/browser.js";
import { nativeDestination } from "./shared/destinations.js";
import { FEEDBACK_FRAME_MESSAGE, feedbackConsentTypes, feedbackSubmission, readFeedbackReport, removeFeedbackReport, requestFeedbackConsent, sendFeedback } from "./shared/feedback.js";

const LABELS = {
  problem: ["What happened?", "What were you doing, what did you expect, and what happened instead?"],
  idea: ["Your idea", "What would you like Crossposter to do?"],
  other: ["Your message", ""]
};
const storage = ext.storage.session;
const manifest = ext.runtime.getManifest();
const params = new URL(location.href).searchParams;
const reportId = params.get("report") || "";
const form = document.querySelector("#feedbackForm"), message = document.querySelector("#message");
const includeReport = document.querySelector("#includeReport"), status = document.querySelector("#status"), send = document.querySelector("#send");

// Framed by the Compose or sidebar overlay (shared/feedback-overlay.js),
// which sizes the frame to the form and closes it, asking first when a
// typed message was not sent.
const embedded = params.has("embedded") && window.parent !== window;
const toOverlay = data => { if (embedded) window.parent.postMessage({ type: FEEDBACK_FRAME_MESSAGE, ...data }, location.origin); };
if (embedded) {
  document.documentElement.classList.add("embedded");
  const card = document.querySelector(".feedback-card");
  new ResizeObserver(() => toOverlay({ height: card.getBoundingClientRect().height })).observe(card);
  message.addEventListener("input", () => toOverlay({ unsent: Boolean(message.value.trim()) }));
  const closeOverlay = document.querySelector("#closeOverlay");
  closeOverlay.hidden = false;
  closeOverlay.onclick = () => toOverlay({ close: true });
  // Escape inside the frame doesn't reach the overlay's dialog.
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    toOverlay({ close: true });
  });
  document.querySelector("#closeTab").textContent = "Close";
}

const report = reportId ? await readFeedbackReport(storage, reportId).catch(() => null) : null;
if (report) showReport(report);
toOverlay({ ready: true, height: document.querySelector(".feedback-card").getBoundingClientRect().height });

function showReport(details) {
  const failed = details.handoff || details.crosspost?.results?.find(result => result.ok === false);
  const network = nativeDestination(failed?.network)?.label || failed?.network || "";
  const problem = failed?.error ? `${network ? `${network}: ` : ""}${failed.error}` : details.error || details.crosspost?.error || details.crosspost?.mediaErrors?.[0] || "";
  const browser = details.browser || {};
  const environment = [
    details.extension?.version && `Crossposter ${details.extension.version}`,
    [browser.name, browser.version].filter(Boolean).join(" "),
    browser.os, browser.language
  ].filter(Boolean).join(" · ");
  document.querySelector("#attachedProblem").textContent = problem;
  document.querySelector("#attachedProblem").hidden = !problem;
  document.querySelector("#attachedEnvironment").textContent = environment;
  document.querySelector("#attached").hidden = details.kind !== "error";
  if (details.kind === "error") {
    message.placeholder = "Optional, but a sentence about what you were doing helps a lot.";
    document.querySelector("#diagnosticsSummary").textContent = "Your Crossposter and browser versions, which step failed, and the error shown.";
  }
  const { snapshot, ...rest } = details;
  document.querySelector("#reportJson").textContent = JSON.stringify(rest, null, 2);
  if (typeof snapshot === "string" && snapshot) {
    document.querySelector("#diagnosticsSummary").textContent =
      "Your Crossposter and browser versions, which step failed, and an outline of the page’s structure. All text in the outline is masked; it contains no post text, media, form values, cookies, or addresses.";
    document.querySelector("#outlineSummary").textContent = `Page outline (${Math.max(1, Math.round(snapshot.length / 1024))} KB)`;
    document.querySelector("#outlinePreview").textContent = snapshot.length > 60000 ? `${snapshot.slice(0, 60000)}\n…` : snapshot;
    document.querySelector("#outlineDetails").hidden = false;
  } else if (details.diagnosticsError) {
    document.querySelector("#diagnosticsSummary").textContent =
      `Your Crossposter and browser versions, which step failed, and the error shown. Crossposter couldn’t capture an outline of the page: ${details.diagnosticsError}`;
  }
  document.querySelector("#diagnostics").hidden = false;
}

form.addEventListener("change", event => {
  if (event.target.name !== "category") return;
  const [label, placeholder] = LABELS[event.target.value] || LABELS.other;
  document.querySelector("#messageLabel").textContent = label;
  if (report?.kind !== "error") message.placeholder = placeholder;
});

function showError(text, field) {
  status.textContent = text;
  status.classList.add("error");
  field?.focus();
}

// Send runs from the button's click (Enter in a field clicks it too) so that
// Firefox's data-consent prompt can open: it only appears during a user
// action, so nothing may be awaited before requestFeedbackConsent.
form.addEventListener("submit", event => event.preventDefault());
send.addEventListener("click", event => {
  event.preventDefault();
  status.classList.remove("error");
  const includeDetails = Boolean(report) && includeReport.checked;
  const submission = feedbackSubmission({ category: form.elements.category.value, message: message.value, report, includeDetails });
  if (!submission.message && !submission.report) return showError("Please describe the problem or idea first.", message);
  const consent = requestFeedbackConsent(ext, feedbackConsentTypes(manifest, {
    details: includeDetails, outline: Boolean(includeDetails && report?.snapshot)
  }));
  send.disabled = true;
  status.textContent = "Sending…";
  consent.then(async granted => {
    if (!granted) throw new Error("Firefox did not allow sending these details. Untick the diagnostic details to send just your message.");
    const result = await sendFeedback(submission);
    if (reportId) await removeFeedbackReport(storage, reportId).catch(() => {});
    document.querySelector("#reference").textContent = String(result.id || "").slice(0, 8) || "—";
    toOverlay({ unsent: false });
    form.hidden = true;
    const thanks = document.querySelector("#thanks");
    thanks.hidden = false;
    thanks.focus();
  }).catch(error => {
    showError(error instanceof Error ? error.message : "The feedback could not be sent.");
    send.disabled = false;
  });
});

document.querySelector("#closeTab").onclick = async () => {
  if (embedded) return toOverlay({ close: true });
  const tab = await ext.tabs.getCurrent().catch(() => null);
  if (Number.isInteger(tab?.id)) ext.tabs.remove(tab.id).catch(() => window.close());
  else window.close();
};
