import { ext } from "./shared/browser.js";
import { missingSitePlatforms, platformLabel, requestCompletePlatformPermissions } from "./shared/platform-permissions.js";

const siteAccess = document.querySelector("#siteAccess");
const allowSiteAccess = document.querySelector("#allowSiteAccess");
let missingSiteAccess = [];
allowSiteAccess.onclick = async () => {
  allowSiteAccess.disabled = true;
  // permissions.request() must be called while the click is still being
  // handled (no await before it); the browser then shows its own consent
  // prompt, so the popup may close before the result comes back.
  const result = await requestCompletePlatformPermissions(ext.permissions, missingSiteAccess);
  allowSiteAccess.disabled = false;
  if (result.ok) { siteAccess.hidden = true; return; }
  const response = await ext.runtime.sendMessage({ type: "OPEN_SITE_ACCESS_PAGE" }).catch(() => null);
  if (response?.ok) window.close();
};
missingSitePlatforms(ext.permissions, ext.runtime.getManifest()).then(missing => {
  missingSiteAccess = missing;
  if (!missing.length) return;
  document.querySelector("#siteAccessText").textContent = `Allow access to ${missing.map(platformLabel).join(", ")} so Crossposter can capture posts and fill each composer.`;
  siteAccess.hidden = false;
}).catch(() => {});

document.querySelector("#showInfo").onclick = async () => {
  const response = await ext.runtime.sendMessage({ type: "OPEN_CROSSPOST_COMPOSER", fresh: true, showOnboarding: true }).catch(() => null);
  if (response?.ok) window.close();
};

document.querySelector("#openSettings").onclick = async () => {
  const response = await ext.runtime.sendMessage({ type: "OPEN_CROSSPOST_COMPOSER", fresh: true, showSettings: true }).catch(() => null);
  if (response?.ok) window.close();
};

document.querySelector("#openComposer").onclick = async () => {
  const response = await ext.runtime.sendMessage({ type: "OPEN_CROSSPOST_COMPOSER", fresh: true }).catch(() => null);
  if (response?.ok) window.close();
};

const response = await ext.runtime.sendMessage({ type: "GET_DETECTED_DRAFTS" }).catch(() => null);
const drafts = response?.drafts || [];
if (drafts.length) {
  const draft = drafts[0];
  document.querySelector("#detected").hidden = false;
  document.querySelector("#detectedTitle").textContent = drafts.length === 1 ? "LinkedIn post detected" : `${drafts.length} posts ready to crosspost`;
  document.querySelector("#detectedText").textContent = draft.text || "Your new media post is ready.";
  document.querySelector("#openDetected").onclick = async () => {
    const opened = await ext.runtime.sendMessage({ type: "OPEN_DETECTED_DRAFT", id: draft.id }).catch(() => null);
    if (opened?.ok) window.close();
  };
}

document.querySelector("#version").textContent = `v${ext.runtime.getManifest().version}`;
