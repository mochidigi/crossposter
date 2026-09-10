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
// native composer (helpers.reportComposerStage). The sidebar shows these as
// the handoff status, so every network reports the same vocabulary.
export const HANDOFF_STAGES = Object.freeze({
  locate: label => `Looking for ${label}’s post composer…`,
  open: label => `Opening ${label}’s post composer…`,
  inspect: label => `Checking ${label}’s existing draft…`,
  attach: label => `Attaching media to ${label}…`,
  "process-media": label => `Waiting for ${label} to prepare the media…`,
  "verify-media": label => `Checking ${label}’s media previews…`,
  "fill-text": label => `Inserting the ${label} post text…`,
  "verify-text": label => `Checking the ${label} post text…`,
  verify: label => `Waiting for ${label}’s post to be ready…`,
  ready: label => `${label}’s composer is ready for review.`
});

export function isHandoffStage(stage) {
  return typeof stage === "string" && Object.hasOwn(HANDOFF_STAGES, stage);
}

export function handoffStageText(stage, label = "the destination") {
  return isHandoffStage(stage) ? HANDOFF_STAGES[stage](label) : "";
}

// A handoff that ended at the locate stage without a composer is either a
// page that never showed one (logged out, blocked) or a composer the adapter
// no longer recognizes because the site changed its markup. The user can
// tell those apart by looking at the page, so say so.
export function composerNotFound(result) {
  return Boolean(result) && result.composerOpened === false && result.stage === "locate";
}

export function composerNotFoundHint(label = "The site") {
  return `If ${label}’s composer is already open on the page, ${label} has probably changed its layout and Crossposter needs an update — please report this.`;
}

export const COMPOSER_DELIVERY_TIMEOUT_MS = 20000;
export const COMPOSER_DELIVERY_RETRY_MS = 750;

// "Receiving end does not exist" means no content script is listening in any
// frame yet (both browsers use this wording).
export function isMissingContentScriptError(error) {
  return /receiving end does not exist|could not establish connection/i.test(errorText(error));
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
