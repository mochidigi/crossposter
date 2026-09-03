import { PLATFORM_PERMISSION_GROUPS, platformOriginsForIds } from "./content-scripts.js";

export const SITE_ACCESS_PAGE = "welcome.html";
export const SITE_ACCESS_DISMISSED_KEY = "crossposterSiteAccessDismissed";

export function platformLabel(id) {
  return ({
    upscrolled: "UpScrolled",
    linkedin: "LinkedIn",
    x: "X",
    bluesky: "Bluesky",
    instagram: "Instagram",
    threads: "Threads",
    facebook: "Facebook",
    youtube: "YouTube"
  })[id] || id;
}

// Platforms whose complete host bundle the running manifest declares. A group
// present only in one browser's manifest (YouTube is Firefox-only) must not be
// listed or requested elsewhere: the browser rejects the whole request.
export function allPlatformIds(manifest = null) {
  const ids = Object.keys(PLATFORM_PERMISSION_GROUPS);
  if (!manifest) return ids;
  const declared = new Set([...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])]);
  return ids.filter(platformId => platformOriginsForIds([platformId]).every(origin => declared.has(origin)));
}

// Firefox treats every MV3 host permission as optional: users can revoke any
// of them in about:addons, and hosts added by an update are not granted. The
// whole install therefore has to be checked, not just the manifest.
export async function missingSitePlatforms(permissionApi, manifest = null) {
  return incompletePlatformPermissions(permissionApi, allPlatformIds(manifest));
}

export function platformIdsWithPermissionGroups(platformIds = []) {
  return [...new Set(platformIds.filter(platformId => PLATFORM_PERMISSION_GROUPS[platformId]))];
}

export async function incompletePlatformPermissions(permissionApi, platformIds = []) {
  const ids = platformIdsWithPermissionGroups(platformIds);
  if (!permissionApi?.contains) return ids;
  const checks = await Promise.all(ids.map(async platformId => {
    try {
      return await permissionApi.contains({ origins: platformOriginsForIds([platformId]) }) ? null : platformId;
    } catch {
      return platformId;
    }
  }));
  return checks.filter(Boolean);
}

export async function requestCompletePlatformPermissions(permissionApi, platformIds = []) {
  const ids = platformIdsWithPermissionGroups(platformIds);
  if (!ids.length) return { ok: true, missing: [], requested: false, error: "" };
  if (!permissionApi?.request) {
    return { ok: false, missing: ids, requested: false, error: "Crossposter cannot request site access in this browser." };
  }

  // Call request() before awaiting anything so the browser still associates it
  // with the extension-page click that initiated the operation.
  let error = "";
  try {
    await permissionApi.request({ origins: platformOriginsForIds(ids) });
  } catch (requestError) {
    error = requestError instanceof Error ? requestError.message : String(requestError);
  }
  const missing = await incompletePlatformPermissions(permissionApi, ids);
  return { ok: !missing.length, missing, requested: true, error };
}
