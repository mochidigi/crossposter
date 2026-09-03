export const CONTENT_SCRIPT_CORE = "content.js";

function permissionGroup(documents, services = []) {
  return Object.freeze({ documents: Object.freeze(documents), services: Object.freeze(services) });
}

// Keep every platform's page, API, and media hosts together. Runtime
// permission recovery must grant the whole group or capture can work while
// media resolution fails later on a related CDN.
export const PLATFORM_PERMISSION_GROUPS = Object.freeze({
  linkedin: permissionGroup(["https://www.linkedin.com/*"], ["https://*.licdn.com/*"]),
  x: permissionGroup(["https://x.com/*", "https://twitter.com/*"], ["https://*.twimg.com/*"]),
  bluesky: permissionGroup(["https://bsky.app/*"], ["https://video.bsky.app/*", "https://public.api.bsky.app/*"]),
  upscrolled: permissionGroup(["https://upscrolled.com/*", "https://www.upscrolled.com/*"], ["https://*.video.upscrolled.com/*"]),
  instagram: permissionGroup(["https://www.instagram.com/*", "https://instagram.com/*"], ["https://*.cdninstagram.com/*", "https://*.fbcdn.net/*"]),
  threads: permissionGroup(["https://www.threads.com/*", "https://threads.com/*"], ["https://*.cdninstagram.com/*", "https://*.fbcdn.net/*"]),
  facebook: permissionGroup(["https://www.facebook.com/*", "https://web.facebook.com/*", "https://facebook.com/*"], ["https://*.fbcdn.net/*"]),
  youtube: permissionGroup([], ["https://*.googlevideo.com/*"])
});

export const PLATFORM_CONTENT_SCRIPTS = [
  { platformId: "linkedin", id: "crossposter-linkedin", file: "platforms/linkedin/content.js", matches: PLATFORM_PERMISSION_GROUPS.linkedin.documents, allFrames: true, hosts: host => host === "www.linkedin.com" },
  { platformId: "x", id: "crossposter-x", file: "platforms/x/content.js", matches: PLATFORM_PERMISSION_GROUPS.x.documents, hosts: host => host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com") },
  { platformId: "bluesky", id: "crossposter-bluesky", file: "platforms/bluesky/content.js", matches: PLATFORM_PERMISSION_GROUPS.bluesky.documents, hosts: host => host === "bsky.app" },
  { platformId: "upscrolled", id: "crossposter-upscrolled", file: "platforms/upscrolled/content.js", matches: PLATFORM_PERMISSION_GROUPS.upscrolled.documents, hosts: host => host === "upscrolled.com" || host === "www.upscrolled.com" },
  { platformId: "instagram", id: "crossposter-instagram", file: "platforms/instagram/content.js", matches: PLATFORM_PERMISSION_GROUPS.instagram.documents, hosts: host => host === "instagram.com" || host === "www.instagram.com" },
  { platformId: "threads", id: "crossposter-threads", file: "platforms/threads/content.js", matches: PLATFORM_PERMISSION_GROUPS.threads.documents, hosts: host => host === "threads.com" || host === "www.threads.com" },
  { platformId: "facebook", id: "crossposter-facebook", file: "platforms/facebook/content.js", matches: PLATFORM_PERMISSION_GROUPS.facebook.documents, hosts: host => host === "facebook.com" || host === "www.facebook.com" || host === "web.facebook.com" }
];

export function registerPlatformContentScript(script) {
  if (!script?.platformId || !script?.id || !script?.file || !Array.isArray(script.matches) || typeof script.hosts !== "function") {
    throw new Error("Invalid platform content-script registration.");
  }
  const index = PLATFORM_CONTENT_SCRIPTS.findIndex(item => item.id === script.id);
  if (index >= 0) PLATFORM_CONTENT_SCRIPTS[index] = script;
  else PLATFORM_CONTENT_SCRIPTS.unshift(script);
  return script;
}

export function platformContentScriptForUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { return null; }
  return PLATFORM_CONTENT_SCRIPTS.find(item => item.hosts(host)) || null;
}

export function platformDocumentUrlPatterns() {
  return [...new Set(PLATFORM_CONTENT_SCRIPTS.flatMap(script => script.matches))];
}

export function platformOriginsForIds(platformIds = []) {
  return [...new Set(platformIds.flatMap(platformId => {
    const group = PLATFORM_PERMISSION_GROUPS[platformId];
    return group ? [...group.documents, ...group.services] : [];
  }))];
}

export function contentScriptFilesForUrl(url, enabledPlatforms) {
  const adapter = platformContentScriptForUrl(url);
  const enabled = Array.isArray(enabledPlatforms) ? new Set(enabledPlatforms) : null;
  if (adapter && enabled && !adapter.sourceOnly && !enabled.has(adapter.platformId)) return [];
  return adapter ? [CONTENT_SCRIPT_CORE, adapter.file] : [];
}

export function registeredPlatformContentScripts(enabledPlatforms) {
  const enabled = new Set(enabledPlatforms || PLATFORM_CONTENT_SCRIPTS.map(item => item.platformId));
  return PLATFORM_CONTENT_SCRIPTS.filter(item => !item.activeTabOnly && (item.sourceOnly || enabled.has(item.platformId))).map(item => ({
    id: item.id,
    matches: [...item.matches],
    js: [CONTENT_SCRIPT_CORE, item.file],
    runAt: "document_idle",
    persistAcrossSessions: true,
    ...(item.allFrames ? { allFrames: true } : {})
  }));
}
