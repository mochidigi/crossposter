import { nativeDestination } from "./destinations.js";
import { composerNotFound, composerNotFoundHint, handoffStageText } from "./handoff.js";
import { setHtml } from "./dom.js";
import { icon as uiIcon } from "./icons.js";

// Row details are short: the sidebar is narrow. A site's own error text can
// still run long, so the rows clamp it and keep the full text as `error`
// (shown on hover, and sent with a report).
import { isReportableFailure } from "./feedback.js";

// Where each destination of a crosspost stands, for the composer's status
// panel and the sidebar. `tone` drives the styling: "done" (filled or
// posted), "action" (the user has something to do on the site), "error",
// and "progress" (still opening or waiting its turn). `copyFrom` says where
// the text and media to copy are, relative to the reader: the composer
// points at the sidebar; the sidebar shows them below its rows.
export function handoffNetworkStatuses(handoff, { copyFrom = "from the sidebar" } = {}) {
  if (!handoff || handoff.state === "idle") return [];
  const results = new Map((handoff.results || []).map(item => [item.network, item]));
  const posted = new Set(handoff.postedNetworks || []);
  const tabs = handoff.destinationTabs || {};
  const finished = !["preparing", "filling"].includes(handoff.state);
  // One destination at a time can be filled again, once the crosspost is done.
  const canRetry = handoff.state === "ready" && !handoff.retrying;
  return (handoff.networks || []).map(nativeDestination).filter(Boolean).map(destination => {
    const entry = results.get(destination.id);
    const tabId = [entry?.tabId, tabs[destination.id]].find(Number.isInteger) ?? null;
    return {
      network: destination.id,
      label: destination.label,
      icon: destination.icon,
      tabId,
      reportable: finished && handoff.retrying !== destination.id && isReportableFailure(entry),
      ...networkState(handoff, destination, entry, posted.has(destination.id), copyFrom)
    };
  }).map(status => ({ ...status, retryable: canRetry && RETRYABLE.has(status.state) }));
}

// Retrying reloads the tab, so it is offered only where nothing filled in
// is lost that the user would want: failures, sign-ins, and partial fills.
const RETRYABLE = new Set(["failed", "signed-out", "manual", "partial"]);

function networkState(handoff, { id }, entry, posted, copyFrom) {
  if (posted) return { state: "posted", tone: "done", text: "Posted", detail: "" };
  // Destinations fill at the same time; each one still filling has its own
  // stage in handoff.progress.
  const stage = handoff.progress?.[id] ? handoffStageText(handoff.progress[id]) : "";
  if (handoff.retrying === id) return { state: "working", tone: "progress", text: stage || "Reloading the composer…", detail: "" };
  if (entry) {
    const result = entry.result || {};
    const error = entry.error || result.error || "";
    if (result.reason === "signed-out") return { state: "signed-out", tone: "action", text: "Sign in needed", detail: `Sign in, then add the post ${copyFrom}.`, error };
    if (result.reason === "needs-media") return { state: "needs-media", tone: "action", text: "Needs a photo or video", detail: "", error };
    if (error) return { state: "failed", tone: "error", text: "Not filled", detail: composerNotFound(result) ? composerNotFoundHint() : error, error };
    const wantsText = Boolean(handoff.text), wantsMedia = (handoff.media || []).length > 0;
    const textDone = !wantsText || result.textInserted === true, mediaDone = !wantsMedia || Number(result.mediaInserted || 0) > 0;
    // The site took the upload but its preview could not be confirmed.
    if (result.mediaUnverified && textDone) return { state: "check-media", tone: "action", text: "Check the media", detail: `${wantsText ? "Text is in. " : ""}Couldn’t confirm the media preview.` };
    if (textDone && mediaDone && (result.textInserted || result.mediaInserted)) return { state: "filled", tone: "done", text: "Ready to review", detail: "" };
    if (result.textInserted && !mediaDone) return { state: "partial", tone: "action", text: "Add the media", detail: `Text is in. Drag the media in ${copyFrom}.` };
    if (Number(result.mediaInserted || 0) > 0 && !textDone) return { state: "partial", tone: "action", text: "Add the text", detail: `Media is in. Add the text ${copyFrom}.` };
    return { state: "manual", tone: "action", text: "Add the post", detail: `Composer is open. Add the post ${copyFrom}.` };
  }
  if (handoff.state === "error") return { state: "failed", tone: "error", text: "Not opened", detail: "" };
  if (handoff.state === "filling" && handoff.progress?.[id]) return { state: "working", tone: "progress", text: stage || "Opening the composer…", detail: "" };
  if (handoff.state === "preparing" || handoff.state === "filling") return { state: "waiting", tone: "progress", text: "Waiting…", detail: "" };
  return { state: "failed", tone: "error", text: "Not opened", detail: "" };
}

// The panel heading and lead line for a crosspost's current state.
export function handoffSummary(handoff, statuses = handoffNetworkStatuses(handoff)) {
  const state = handoff?.state || "idle";
  if (state === "preparing") return { title: "Preparing your crosspost…", lead: "Getting the media ready. The composer tabs open next.", finished: false };
  if (state === "filling") {
    const settled = statuses.filter(item => !["working", "waiting"].includes(item.state)).length;
    return { title: `Filling composers · ${settled} of ${statuses.length}`, lead: "Crossposter opens each network’s composer and fills it. You review and post in each tab.", finished: false };
  }
  if (state === "error") return { title: "The crosspost stopped", lead: handoff.error || "The composers could not be opened.", finished: true };
  if (state !== "ready") return { title: "", lead: "", finished: false };
  if (handoff.retrying) {
    const label = statuses.find(item => item.network === handoff.retrying)?.label || "the destination";
    return { title: `Retrying ${label}…`, lead: "Crossposter reloads its tab and fills it again.", finished: true };
  }
  const total = statuses.length;
  if (total && statuses.every(item => item.state === "posted")) return { title: "Posted everywhere", lead: "Every destination in this crosspost has been posted.", finished: true };
  const attention = statuses.filter(item => item.tone === "action" || item.tone === "error").length;
  if (attention) return { title: `${attention} of ${total} need${attention === 1 ? "s" : ""} attention`, lead: `Finish ${attention === 1 ? "it in its tab" : "those in their tabs"}. The sidebar has the text and media to copy or drag.`, finished: true };
  return { title: "Ready to review", lead: "Each composer is filled. Review and post in its tab.", finished: true };
}

// One status row (<li>) for a destination: the icon, the name over its state,
// and the buttons ([retry] [Report] [Open]) side by side, top-aligned; any
// details get a line of their own below. `openTab`, `retry`, and `report` receive the
// row's status; the row offers each only when it applies, so a filled row is
// one line with just Open. The DOM keeps name, state, details, then buttons
// for screen readers; the grid places the buttons on the top line.
export function handoffStatusRow(status, { openTab, retry, report } = {}) {
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const row = element("li", `handoff-row tone-${status.tone}`);
  const icon = element("span", "network-icon"), image = element("img");
  image.src = status.icon; image.alt = ""; icon.append(image);
  const title = element("div", "handoff-row-title");
  title.append(element("span", "handoff-row-name", status.label), element("span", "handoff-row-state", status.text));
  const parts = [icon, title];
  if (status.detail) {
    const detail = element("span", "handoff-row-detail", status.detail);
    detail.title = status.error && status.error !== status.detail ? `${status.detail}\n\n${status.error}` : status.detail;
    parts.push(detail);
  }
  const actions = element("div", "handoff-row-actions");
  const action = (text, title, handler, className = "secondary") => {
    const button = element("button", className, text);
    button.type = "button"; button.title = title; button.onclick = () => handler(status);
    actions.append(button);
    return button;
  };
  if (retry && status.retryable) {
    const button = action("", `Retry: reload the ${status.label} tab and fill it again`, retry, "secondary handoff-retry");
    button.setAttribute("aria-label", `Retry ${status.label}`);
    setHtml(button, uiIcon("refresh"));
  }
  if (report && status.reportable) action("Report", "Opens Crossposter’s feedback form with details for fixing this. Nothing is sent until you press Send there.", report);
  if (openTab && Number.isInteger(status.tabId)) action(status.state === "signed-out" ? "Sign in" : "Open", `Switch to the ${status.label} tab`, openTab);
  row.append(...parts, actions);
  return row;
}
