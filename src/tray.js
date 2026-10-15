import { ext } from "./shared/browser.js";
import { populateFileDrag } from "./shared/drag.js";
import { getHandoffMedia } from "./shared/media-store.js";
import { hasReportableHandoffError } from "./shared/feedback.js";
import { feedbackOverlay } from "./shared/feedback-overlay.js";
import { handoffNetworkStatuses, handoffStatusRow, handoffSummary } from "./shared/handoff-status.js";

const status = document.querySelector("#status"), empty = document.querySelector("#empty"), content = document.querySelector("#content");
const textSection = document.querySelector("#textSection"), textCard = document.querySelector("#textCard"), copyButton = document.querySelector("#copyText");
const mediaSection = document.querySelector("#mediaSection"), mediaBox = document.querySelector("#media");
const targets = document.querySelector("#targets");
const mediaHint = document.querySelector("#mediaHint");
const sessionsBox = document.querySelector("#sessions");
const reportActions = document.querySelector("#reportActions");
const closeWarning = document.querySelector("#closeWarning"), emptyNone = document.querySelector("#emptyNone"), emptyIdle = document.querySelector("#emptyIdle");
const openFeedbackOverlay = feedbackOverlay(document.querySelector("#feedbackDialog"));
const panelWindowId = (await ext.windows.getCurrent().catch(() => null))?.id;
let currentText = "", files = [], objectUrls = [];
let renderGeneration = 0, mediaCacheKey = "";
let sessions = [], selectedSessionId = "";
let hadSessions = false;
const mediaCache = new Map();
// The tab in front in this window. Its destination row stays highlighted,
// whether the user got there by clicking the row or by the tab strip.
let activeTabId = Number.isInteger(panelWindowId)
  ? (await ext.tabs.query({ active: true, windowId: panelWindowId }).catch(() => []))[0]?.id ?? null
  : null;

ext.runtime.onMessage.addListener(message => {
  if (message?.type === "CROSSPOST_SESSIONS_UPDATED") renderSessions(message).catch(showRenderError);
});
ext.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (Number.isInteger(panelWindowId) && windowId !== panelWindowId) return;
  activeTabId = tabId;
  markActiveRow();
});

const initial = await ext.runtime.sendMessage({ type: "GET_CROSSPOST_SESSIONS", windowId: panelWindowId }).catch(() => null);
renderSessions(initial).catch(showRenderError);

document.querySelector("#sendFeedback").onclick = () => openFeedback("manual");

// Opens Crossposter's feedback form over the sidebar; nothing is sent from here.
function openFeedback(kind, network = "") {
  openFeedbackOverlay({ kind, network, surface: "tray", sessionId: selectedSessionId })
    .catch(error => showStatus(error instanceof Error ? error.message : "The feedback form could not be opened."));
}

copyButton.onclick = async () => {
  try { await navigator.clipboard.writeText(currentText); }
  catch (error) { showStatus(error instanceof Error ? error.message : "The text could not be copied."); return; }
  copyButton.textContent = "Copied";
  setTimeout(() => { copyButton.textContent = "Copy text"; }, 1400);
};

textCard.addEventListener("dragstart", event => {
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("text/plain", currentText);
});

async function renderSessions(payload = {}) {
  sessions = Array.isArray(payload.sessions) ? payload.sessions.filter(session => !Number.isInteger(panelWindowId) || session.windowId === panelWindowId) : [];
  // Once this window's last crosspost is gone (its tab group closed, or
  // closed here), the sidebar has nothing left to show, so it closes itself.
  // Firefox's sidebarAction.close() needs a user gesture; closing the
  // sidebar's own page does not (2026-10-12). A sidebar opened while no
  // crosspost is running stays open.
  if (hadSessions && !sessions.length) { window.close(); return; }
  hadSessions = sessions.length > 0;
  const activeId = sessions.some(session => session.id === payload.activeSessionId) ? payload.activeSessionId : "";
  if (activeId) selectedSessionId = activeId;
  else if (!sessions.some(session => session.id === selectedSessionId)) selectedSessionId = sessions.at(-1)?.id || "";
  sessionsBox.replaceChildren(...sessions.map(sessionCard));
  // The warning only matters while there is something to close.
  closeWarning.hidden = !sessions.length;
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
    if (!response?.ok) showStatus(response?.error || "This crosspost could not be opened.");
  };
  card.append(select);
  if (session.id === selectedSessionId) {
    const close = document.createElement("button"); close.className = "session-close"; close.type = "button"; close.textContent = "×";
    close.title = `Close Crosspost ${index + 1}`; close.setAttribute("aria-label", `Close Crosspost ${index + 1}`);
    close.onclick = async () => {
      const response = await ext.runtime.sendMessage({ type: "CLOSE_CROSSPOST_SESSION", sessionId: session.id }).catch(() => null);
      if (!response?.ok) showStatus(response?.error || "This crosspost could not be closed.");
    };
    card.append(close);
  }
  return card;
}

async function render(handoff) {
  const generation = ++renderGeneration;
  if (!handoff || handoff.state === "idle") {
    releaseUrls(); targets.hidden = true; targets.replaceChildren();
    renderReportActions(null);
    empty.hidden = false; content.hidden = true;
    emptyNone.hidden = sessions.length > 0; emptyIdle.hidden = !sessions.length;
    status.hidden = true; status.classList.remove("error"); return;
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
  const statuses = handoffNetworkStatuses(handoff, { copyFrom: "from below" });
  targets.hidden = !statuses.length;
  targets.replaceChildren(...statuses.map(item => {
    const element = handoffStatusRow(item, {
      openTab: row => activateComposerTab(row.tabId, row.label),
      closeTab: row => closeComposerTab(row.tabId, row.label),
      retry: row => retryDestination(row),
      report: row => openFeedback("error", row.network)
    });
    if (Number.isInteger(item.tabId)) element.dataset.tabId = String(item.tabId);
    return element;
  }));
  markActiveRow();
  mediaHint.textContent = statuses.length === 1
    ? `Drag a file into ${statuses[0].label}’s upload area.`
    : "Drag a file into each composer’s upload area.";
  textSection.hidden = !currentText; textCard.textContent = currentText;
  mediaSection.hidden = !files.length; mediaBox.replaceChildren();
  files.forEach(file => mediaBox.appendChild(mediaCard(file, [file])));
  if (files.length > 1) mediaBox.appendChild(mediaCard(null, files));
  status.hidden = false;
  status.textContent = statusText(handoff, statuses);
  status.classList.toggle("error", handoffNeedsAttention(handoff));
  renderReportActions(handoff);
}

// Destination failures carry their own Report button on their row; this
// covers a crosspost-level failure (the handoff itself, or its media).
// Signed-out destinations and other things the user fixes on the site get
// no prompt (see isReportableFailure).
function renderReportActions(handoff) {
  const buttons = hasReportableHandoffError(handoff) ? [reportButton("Report this problem", "")] : [];
  reportActions.replaceChildren(...buttons);
  reportActions.hidden = !buttons.length;
}

function reportButton(text, network) {
  const button = document.createElement("button");
  button.className = "report-button"; button.type = "button"; button.textContent = text;
  button.title = "Opens Crossposter’s feedback form with details for fixing this. Nothing is sent until you press Send there.";
  button.onclick = () => openFeedback("error", network);
  return button;
}

// A message in the status line, which is hidden while nothing is open.
function showStatus(text) {
  status.hidden = false;
  status.textContent = text;
}

function showRenderError(error) {
  showStatus(error instanceof Error ? error.message : "The handoff media could not be loaded.");
}

// Fills one destination again. The rows follow the session updates while it
// runs, so only a failure to start needs saying here.
function retryDestination(row) {
  const failed = message => showStatus(message || `${row.label} could not be retried.`);
  ext.runtime.sendMessage({ type: "RETRY_NATIVE_HANDOFF", sessionId: selectedSessionId, network: row.network })
    .then(response => { if (!response?.ok) failed(response?.error); })
    .catch(() => failed());
}

// The background marks the row closed when the tab goes, as it does for a
// tab closed from the tab strip.
async function closeComposerTab(tabId, label) {
  try { await ext.tabs.remove(tabId); }
  catch { showStatus(`${label}’s composer tab is no longer open.`); }
}

// Highlights the destination row whose tab is in front. Switching to a tab of
// another crosspost re-renders the rows for it; any other tab clears it.
function markActiveRow() {
  for (const row of targets.children) {
    const current = Number.isInteger(activeTabId) && row.dataset.tabId === String(activeTabId);
    row.classList.toggle("current", current);
    if (current) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  }
}

async function activateComposerTab(tabId, label) {
  try {
    const tab = await ext.tabs.update(tabId, { active: true });
    if (Number.isInteger(tab.windowId)) await ext.windows.update(tab.windowId, { focused: true });
  } catch {
    showStatus(`${label}’s composer tab is no longer open.`);
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

// The crosspost as a whole; each destination's state is on its own row.
function statusText(handoff, statuses) {
  if (handoff.state === "preparing") return "Preparing the draggable files…";
  if (handoff.state === "error") return handoff.error || "Open the destination manually and use this sidebar.";
  const summary = handoffSummary(handoff, statuses).title;
  return handoff.mediaErrors?.length ? `${summary}. Media could not be prepared: ${handoff.mediaErrors.join(" ")}` : summary;
}

function handoffFailures(handoff) {
  return (handoff.results || []).filter(item => item.error || item.result?.error);
}

function handoffNeedsAttention(handoff) {
  if (handoff.retrying) return false;
  if (handoff.state === "error" || handoff.mediaErrors?.length) return true;
  return !["preparing", "filling"].includes(handoff.state) && handoffFailures(handoff).length > 0;
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
    button.disabled = true;
    const blob = file.type === "image/png" ? file : await imageAsPng(file);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    button.textContent = "Copied";
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "The image could not be copied.");
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
  const bytes = match[2] ? Uint8Array.fromBase64(match[3]) : new TextEncoder().encode(decodeURIComponent(match[3]));
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
// pagehide, not unload: Chrome is phasing out unload handlers, and pagehide
// fires first in every case unload did.
window.addEventListener("pagehide", reportTrayClosed);
