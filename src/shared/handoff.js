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
  return ["x", "linkedin", "upscrolled", "threads"].includes(network) && result?.composerOpened === true && Number(mediaCount) > 0 && Number(result.mediaInserted || 0) === 0;
}

export function shouldRetryTextInsertion(network, result, text) {
  return network === "linkedin" && result?.composerOpened === true && Boolean(text) && result.textInserted !== true;
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
