import { ext } from "./shared/browser.js";
import { nativeDestination } from "./shared/destinations.js";
import { populateFileDrag } from "./shared/drag.js";
import { getHandoffMedia } from "./shared/media-store.js";

const status = document.querySelector("#status"), empty = document.querySelector("#empty"), content = document.querySelector("#content");
const textSection = document.querySelector("#textSection"), textCard = document.querySelector("#textCard"), copyButton = document.querySelector("#copyText");
const mediaSection = document.querySelector("#mediaSection"), mediaBox = document.querySelector("#media");
const targets = document.querySelector("#targets");
const mediaHint = document.querySelector("#mediaHint");
const sessionsBox = document.querySelector("#sessions");
const panelWindowId = (await ext.windows.getCurrent().catch(() => null))?.id;
let currentText = "", files = [], objectUrls = [];
let renderGeneration = 0, mediaCacheKey = "";
let sessions = [], selectedSessionId = "";
const mediaCache = new Map();

ext.runtime.onMessage.addListener(message => {
  if (message?.type === "CROSSPOST_SESSIONS_UPDATED") renderSessions(message).catch(showRenderError);
});

const initial = await ext.runtime.sendMessage({ type: "GET_CROSSPOST_SESSIONS", windowId: panelWindowId }).catch(() => null);
renderSessions(initial).catch(showRenderError);

copyButton.onclick = async () => {
  await copyText(currentText);
  copyButton.textContent = "Copied";
  setTimeout(() => { copyButton.textContent = "Copy text"; }, 1400);
};

async function copyText(value) {
  try { await navigator.clipboard.writeText(value); return; } catch {}
  const input = document.createElement("textarea");
  input.value = value; input.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(input); input.select(); document.execCommand("copy"); input.remove();
}

textCard.addEventListener("dragstart", event => {
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("text/plain", currentText);
});

async function renderSessions(payload = {}) {
  sessions = Array.isArray(payload.sessions) ? payload.sessions.filter(session => !Number.isInteger(panelWindowId) || session.windowId === panelWindowId) : [];
  const activeId = sessions.some(session => session.id === payload.activeSessionId) ? payload.activeSessionId : "";
  if (activeId) selectedSessionId = activeId;
  else if (!sessions.some(session => session.id === selectedSessionId)) selectedSessionId = sessions.at(-1)?.id || "";
  sessionsBox.replaceChildren(...sessions.map(sessionCard));
  const selected = sessions.find(session => session.id === selectedSessionId);
  await render(selected?.handoff);
}

function sessionCard(session, index) {
  const card = document.createElement("article");
  card.className = `session${session.id === selectedSessionId ? " active" : ""}`;
  const select = document.createElement("button"); select.className = "session-select"; select.type = "button";
  const expected = session.handoff?.networks?.length || 0, posted = session.handoff?.postedNetworks?.length || 0;
  const title = document.createElement("strong"); title.textContent = `${expected && posted === expected ? "✓ " : ""}Crosspost ${index + 1}`;
  const preview = document.createElement("span"); preview.textContent = session.preview || "New crosspost";
  select.append(title, preview);
  select.title = "Switch to this crosspost tab group";
  select.onclick = async () => {
    selectedSessionId = session.id;
    await renderSessions({ sessions, activeSessionId: session.id });
    const response = await ext.runtime.sendMessage({ type: "ACTIVATE_CROSSPOST_SESSION", sessionId: session.id }).catch(() => null);
    if (!response?.ok) status.textContent = response?.error || "This crosspost could not be opened.";
  };
  card.append(select);
  if (session.id === selectedSessionId) {
    const close = document.createElement("button"); close.className = "session-close"; close.type = "button"; close.textContent = "×";
    close.title = `Close Crosspost ${index + 1}`; close.setAttribute("aria-label", `Close Crosspost ${index + 1}`);
    close.onclick = async () => {
      const response = await ext.runtime.sendMessage({ type: "CLOSE_CROSSPOST_SESSION", sessionId: session.id }).catch(() => null);
      if (!response?.ok) status.textContent = response?.error || "This crosspost could not be closed.";
    };
    card.append(close);
  }
  return card;
}

async function render(handoff) {
  const generation = ++renderGeneration;
  if (!handoff || handoff.state === "idle") {
    releaseUrls(); targets.hidden = true; targets.replaceChildren();
    empty.hidden = false; content.hidden = true;
    status.textContent = sessions.length ? "This crosspost is ready in Compose." : "No crossposts are open."; return;
  }
  releaseUrls();
  currentText = handoff.text || "";
  const cacheKey = (handoff.media || []).map(item => item.mediaId || item.dataUrl?.slice(0, 64) || "").join("|");
  if (cacheKey !== mediaCacheKey) { mediaCache.clear(); mediaCacheKey = cacheKey; }
  const loadedFiles = [];
  for (const item of handoff.media || []) loadedFiles.push(await fileForMedia(item));
  if (generation !== renderGeneration) return;
  files = loadedFiles;
  empty.hidden = true; content.hidden = false;
  const destinationLabels = (handoff.networks || []).map(nativeDestination).filter(Boolean);
  targets.hidden = !destinationLabels.length;
  const resultsByNetwork = new Map((handoff.results || []).map(result => [result.network, result]));
  const postedNetworks = new Set(handoff.postedNetworks || []);
  targets.replaceChildren(...destinationLabels.map(destination => targetButton(destination, resultsByNetwork.get(destination.id), postedNetworks.has(destination.id))));
  const targetNames = destinationLabels.map(destination => destination.label).join(" or ");
  mediaHint.textContent = `Drag a file directly into ${targetNames || "the destination"}’s upload area.`;
  textSection.hidden = !currentText; textCard.textContent = currentText;
  mediaSection.hidden = !files.length; mediaBox.replaceChildren();
  files.forEach(file => mediaBox.appendChild(mediaCard(file, [file])));
  if (files.length > 1) mediaBox.appendChild(mediaCard(null, files));
  status.textContent = statusText(handoff);
}

function showRenderError(error) {
  status.textContent = error instanceof Error ? error.message : "The handoff media could not be loaded.";
}

function targetButton(destination, handoffResult, posted = false) {
  const button = document.createElement("button");
  button.className = `target${posted ? " posted" : ""}`; button.type = "button";
  const image = document.createElement("img"); image.src = destination.icon; image.alt = "";
  button.append(image, destination.label, ...(posted ? [" ✓"] : []));
  const tabId = handoffResult?.tabId;
  button.disabled = !Number.isInteger(tabId);
  button.title = button.disabled ? `${destination.label} is still opening` : `Switch to ${destination.label}`;
  if (!button.disabled) button.onclick = () => activateComposerTab(tabId, destination.label);
  return button;
}

async function activateComposerTab(tabId, label) {
  try {
    const tab = await ext.tabs.update(tabId, { active: true });
    if (Number.isInteger(tab.windowId)) await ext.windows.update(tab.windowId, { focused: true });
  } catch {
    status.textContent = `${label}’s composer tab is no longer open.`;
  }
}

async function fileForMedia(item) {
  if (item.dataUrl) return dataUrlToFile(item);
  if (!item.mediaId) throw new Error("A handoff media item is missing its storage reference.");
  if (!mediaCache.has(item.mediaId)) {
    mediaCache.set(item.mediaId, getHandoffMedia(item.mediaId).then(record => {
      if (!record?.blob) throw new Error("This handoff media is no longer available.");
      return new File([record.blob], item.name || record.name || "crossposter-media", {
        type: item.type || record.type || record.blob.type,
        lastModified: item.lastModified || record.lastModified || Date.now()
      });
    }));
  }
  return mediaCache.get(item.mediaId);
}

function statusText(handoff) {
  if (handoff.state === "preparing") return "Preparing the draggable files…";
  if (handoff.state === "filling") return `Opening and filling ${nativeDestination(handoff.currentNetwork)?.label || "the native composer"}…`;
  if (handoff.state === "error") return handoff.error || "Open the destination manually and use this tray.";
  if (handoff.mediaErrors?.length) return `Media could not be prepared: ${handoff.mediaErrors.join(" ")}`;
  const posted = handoff.postedNetworks || [];
  if (posted.length && posted.length === (handoff.networks || []).length) return "Posted to every destination in this crosspost.";
  if (posted.length) return `Posted to ${posted.length} of ${(handoff.networks || []).length} destinations.`;
  const results = handoff.results || [], filled = results.filter(item => item.result?.textInserted || item.result?.mediaInserted).length;
  if (filled === results.length && filled) return `${filled} composer${filled === 1 ? "" : "s"} filled. Review and post when ready.`;
  if (filled) return `${filled} composer${filled === 1 ? "" : "s"} filled. Use this sidebar for the remaining destinations.`;
  const labels = (handoff.networks || []).map(nativeDestination).filter(Boolean).map(destination => destination.label).join(" or ");
  return labels ? `Drag or copy this content into ${labels}’s composer.` : "Drag or copy this content into the destination composer.";
}

function mediaCard(file, dragFiles) {
  const card = document.createElement("div"); card.className = "drag-card media-card"; card.draggable = true;
  const preview = document.createElement(file?.type.startsWith("image/") ? "img" : "span");
  if (preview.tagName === "IMG") { const url = URL.createObjectURL(file); objectUrls.push(url); preview.src = url; preview.alt = ""; }
  else { preview.className = "media-type"; preview.textContent = file?.type.startsWith("video/") ? "VIDEO" : "FILES"; }
  const copy = document.createElement("div"); copy.className = "media-copy";
  const name = document.createElement("div"); name.className = "media-name"; name.textContent = file?.name || `${dragFiles.length} files`;
  const hint = document.createElement("div"); hint.className = "media-hint"; hint.textContent = "Drag to upload";
  copy.append(name, hint); card.append(preview, copy);
  if (file?.type.startsWith("image/")) {
    const copyImage = document.createElement("button");
    copyImage.className = "media-copy-button"; copyImage.type = "button"; copyImage.textContent = "Copy image";
    copyImage.draggable = false;
    copyImage.onclick = event => { event.stopPropagation(); copyImageToClipboard(file, copyImage); };
    card.append(copyImage);
  }
  card.addEventListener("dragstart", event => {
    populateFileDrag(event.dataTransfer, dragFiles);
    if (preview.tagName === "IMG") {
      try { event.dataTransfer.setDragImage(preview, preview.clientWidth / 2, preview.clientHeight / 2); } catch {}
    }
  });
  return card;
}

async function copyImageToClipboard(file, button) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Image copying is not supported in this browser.");
    button.disabled = true;
    const blob = file.type === "image/png" ? file : await imageAsPng(file);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    button.textContent = "Copied";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "The image could not be copied.";
  } finally {
    setTimeout(() => {
      if (!button.isConnected) return;
      button.disabled = false; button.textContent = "Copy image";
    }, 1400);
  }
}

async function imageAsPng(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The image could not be converted for copying.")), "image/png"));
  } finally { bitmap.close?.(); }
}

function dataUrlToFile(item) {
  const match = String(item.dataUrl || "").match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!match) throw new Error("A media item could not be transferred.");
  const type = item.type || match[1] || "application/octet-stream";
  const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], item.name || "crossposter-media", { type, lastModified: item.lastModified || Date.now() });
}

function releaseUrls() { objectUrls.forEach(URL.revokeObjectURL); objectUrls = []; }
let closeReported = false;
function reportTrayClosed() {
  releaseUrls();
  if (closeReported) return;
  closeReported = true;
  try { ext.runtime.sendMessage({ type: "NATIVE_TRAY_CLOSED", windowId: panelWindowId }).catch(() => {}); } catch {}
}
window.addEventListener("pagehide", reportTrayClosed);
window.addEventListener("unload", reportTrayClosed);
