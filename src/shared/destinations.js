// Display order, which is also the order the destinations take their turn in
// front. loadInFront: in Chrome the tab opens blank and the page loads once,
// at its turn (see loadsInFront in background.js).
export const NATIVE_DESTINATIONS = Object.freeze([
  { id: "upscrolled", label: "UpScrolled", icon: "icons/networks/upscrolled.svg", homeUrl: "https://upscrolled.com/home" },
  { id: "x", label: "X", icon: "icons/networks/x.svg", homeUrl: "https://x.com/compose/post", loadInFront: true },
  { id: "bluesky", label: "Bluesky", icon: "icons/networks/bluesky.svg", homeUrl: "https://bsky.app/" },
  { id: "instagram", label: "Instagram", icon: "icons/networks/instagram.svg", homeUrl: "https://www.instagram.com/" },
  { id: "threads", label: "Threads", icon: "icons/networks/threads.svg", homeUrl: "https://www.threads.com/" },
  { id: "facebook", label: "Facebook", icon: "icons/networks/facebook.svg", homeUrl: "https://www.facebook.com/" },
  { id: "substack", label: "Substack", icon: "icons/networks/substack.svg", homeUrl: "https://substack.com/home" },
  { id: "linkedin", label: "LinkedIn", icon: "icons/networks/linkedin.svg", homeUrl: "https://www.linkedin.com/feed/?shareActive=true" }
]);

export function nativeDestination(id) { return NATIVE_DESTINATIONS.find(destination => destination.id === id) || null; }

// The platforms' own links that open their composer with the text already in
// it: X Web Intents, Threads Web Intents and Bluesky's action intent links.
// None of them carries media, which the adapter still attaches. maxLength
// mirrors the adapter's own cap (Threads takes 500 characters).
const PREFILL_LINKS = Object.freeze({
  x: { base: "https://x.com/intent/tweet" },
  bluesky: { base: "https://bsky.app/intent/compose" },
  threads: { base: "https://www.threads.com/intent/post", maxLength: 500 }
});
// Servers commonly refuse a request line over 8 KB; longer text goes through
// the home page and the composer fill instead.
const MAX_PREFILL_URL_LENGTH = 6000;

// Where a destination's tab opens for a handoff, and whether that link puts
// the text in the composer (the adapter then waits for it rather than typing).
export function destinationUrl(destination, text = "") {
  const home = { url: destination?.homeUrl || "", prefilled: false };
  const link = PREFILL_LINKS[destination?.id];
  const value = String(text || "").slice(0, link?.maxLength ?? Infinity);
  if (!link || !value.trim()) return home;
  let url;
  try { url = `${link.base}?text=${encodeURIComponent(value)}`; }
  catch { return home; } // a lone surrogate, e.g. an emoji cut at maxLength
  return url.length <= MAX_PREFILL_URL_LENGTH ? { url, prefilled: true } : home;
}

export function isNativeDestinationDisabled(draft, id) {
  return draft.sourceIsOwn === true && draft.sourceNetwork === id;
}
// Why a destination can't take this draft right now, shown on its tile; ""
// when it can. Instagram only accepts posts with a photo or video, so it is
// held back until the draft has media but keeps its place in the selection.
export function nativeDestinationBlocker(draft, id) {
  if (isNativeDestinationDisabled(draft, id)) return "Your own post";
  if (id === "instagram" && !(draft.media || []).length) return "Needs media";
  return "";
}
export function selectedNativeDestinations(draft) {
  const selected = new Set(draft.destinations || []);
  return NATIVE_DESTINATIONS.filter(destination => selected.has(destination.id) && !nativeDestinationBlocker(draft, destination.id));
}
export function continueLabel(destinations) {
  if (destinations.length === 1) return `Continue to ${destinations[0].label}`;
  return destinations.length ? `Continue to ${destinations.length} sites` : "Choose destinations";
}
