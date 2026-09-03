import { PLATFORM_PERMISSION_GROUPS, platformOriginsForIds } from "./content-scripts.js";

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
