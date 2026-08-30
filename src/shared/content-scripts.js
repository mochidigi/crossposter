export const CONTENT_SCRIPT_CORE = "content.js";

export const PLATFORM_CONTENT_SCRIPTS = Object.freeze([
  { platformId: "linkedin", id: "crossposter-linkedin", file: "platforms/linkedin/content.js", matches: ["https://www.linkedin.com/*"], allFrames: true, hosts: host => host === "www.linkedin.com" },
  { platformId: "x", id: "crossposter-x", file: "platforms/x/content.js", matches: ["https://x.com/*", "https://twitter.com/*"], hosts: host => host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com") },
  { platformId: "bluesky", id: "crossposter-bluesky", file: "platforms/bluesky/content.js", matches: ["https://bsky.app/*"], hosts: host => host === "bsky.app" },
  { platformId: "upscrolled", id: "crossposter-upscrolled", file: "platforms/upscrolled/content.js", matches: ["https://upscrolled.com/*", "https://www.upscrolled.com/*"], hosts: host => host === "upscrolled.com" || host === "www.upscrolled.com" },
  { platformId: "instagram", id: "crossposter-instagram", file: "platforms/instagram/content.js", matches: ["https://www.instagram.com/*", "https://instagram.com/*"], hosts: host => host === "instagram.com" || host === "www.instagram.com" },
  { platformId: "threads", id: "crossposter-threads", file: "platforms/threads/content.js", matches: ["https://www.threads.com/*", "https://threads.com/*"], hosts: host => host === "threads.com" || host === "www.threads.com" },
  { platformId: "facebook", id: "crossposter-facebook", file: "platforms/facebook/content.js", matches: ["https://www.facebook.com/*", "https://web.facebook.com/*", "https://facebook.com/*"], hosts: host => host === "facebook.com" || host === "www.facebook.com" || host === "web.facebook.com" }
]);

export function platformContentScriptForUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { return null; }
  return PLATFORM_CONTENT_SCRIPTS.find(item => item.hosts(host)) || null;
}

export function contentScriptFilesForUrl(url, enabledPlatforms) {
  const adapter = platformContentScriptForUrl(url);
  const enabled = Array.isArray(enabledPlatforms) ? new Set(enabledPlatforms) : null;
  if (adapter && enabled && !enabled.has(adapter.platformId)) return [];
  return adapter ? [CONTENT_SCRIPT_CORE, adapter.file] : [];
}

export function registeredPlatformContentScripts(enabledPlatforms) {
  const enabled = new Set(enabledPlatforms || PLATFORM_CONTENT_SCRIPTS.map(item => item.platformId));
  return PLATFORM_CONTENT_SCRIPTS.filter(item => enabled.has(item.platformId)).map(item => ({
    id: item.id,
    matches: [...item.matches],
    js: [CONTENT_SCRIPT_CORE, item.file],
    runAt: "document_idle",
    persistAcrossSessions: true,
    ...(item.allFrames ? { allFrames: true } : {})
  }));
}
