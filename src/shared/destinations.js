// Display order, and the order a handoff fills composers in (one tab at a
// time). LinkedIn goes last: its media checks are the slowest, and every
// destination after it waits for them.
export const NATIVE_DESTINATIONS = Object.freeze([
  { id: "upscrolled", label: "UpScrolled", icon: "icons/networks/upscrolled.svg", homeUrl: "https://upscrolled.com/home" },
  { id: "x", label: "X", icon: "icons/networks/x.svg", homeUrl: "https://x.com/compose/post" },
  { id: "bluesky", label: "Bluesky", icon: "icons/networks/bluesky.svg", homeUrl: "https://bsky.app/" },
  { id: "instagram", label: "Instagram", icon: "icons/networks/instagram.svg", homeUrl: "https://www.instagram.com/" },
  { id: "threads", label: "Threads", icon: "icons/networks/threads.svg", homeUrl: "https://www.threads.com/" },
  { id: "facebook", label: "Facebook", icon: "icons/networks/facebook.svg", homeUrl: "https://www.facebook.com/" },
  { id: "substack", label: "Substack", icon: "icons/networks/substack.svg", homeUrl: "https://substack.com/home" },
  { id: "linkedin", label: "LinkedIn", icon: "icons/networks/linkedin.svg", homeUrl: "https://www.linkedin.com/feed/?shareActive=true" }
]);

export function nativeDestination(id) { return NATIVE_DESTINATIONS.find(destination => destination.id === id) || null; }
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
