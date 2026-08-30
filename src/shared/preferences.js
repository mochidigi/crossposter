import { isNativeDestinationDisabled, NATIVE_DESTINATIONS } from "./destinations.js";

export const DEFAULT_DESTINATIONS_KEY = "defaultDestinations";
export const ENABLED_PLATFORMS_KEY = "enabledPlatforms";
export const SHOW_INLINE_ACTIONS_KEY = "showInlineActions";

const PLATFORM_IDS = Object.freeze(NATIVE_DESTINATIONS.map(destination => destination.id));

export function normalizeEnabledPlatforms(value) {
  const requested = Array.isArray(value) ? new Set(value) : new Set(PLATFORM_IDS);
  return PLATFORM_IDS.filter(id => requested.has(id));
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
