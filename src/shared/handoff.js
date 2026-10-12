export function handoffFilename(item, index = 0) {
  if (item.filename) return item.filename;
  const extension = item.kind === "video" ? extensionForType(item.type, "mp4") : extensionForType(item.type, "jpg");
  return `crossposter-${index + 1}.${extension}`;
}

// CDNs often serve media as a generic octet stream. Platform file inputs
// filter on the File's MIME type, so a generic type silently drops the video.
export function handoffMediaType(blobType, kind) {
  const type = String(blobType || "").trim().toLowerCase();
  if (type && !/^(?:application|binary)\/octet-stream$/.test(type)) return type;
  return kind === "video" ? "video/mp4" : "image/jpeg";
}

// One tab at a time can be in front while a handoff fills. Destinations that
// fill in front (LinkedIn), and background fills whose site did not build its
// composer while hidden, take turns through this queue. `onIdle` runs once no
// turn is waiting, to bring Compose back; `idle()` resolves after it.
export function foregroundQueue(onIdle = async () => {}) {
  let tail = Promise.resolve(), pending = 0;
  const run = job => {
    pending++;
    const result = tail.then(() => job());
    tail = result.catch(() => {}).then(async () => { if (--pending === 0) await onIdle(); }).catch(() => {});
    return result;
  };
  run.idle = () => tail;
  return run;
}

export function shouldRetryCanonicalComposer(network, result) {
  return network === "x" && result?.composerOpened === false;
}

export function shouldRetryMediaAttachment(network, result, mediaCount) {
  return result?.retryable !== false && ["x", "linkedin", "upscrolled", "threads", "bluesky"].includes(network) && result?.composerOpened === true && Number(mediaCount) > 0 && Number(result.mediaInserted || 0) === 0;
}

export function shouldRetryTextInsertion(network, result, text) {
  return result?.retryable !== false && network === "linkedin" && result?.composerOpened === true && Boolean(text) && result.textInserted !== true;
}

export function selectComposerFrame(frames = []) {
  return frames.filter(frame => Number.isInteger(frame.frameId) && Number(frame.result) > 0)
    .sort((a, b) => Number(b.result) - Number(a.result) || a.frameId - b.frameId)[0]?.frameId;
}

// Progress reported by the content-script adapters while they drive a
// native composer (helpers.reportComposerStage), so every network reports
// the same vocabulary. The status rows show these beside the network's name,
// so they don't repeat it.
export const HANDOFF_STAGES = Object.freeze({
  window: "Waiting for the browser window…",
  locate: "Finding the composer…",
  open: "Opening the composer…",
  inspect: "Checking for a draft…",
  attach: "Attaching media…",
  "process-media": "Waiting for the media to process…",
  "verify-media": "Checking the media preview…",
  "fill-text": "Adding the text…",
  "verify-text": "Checking the text…",
  verify: "Waiting for the post to be ready…",
  ready: "Ready to review"
});

export function isHandoffStage(stage) {
  return typeof stage === "string" && Object.hasOwn(HANDOFF_STAGES, stage);
}

export function handoffStageText(stage) {
  return isHandoffStage(stage) ? HANDOFF_STAGES[stage] : "";
}

// A handoff that ended at the locate stage without a composer is either a
// page that never showed one (slow, blocked) or a composer the adapter no
// longer recognizes because the site changed its markup. Signed-out pages
// are told apart separately (reason "signed-out"), so the hint offers both
// a retry and a report rather than asking the user to diagnose which.
export function composerNotFound(result) {
  return Boolean(result) && result.composerOpened === false && result.stage === "locate" && result.reason !== "signed-out";
}

export function composerNotFoundHint() {
  return "Composer not found. Please try again or report this.";
}

export const COMPOSER_DELIVERY_TIMEOUT_MS = 20000;
export const COMPOSER_DELIVERY_RETRY_MS = 750;

// "Receiving end does not exist" means no content script is listening in any
// frame yet (both browsers use this wording).
export function isMissingContentScriptError(error) {
  return /receiving end does not exist|could not establish connection/i.test(errorText(error));
}

// Rejects with `message` when `promise` has not settled within `milliseconds`.
// Arc accepts chrome.tabs.group() but never settles it, which would otherwise
// stall every step queued behind the grouping.
export function settleWithin(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Dia (and Chrome for tabs outside a normal window) refuses tabs.group() with
// "Grouping is not supported by tabs in this window."
export function isTabGroupingUnsupportedError(error) {
  return /grouping is not supported/i.test(errorText(error));
}

// Chromium forks with their own window UI (Arc) expose chrome.sidePanel but
// have no side panel to open, so sidePanel.open() rejects with this error.
export function isSidePanelUnavailableError(error) {
  return /no active side panel/i.test(errorText(error));
}

// A frame that does not own the composer stays silent, which Chrome reports
// as a closed port and Firefox as an undefined response. Both mean "ask
// again shortly", not "the handoff failed".
export function shouldRetryComposerDelivery(response, error) {
  if (error) return isMissingContentScriptError(error) || /message port closed before a response|no response/i.test(errorText(error));
  return response === undefined;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function composerTabProperties(url, windowId, active = true) {
  return {
    url,
    active,
    ...(Number.isInteger(windowId) ? { windowId } : {})
  };
}

export const COMPOSER_GROUP_APPEARANCE = Object.freeze({
  title: "Crossposter",
  color: "grey",
  collapsed: false
});

export function composerGroupTabIds(tabIds = []) {
  const unique = [...new Set(tabIds.filter(Number.isInteger))];
  return unique.length > 1 ? unique : [];
}

export function composerTabsToClose(activeTabId, tabIds = []) {
  const unique = [...new Set(tabIds.filter(Number.isInteger))];
  return unique.includes(activeTabId) ? unique : [];
}

export function composerSessionTabsToClose(activeTabId, composerTabIds = [], sourceTabIds = []) {
  const composers = composerTabsToClose(activeTabId, composerTabIds);
  return composers.length ? [...new Set([...composers, ...sourceTabIds.filter(Number.isInteger)])] : [];
}

function extensionForType(type = "", fallback) {
  const subtype = type.split("/")[1]?.split(/[;+]/)[0]?.toLowerCase();
  if (!subtype) return fallback;
  if (subtype === "jpeg") return "jpg";
  if (/^[a-z0-9]+$/.test(subtype)) return subtype;
  return fallback;
}
