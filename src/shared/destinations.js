export const NATIVE_DESTINATIONS = Object.freeze([
  { id: "upscrolled", label: "UpScrolled", icon: "icons/networks/upscrolled.svg", homeUrl: "https://upscrolled.com/home" },
  { id: "x", label: "X", icon: "icons/networks/x.svg", homeUrl: "https://x.com/compose/post" },
  { id: "linkedin", label: "LinkedIn", icon: "icons/networks/linkedin.svg", homeUrl: "https://www.linkedin.com/feed/?shareActive=true" },
  { id: "bluesky", label: "Bluesky", icon: "icons/networks/bluesky.svg", homeUrl: "https://bsky.app/" },
  { id: "instagram", label: "Instagram", icon: "icons/networks/instagram.svg", homeUrl: "https://www.instagram.com/" },
  { id: "threads", label: "Threads", icon: "icons/networks/threads.svg", homeUrl: "https://www.threads.com/" },
  { id: "facebook", label: "Facebook", icon: "icons/networks/facebook.svg", homeUrl: "https://www.facebook.com/" }
]);

export function nativeDestination(id) { return NATIVE_DESTINATIONS.find(destination => destination.id === id) || null; }
export function isNativeDestinationDisabled(draft, id) {
  return draft.sourceIsOwn === true && draft.sourceNetwork === id;
}
export function selectedNativeDestinations(draft) {
  const selected = new Set(draft.destinations || []);
  return NATIVE_DESTINATIONS.filter(destination => selected.has(destination.id) && !isNativeDestinationDisabled(draft, destination.id));
}
export function continueLabel(destinations) {
  if (destinations.length === 1) return `Continue to ${destinations[0].label}`;
  return destinations.length ? `Continue to ${destinations.length} sites` : "Choose destinations";
}
