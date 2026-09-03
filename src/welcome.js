import { ext } from "./shared/browser.js";
import { allPlatformIds, incompletePlatformPermissions, missingSitePlatforms, platformLabel, requestCompletePlatformPermissions, SITE_ACCESS_DISMISSED_KEY } from "./shared/platform-permissions.js";

const list = document.querySelector("#siteList");
const allow = document.querySelector("#allow");
const later = document.querySelector("#later");
const error = document.querySelector("#error");
const hint = document.querySelector("#hint");
const manifest = ext.runtime.getManifest();
let missingPlatforms = allPlatformIds(manifest);
const pageUrl = new URL(location.href);
const resumeToken = pageUrl.searchParams.get("resume") || "";
const resumePlatform = pageUrl.searchParams.get("platform") || "";
const resuming = Boolean(resumeToken && resumePlatform);
let resumed = false;

if (resuming) {
  document.querySelector("h1").textContent = `Allow access to ${platformLabel(resumePlatform)}`;
  document.querySelector(".lead").textContent = `Crossposter can’t read this ${platformLabel(resumePlatform)} post or its media until you allow access. Allow it once and your crosspost continues straight away.`;
}

async function resumeCapture() {
  if (resumed) return;
  const stillMissing = await incompletePlatformPermissions(ext.permissions, [resumePlatform]);
  if (stillMissing.length) return;
  resumed = true;
  const response = await ext.runtime.sendMessage({ type: "RESUME_PENDING_CAPTURE", token: resumeToken }).catch(caught => ({ ok: false, error: caught instanceof Error ? caught.message : String(caught) }));
  if (!response?.ok) {
    resumed = false;
    error.textContent = response?.error || `Allow every requested site for ${platformLabel(resumePlatform)} to continue.`;
  }
}

async function render() {
  missingPlatforms = await missingSitePlatforms(ext.permissions, manifest);
  const missing = new Set(missingPlatforms);
  list.replaceChildren(...allPlatformIds(manifest).map(platformId => {
    const item = document.createElement("li");
    item.className = missing.has(platformId) ? "missing" : "granted";
    item.textContent = platformLabel(platformId);
    return item;
  }));
  const done = !missing.size;
  allow.hidden = done;
  later.textContent = done ? "Close" : resuming ? "Cancel crosspost" : "Not now";
  if (done && !resuming) {
    document.querySelector("h1").textContent = "You’re all set";
    hint.textContent = "Right-click any post on a supported site and choose Crosspost.";
  }
  if (resuming) await resumeCapture();
  return missing;
}

allow.onclick = async () => {
  allow.disabled = true;
  allow.textContent = "Waiting for your browser’s prompt…";
  error.textContent = "";
  // Firefox only honours permissions.request() while the click is still being
  // handled, so request the list computed at render time without awaiting first.
  const result = await requestCompletePlatformPermissions(ext.permissions, missingPlatforms);
  allow.disabled = false;
  allow.textContent = "Allow site access";
  if (!result.ok) {
    error.textContent = result.error || `Access was not granted for ${result.missing.map(platformLabel).join(", ")}. Allow every requested site so captures and media don’t fail part-way.`;
  } else {
    await ext.storage.local.remove(SITE_ACCESS_DISMISSED_KEY).catch(() => {});
  }
  await render();
};

later.onclick = async () => {
  if (resuming) {
    await ext.runtime.sendMessage({ type: "CANCEL_PENDING_CAPTURE", token: resumeToken }).catch(() => {});
  } else {
    const missing = await missingSitePlatforms(ext.permissions, manifest);
    if (missing.length) await ext.storage.local.set({ [SITE_ACCESS_DISMISSED_KEY]: true }).catch(() => {});
  }
  const tab = await ext.tabs?.getCurrent?.().catch(() => null);
  if (tab?.id !== undefined) ext.tabs.remove(tab.id).catch(() => window.close());
  else window.close();
};

ext.permissions?.onAdded?.addListener(() => render().catch(() => {}));
ext.permissions?.onRemoved?.addListener(() => render().catch(() => {}));
render().catch(caught => { error.textContent = caught instanceof Error ? caught.message : String(caught); });
