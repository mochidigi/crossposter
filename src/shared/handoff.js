export function handoffFilename(item, index = 0) {
  if (item.filename) return item.filename;
  const extension = item.kind === "video" ? extensionForType(item.type, "mp4") : extensionForType(item.type, "jpg");
  return `crossposter-${index + 1}.${extension}`;
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
