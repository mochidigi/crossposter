import { isNativeDestinationDisabled, NATIVE_DESTINATIONS } from "./destinations.js";

export const DEFAULT_DESTINATIONS_KEY = "defaultDestinations";
export const ENABLED_PLATFORMS_KEY = "enabledPlatforms";
export const SHOW_INLINE_ACTIONS_KEY = "showInlineActions";
// The platforms that existed when enabledPlatforms was saved. A platform added
// by a later version is enabled until the user turns it off in Settings;
// without this, a saved list would hide every new platform for good.
export const KNOWN_PLATFORMS_KEY = "knownPlatforms";

export const PLATFORM_IDS = Object.freeze(NATIVE_DESTINATIONS.map(destination => destination.id));
// Settings saved before knownPlatforms was stored knew exactly these.
const LEGACY_KNOWN_PLATFORMS = Object.freeze(["upscrolled", "x", "linkedin", "bluesky", "instagram", "threads", "facebook"]);

export function normalizeEnabledPlatforms(value, knownPlatforms = PLATFORM_IDS) {
  const requested = Array.isArray(value) ? new Set(value) : new Set(PLATFORM_IDS);
  const known = new Set(knownPlatforms);
  return PLATFORM_IDS.filter(id => requested.has(id) || !known.has(id));
}

export function storedEnabledPlatforms(stored = {}) {
  const known = Array.isArray(stored[KNOWN_PLATFORMS_KEY]) ? stored[KNOWN_PLATFORMS_KEY] : LEGACY_KNOWN_PLATFORMS;
  return normalizeEnabledPlatforms(stored[ENABLED_PLATFORMS_KEY], known);
}

export function inlineActionsEnabled(value) { return value !== false; }

export function normalizeDefaultDestinations(value) {
  const requested = Array.isArray(value) ? new Set(value) : new Set(["upscrolled"]);
  return NATIVE_DESTINATIONS.map(destination => destination.id).filter(id => requested.has(id));
}

export function initialDraftDestinations(draft = {}, defaults, enabledPlatforms) {
  const enabled = new Set(normalizeEnabledPlatforms(enabledPlatforms));
  const requested = Array.isArray(draft.destinations) && draft.destinations.length
    ? normalizeDefaultDestinations(draft.destinations)
    : normalizeDefaultDestinations(defaults);
  return requested.filter(id => enabled.has(id) && !isNativeDestinationDisabled(draft, id));
}
