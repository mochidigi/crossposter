import { ext } from "./shared/browser.js";

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
