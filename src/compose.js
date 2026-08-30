import { ext } from "./shared/browser.js";
import { createDraft, validateDraft } from "./shared/draft.js";
import { canCommitClip, MIN_CLIP_SECONDS, normalizeTrimRange, trimVideo, videoCropFromNormalized } from "./shared/video-editor.js";
import { canvasBlob } from "./shared/image-editor.js";
import { icon } from "./shared/icons.js";
import { handoffFilename } from "./shared/handoff.js";
import { muxMp4Tracks } from "./shared/hls.js";
import { isStreamMedia, prepareStreamMedia } from "./shared/media-preparation.js";
import { deleteHandoffMedia, getHandoffMedia, storeHandoffMedia } from "./shared/media-store.js";
import { DRAFT_HISTORY_KEY, draftHistoryEntry, removeDraftHistoryEntry, upsertDraftHistory } from "./shared/draft-history.js";
import { continueLabel, isNativeDestinationDisabled, NATIVE_DESTINATIONS, selectedNativeDestinations } from "./shared/destinations.js";
import { DEFAULT_DESTINATIONS_KEY, ENABLED_PLATFORMS_KEY, initialDraftDestinations, inlineActionsEnabled, normalizeDefaultDestinations, normalizeEnabledPlatforms, SHOW_INLINE_ACTIONS_KEY } from "./shared/preferences.js";
import { isFreshComposerUrl } from "./shared/compose-mode.js";
import { CROSSPOST_SESSIONS_KEY, crosspostSessionIdFromUrl } from "./shared/crosspost-sessions.js";
import { settleVideoResolution } from "./shared/video-resolution-state.js";

const showInfo = document.querySelector("#showInfo");
// Onboarding markup is only needed when the info button is used; import it on
// demand (setupOnboarding rewires the click handler for subsequent opens).
showInfo.onclick = async () => {
  const { setupOnboarding } = await import("./shared/onboarding.js");
  setupOnboarding(showInfo);
  showInfo.onclick();
};
const composeUrl = new URL(location.href);
const sessionId = crosspostSessionIdFromUrl(location.href);
// A fresh compose has no captured text to wait for — show the real placeholder
// immediately instead of the "Loading…" hint (knowable synchronously from the URL).
if (isFreshComposerUrl(location.href)) document.querySelector("#postText").placeholder = "What do you want to share?";
let draft = null;
let composerReady = false;
let queuedVideoResolution = null;
ext.runtime.onMessage.addListener(message => {
  if (message?.type !== "CAPTURED_VIDEO_RESOLVED" || message.sessionId !== sessionId) return;
  if (!composerReady) { queuedVideoResolution = message; return; }
  applyCapturedVideoResolution(message);
});
if (composeUrl.searchParams.get("onboarding") === "1") {
  composeUrl.searchParams.delete("onboarding");
  history.replaceState(null, "", composeUrl.href);
  showInfo.click();
}

const moduleStartAt = performance.now();
// Read the session snapshot straight from storage.session: the background
// persists it before creating this tab, and a direct read avoids waking the
// background event page (a visible cost on Firefox). Messaging stays as the
// fallback for snapshots that have not landed yet.
const [stored, directSessions] = await Promise.all([
  ext.storage.local.get(["pendingDraft", DEFAULT_DESTINATIONS_KEY, ENABLED_PLATFORMS_KEY, SHOW_INLINE_ACTIONS_KEY]),
  sessionId && ext.storage.session?.get ? ext.storage.session.get(CROSSPOST_SESSIONS_KEY).catch(() => null) : null
]);
let crosspostSession = directSessions?.[CROSSPOST_SESSIONS_KEY]?.find(candidate => candidate?.id === sessionId) || null;
if (sessionId && !crosspostSession) {
  const sessionResponse = await ext.runtime.sendMessage({ type: "GET_CROSSPOST_SESSION", sessionId }).catch(() => null);
  crosspostSession = sessionResponse?.session || null;
}
const dataLoadedAt = performance.now();
const freshCompose = crosspostSession?.fresh === true || isFreshComposerUrl(location.href);
const objectUrls = [];
const streamPreparationTasks = new WeakMap();
let streamPreparationQueue = Promise.resolve();
draft = createDraft(crosspostSession?.draft || (freshCompose ? {} : stored.pendingDraft || {}));
ext.runtime.sendMessage({ type: "REGISTER_NATIVE_TRAY_TAB", sessionId }).catch(() => {});
let defaultDestinations = normalizeDefaultDestinations(stored[DEFAULT_DESTINATIONS_KEY]);
let enabledPlatforms = normalizeEnabledPlatforms(stored[ENABLED_PLATFORMS_KEY]);
let showInlineActions = inlineActionsEnabled(stored[SHOW_INLINE_ACTIONS_KEY]);
const text = document.querySelector("#postText"), destinations = document.querySelector("#destinations");
const settingsDialog = document.querySelector("#settingsDialog"), settingsDestinations = document.querySelector("#settingsDestinations");
const settingsInlineActions = document.querySelector("#settingsInlineActions"), settingsError = document.querySelector("#settingsError");
const settingsClearData = document.querySelector("#settingsClearData"), settingsClearError = document.querySelector("#settingsClearError");
const historyDialog = document.querySelector("#historyDialog"), historyList = document.querySelector("#historyList");
const clipDialog = document.querySelector("#clipDialog"), clipPreview = document.querySelector("#clipPreview");
const clipStart = document.querySelector("#clipStart"), clipEnd = document.querySelector("#clipEnd");
const clipStartLabel = document.querySelector("#clipStartLabel"), clipEndLabel = document.querySelector("#clipEndLabel");
const clipRangeTrack = document.querySelector("#clipRangeTrack");
const clipSelection = document.querySelector("#clipSelection"), clipProgress = document.querySelector("#clipProgress");
const clipError = document.querySelector("#clipError"), clipApply = document.querySelector("#clipApply");
const clipCrop = document.querySelector("#clipCrop"), clipStage = document.querySelector("#clipStage");
const clipCropOverlay = document.querySelector("#clipCropOverlay"), clipCropBox = document.querySelector("#clipCropBox"), clipCropHelp = document.querySelector("#clipCropHelp");
const imageDialog = document.querySelector("#imageDialog"), imageCanvas = document.querySelector("#imageCanvas");
const imageCropControls = document.querySelector("#imageCropControls"), imageColor = document.querySelector("#imageColor"), imageError = document.querySelector("#imageError");
const composeMain = document.querySelector("main"), composeTopbar = document.querySelector(".topbar");
const handoffOverlay = document.querySelector("#handoffOverlay"), handoffCancel = document.querySelector("#handoffCancel"), handoffCancelError = document.querySelector("#handoffCancelError");
let clipState = null;
let clipCropGesture = null;
let imageState = null;
let clipOperationActive = false;
let publishBusy = false;
let publishGeneration = 0;
let activeHandoffAttemptId = crosspostSession?.handoff?.attemptId || "";
draft.destinations = initialDraftDestinations(draft, stored[DEFAULT_DESTINATIONS_KEY], enabledPlatforms);
// First paint: text and destinations immediately; media hydration reads blobs
// from IndexedDB and stays off the critical path.
text.value = draft.text; text.placeholder = "What do you want to share?";
renderMeta(); renderDestinations();
console.debug(`[crossposter] first paint ${Math.round(performance.now())}ms since navigation (module start ${Math.round(moduleStartAt)}ms, data loaded ${Math.round(dataLoadedAt)}ms)`);
draft.media = await hydrateStoredMedia(draft.media);
renderAll();
composerReady = true;
if (queuedVideoResolution) {
  applyCapturedVideoResolution(queuedVideoResolution);
  queuedVideoResolution = null;
} else {
  prepareStreamPreviews().catch(() => {});
  reconcileCapturedVideoResolution().catch(() => {});
}
const addLink = document.querySelector("#addLink");
renderComposerMode();
if (addLink) addLink.onclick = () => { if (draft.sourceUrl && !text.value.includes(draft.sourceUrl)) { text.value = `${text.value.trim()}\n\n${draft.sourceUrl}`.trim(); text.dispatchEvent(new Event("input")); } };

text.addEventListener("input", () => { draft.text = text.value; renderMeta(); });
document.querySelector("#settingsOpen").onclick = openSettings;
document.querySelector("#settingsVersion").textContent = `v${ext.runtime.getManifest().version}`;
document.querySelector("#settingsClose").onclick = closeSettings;
document.querySelector("#settingsCancel").onclick = closeSettings;
document.querySelector("#settingsSave").onclick = saveSettings;
settingsClearData.onclick = clearAllData;
settingsDialog.addEventListener("cancel", event => { event.preventDefault(); closeSettings(); });
document.querySelector("#historyOpen").onclick = openHistory;
document.querySelector("#historyClose").onclick = closeHistory;
document.querySelector("#historyDone").onclick = closeHistory;
historyDialog.addEventListener("cancel", event => { event.preventDefault(); closeHistory(); });
document.querySelector("#file").onchange = event => {
  for (const file of [...event.target.files].slice(0, 4 - draft.media.length)) {
    const url = URL.createObjectURL(file); objectUrls.push(url); draft.media.push({ kind: file.type.startsWith("video") ? "video" : "image", url, local: true, filename: file.name });
  }
  event.target.value = "";
  renderMedia();
};
document.querySelector("#clipClose").onclick = closeClipper;
document.querySelector("#clipCancel").onclick = closeClipper;
document.querySelector("#clipPlay").onclick = playClipSelection;
document.querySelector("#clipMarkStart").onclick = () => markClipBoundary("start");
document.querySelector("#clipMarkEnd").onclick = () => markClipBoundary("end");
clipStart.oninput = () => updateClipRange("start", true);
clipEnd.oninput = () => updateClipRange("end", true);
clipApply.onclick = applyClip;
clipCrop.onchange = updateClipCropSelection;
clipPreview.onloadedmetadata = initializeClipRange;
clipPreview.ontimeupdate = () => {
  if (clipState?.playing && clipPreview.currentTime >= Number(clipEnd.value)) {
    clipPreview.pause(); clipPreview.currentTime = Number(clipStart.value); clipState.playing = false;
  }
};
clipPreview.onerror = () => { if (clipState) clipError.textContent = "The video preview could not be loaded."; };
clipCropBox.onpointerdown = beginClipCropGesture;
clipCropBox.onpointermove = moveClipCropGesture;
clipCropBox.onpointerup = endClipCropGesture;
clipCropBox.onpointercancel = endClipCropGesture;
clipCropBox.onkeydown = nudgeClipCrop;
window.addEventListener("resize", renderClipCrop);
clipDialog.addEventListener("cancel", event => { event.preventDefault(); closeClipper(); });
document.querySelector("#imageClose").onclick = closeImageEditor;
document.querySelector("#imageCancel").onclick = closeImageEditor;
document.querySelector("#imageApply").onclick = applyImageEdit;
document.querySelector("#imageUndo").onclick = () => imageState?.editor.undo();
document.querySelector("#imageRedo").onclick = () => imageState?.editor.redo();
document.querySelector("#imageRotate").onclick = () => imageState?.editor.rotate();
document.querySelector("#imageCropCancel").onclick = cancelImageCrop;
document.querySelector("#imageCropApply").onclick = () => {
  imageState?.editor.applyCrop();
};
document.querySelectorAll("[data-image-crop]").forEach(button => button.onclick = () => beginImageCrop(button.dataset.imageCrop));
imageColor.oninput = () => imageState?.editor.setColor(imageColor.value);
document.querySelectorAll("[data-image-tool]").forEach(button => button.onclick = () => {
  if (!imageState) return;
  button.dataset.imageTool === "crop" ? beginImageCrop("free") : imageState.editor.setTool(button.dataset.imageTool);
});
imageDialog.addEventListener("cancel", event => {
  event.preventDefault();
  imageState?.editor.tool === "crop" ? cancelImageCrop() : closeImageEditor();
});
document.addEventListener("keydown", event => {
  if (!imageDialog.open || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
  event.preventDefault(); event.shiftKey ? imageState?.editor.redo() : imageState?.editor.undo();
});
document.querySelector("#publish").onclick = publish;
handoffCancel.onclick = cancelNativeHandoff;
setHandoffActive(Boolean(crosspostSession && crosspostSession.handoff?.state !== "idle"));

function applyCapturedVideoResolution(message) {
  const media = settleVideoResolution(draft.media, message.resolutionId, message.resolvedItem, message.error || "");
  if (media === draft.media) return;
  draft.media = media;
  renderMedia();
  renderPublishAction();
  if (!message.error) prepareStreamPreviews().catch(() => {});
}

async function reconcileCapturedVideoResolution() {
  if (!sessionId || !draft.media.some(item => item?.resolving)) return;
  const response = await ext.runtime.sendMessage({ type: "GET_CROSSPOST_SESSION", sessionId });
  const sessionMedia = response?.session?.draft?.media;
  if (!Array.isArray(sessionMedia) || sessionMedia.some(item => item?.resolving)) return;
  draft.media = sessionMedia;
  renderMedia();
  renderPublishAction();
  prepareStreamPreviews().catch(() => {});
}

function renderAll() { renderMeta(); renderDestinations(); renderMedia(); }
function showToast(message) { const toast = document.querySelector("#toast"); toast.textContent = message; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 4000); }
function renderMeta() {
  document.querySelector("#count").textContent = `${draft.text.length} / 3000`;
  const label = draft.sourceNetwork === "web" ? "Captured from the web" : `Captured from ${draft.sourceNetwork}`;
  document.querySelector("#source").textContent = draft.sourceUrl ? label : "Fresh post";
}
function renderDestinations() {
  const enabled = new Set(enabledPlatforms);
  destinations.innerHTML = NATIVE_DESTINATIONS.filter(destination => enabled.has(destination.id)).map(destination => {
    const disabled = isNativeDestinationDisabled(draft, destination.id);
    const selected = !disabled && draft.destinations.includes(destination.id);
    return `<label class="destination ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}" data-id="${destination.id}"><span class="network-icon"><img src="${destination.icon}" alt=""></span><b>${escapeAttr(destination.label)}</b><input type="checkbox" ${selected ? "checked" : ""} ${disabled ? "disabled" : ""}></label>`;
  }).join("");
  destinations.querySelectorAll("input").forEach(input => input.onchange = event => { const id = event.target.closest("label").dataset.id; draft.destinations = event.target.checked ? [...new Set([...draft.destinations, id])] : draft.destinations.filter(item => item !== id); renderDestinations(); });
  renderPublishAction();
}

function openSettings() {
  settingsDestinations.innerHTML = NATIVE_DESTINATIONS.map(destination => {
    const enabled = enabledPlatforms.includes(destination.id);
    const checked = defaultDestinations.includes(destination.id);
    return `<div class="platform-preference ${enabled ? "" : "platform-disabled"}" data-platform="${destination.id}"><span class="platform-preference-name"><span class="network-icon"><img src="${destination.icon}" alt=""></span><b>${escapeAttr(destination.label)}</b></span><label class="preference-check"><span class="sr-only">Enable ${escapeAttr(destination.label)}</span><input data-platform-enabled type="checkbox" ${enabled ? "checked" : ""}></label><label class="preference-check"><span class="sr-only">Select ${escapeAttr(destination.label)} by default</span><input data-platform-default type="checkbox" ${checked ? "checked" : ""} ${enabled ? "" : "disabled"}></label></div>`;
  }).join("");
  settingsDestinations.querySelectorAll("[data-platform-enabled]").forEach(input => input.onchange = () => updatePlatformPreferenceRow(input.closest("[data-platform]")));
  settingsInlineActions.checked = showInlineActions;
  settingsError.textContent = "";
  settingsClearError.textContent = "";
  settingsDialog.showModal();
}

function updatePlatformPreferenceRow(row) {
  const enabled = row.querySelector("[data-platform-enabled]").checked;
  row.classList.toggle("platform-disabled", !enabled);
  row.querySelector("[data-platform-default]").disabled = !enabled;
}

function closeSettings() { if (settingsDialog.open) settingsDialog.close(); }

function renderComposerMode() {
  const captured = Boolean(draft.sourceUrl);
  document.querySelector("#composerTitle").textContent = captured ? "Share it your way." : "Compose";
  document.querySelector("#composerLede").textContent = captured
    ? "Polish the original, choose your destinations, then continue in each native composer."
    : "Write what you want to share, choose your destinations, then continue in each native composer";
  if (addLink) addLink.hidden = !captured;
}

async function openHistory() {
  await renderHistory();
  historyDialog.showModal();
}

function closeHistory() { if (historyDialog.open) historyDialog.close(); }

async function renderHistory() {
  const history = await readDraftHistory();
  if (!history.length) {
    historyList.innerHTML = '<p class="history-empty">No saved handoffs yet. Drafts appear here when you select Continue.</p>';
    return;
  }
  historyList.innerHTML = history.map(entry => {
    const item = entry.draft || {}, preview = item.text?.trim() || (item.media?.length ? "Media post" : "Untitled draft");
    const destinations = (item.destinations || []).map(label).join(", ") || "No destinations";
    const media = item.media?.length ? ` · ${item.media.length} media` : "";
    return `<article class="history-item" data-history-id="${escapeAttr(entry.id)}"><div class="history-copy"><time>${escapeAttr(formatHistoryTime(entry.savedAt))}</time><strong>${escapeAttr(preview.slice(0, 120))}</strong><span>${escapeAttr(destinations)}${media}</span></div><div class="history-actions"><button class="secondary" data-history-restore type="button">Restore</button><button class="icon-button" data-history-delete type="button" aria-label="Delete saved draft" title="Delete">${icon("trash")}</button></div></article>`;
  }).join("");
  historyList.querySelectorAll("[data-history-restore]").forEach(button => button.onclick = () => restoreHistory(button.closest("[data-history-id]").dataset.historyId));
  historyList.querySelectorAll("[data-history-delete]").forEach(button => button.onclick = () => deleteHistory(button.closest("[data-history-id]").dataset.historyId));
}

async function restoreHistory(id) {
  const entry = (await readDraftHistory()).find(item => item?.id === id);
  if (!entry?.draft) return;
  objectUrls.splice(0).forEach(url => URL.revokeObjectURL(url));
  draft = createDraft(entry.draft);
  draft.media = await hydrateStoredMedia(entry.draft.media);
  draft.destinations = initialDraftDestinations(draft, stored[DEFAULT_DESTINATIONS_KEY], enabledPlatforms);
  text.value = draft.text;
  renderComposerMode(); renderAll(); closeHistory();
  showToast("Draft restored. Review it before continuing.");
}

async function deleteHistory(id) {
  const history = await readDraftHistory();
  const result = removeDraftHistoryEntry(history, id);
  await ext.storage.local.set({ [DRAFT_HISTORY_KEY]: result.history });
  await deleteHandoffMedia(result.removedMediaIds).catch(() => {});
  await renderHistory();
}

async function saveSettings() {
  const rows = [...settingsDestinations.querySelectorAll("[data-platform]")];
  const nextEnabled = normalizeEnabledPlatforms(rows.filter(row => row.querySelector("[data-platform-enabled]").checked).map(row => row.dataset.platform));
  const nextDefaults = normalizeDefaultDestinations(rows.filter(row => row.querySelector("[data-platform-default]").checked).map(row => row.dataset.platform));
  const nextInlineActions = settingsInlineActions.checked;
  settingsError.textContent = "";
  const response = await ext.runtime.sendMessage({
    type: "APPLY_PLATFORM_PREFERENCES",
    enabledPlatforms: nextEnabled,
    defaultDestinations: nextDefaults,
    showInlineActions: nextInlineActions
  }).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if (!response?.ok) {
    settingsError.textContent = response?.error || "Platform settings could not be saved.";
    return;
  }
  enabledPlatforms = response.enabledPlatforms;
  defaultDestinations = response.defaultDestinations;
  showInlineActions = response.showInlineActions;
  stored[ENABLED_PLATFORMS_KEY] = enabledPlatforms;
  stored[DEFAULT_DESTINATIONS_KEY] = defaultDestinations;
  stored[SHOW_INLINE_ACTIONS_KEY] = showInlineActions;
  draft.destinations = initialDraftDestinations(draft, defaultDestinations, enabledPlatforms);
  renderDestinations();
  closeSettings(); showToast("Platform settings saved.");
}

async function clearAllData() {
  if (!confirm("Clear all Crossposter data? This deletes saved drafts, history, preferences, reminders, temporary media, and other open Crossposter sessions.")) return;
  settingsClearData.disabled = true;
  settingsClearData.textContent = "Clearing…";
  settingsClearError.textContent = "";
  const response = await ext.runtime.sendMessage({ type: "CLEAR_ALL_CROSSPOSTER_DATA", sessionId }).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if (!response?.ok) {
    settingsClearData.disabled = false;
    settingsClearData.textContent = "Clear all Crossposter data";
    settingsClearError.textContent = response?.error || "Crossposter data could not be cleared.";
    return;
  }
  location.reload();
}

function renderPublishAction() {
  if (publishBusy) return;
  const button = document.querySelector("#publish"), selected = selectedNativeDestinations(draft), action = continueLabel(selected);
  const mediaBlocked = draft.media.some(item => item?.resolving || item?.resolveError);
  button.disabled = !selected.length || mediaBlocked;
  button.innerHTML = `${action}${icon("arrow-right")}`;
}
function renderMedia() {
  document.querySelector("#media").innerHTML = draft.media.map((item, index) => {
    const video = item.kind === "video";
    const busyMedia = item.resolving || item.preparing;
    const edits = [item.resolveError || "", item.prepareError || "", item.trim ? `Clipped to ${formatTime(item.trim.duration)}` : "", item.crop ? `Cropped ${item.crop}` : "", item.edited ? "Edited image" : ""].filter(Boolean);
    const note = edits.length ? `<figcaption>${escapeAttr(edits.join(" · "))}</figcaption>` : "";
    const poster = video && item.poster ? ` poster="${escapeAttr(item.poster)}"` : "";
    const source = video && (isStreamMedia(item) || item.resolving || item.resolveError) ? "" : ` src="${escapeAttr(item.url)}"`;
    const disabled = busyMedia || item.resolveError ? " disabled" : "";
    const edit = video
      ? `<button class="media-clip" data-clip="${index}" type="button"${disabled}>${icon("scissors")}Edit</button>`
      : `<button class="media-clip" data-image-edit="${index}" type="button">Edit</button>`;
    const download = video ? `<button class="media-download" data-download="${index}" type="button"${disabled}>${icon("download")}Download</button>` : "";
    const busy = busyMedia ? `<div class="media-busy" role="status" aria-live="polite"><span class="media-spinner" aria-hidden="true"></span><span>${item.resolving ? "Locating video…" : "Preparing video…"}</span></div>` : "";
    return `<figure${busyMedia ? ' class="is-preparing"' : ""}><${video ? "video controls preload=metadata" : "img"}${source}${poster}></${video ? "video" : "img"}>${busy}<button class="media-remove" data-remove="${index}" aria-label="Remove media">${icon("trash")}</button><div class="media-actions">${edit}${download}</div>${note}</figure>`;
  }).join("");
  document.querySelectorAll("[data-remove]").forEach(button => button.onclick = () => {
    const [removed] = draft.media.splice(Number(button.dataset.remove), 1); releaseObjectUrl(removed?.url); renderMedia(); renderPublishAction();
  });
  document.querySelectorAll("[data-clip]").forEach(button => button.onclick = () => openClipper(Number(button.dataset.clip)));
  document.querySelectorAll("[data-download]").forEach(button => button.onclick = () => downloadVideo(Number(button.dataset.download), button));
  document.querySelectorAll("[data-image-edit]").forEach(button => button.onclick = () => openImageEditor(Number(button.dataset.imageEdit)));
}

async function downloadVideo(index, button) {
  let item = draft.media[index];
  try {
    button.disabled = true;
    if (isStreamMedia(item)) {
      await prepareStreamPreview(index, item);
      item = draft.media[index];
    }
    // Resolver modules are only needed for downloads; keep them out of the
    // startup graph (same principle as the lazy Fabric.js import).
    const { mediaDownloadDescriptor } = await import("./shared/downloaders.js");
    const descriptor = mediaDownloadDescriptor(item);
    if (descriptor.container === "hls") {
      await ext.storage.local.set({ pendingDownload: descriptor });
      await ext.tabs.create({ url: ext.runtime.getURL("download.html") });
    } else if (descriptor.container === "dash") {
      const blob = await muxMp4Tracks(descriptor.url, descriptor.audioUrl);
      const url = URL.createObjectURL(blob); objectUrls.push(url);
      await ext.downloads.download({ url, filename: descriptor.filename });
    } else {
      await ext.downloads.download({ url: descriptor.url, filename: descriptor.filename });
    }
    showToast("Video download started.");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "The video could not be downloaded.");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function openClipper(index) {
  if (clipOperationActive) { showToast("The previous clip is still finishing in the background."); return; }
  let item = draft.media[index];
  if (!item || item.kind !== "video") return;
  if (isStreamMedia(item)) {
    showToast("Preparing the video for editing…");
    try {
      await prepareStreamPreview(index, item);
      item = draft.media[index];
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The video could not be prepared for editing.");
      return;
    }
  }
  clipState = { index, total: 0, busy: false, playing: false, cancelled: false, cropRect: null };
  clipError.textContent = ""; clipSelection.textContent = "Loading video…"; clipProgress.hidden = true; clipProgress.value = 0;
  clipStart.disabled = true; clipEnd.disabled = true; clipApply.disabled = true;
  clipCrop.value = ""; resetClipCropSelection();
  clipPreview.src = item.url; clipPreview.load(); clipDialog.showModal();
}

function initializeClipRange() {
  if (!clipState) return;
  const total = Number(clipPreview.duration);
  if (!Number.isFinite(total) || total < MIN_CLIP_SECONDS) {
    clipError.textContent = "This video is too short or its duration is unavailable.";
    return;
  }
  clipState.total = total;
  clipStart.max = String(total); clipEnd.max = String(total);
  clipStart.value = "0"; clipEnd.value = String(total);
  clipStart.disabled = false; clipEnd.disabled = false; clipApply.disabled = false;
  updateClipRange();
}

function updateClipRange(changed = "", seek = false) {
  if (!clipState?.total) return;
  let start = Number(clipStart.value), end = Number(clipEnd.value);
  if (changed === "start" && end - start < MIN_CLIP_SECONDS) start = Math.max(0, end - MIN_CLIP_SECONDS);
  if (changed === "end" && end - start < MIN_CLIP_SECONDS) end = Math.min(clipState.total, start + MIN_CLIP_SECONDS);
  clipStart.value = String(start); clipEnd.value = String(end);
  clipStartLabel.value = formatTime(start); clipEndLabel.value = formatTime(end);
  clipSelection.textContent = `${formatTime(end - start)} selected · ${formatTime(start)}–${formatTime(end)}`;
  const startPercent = `${start / clipState.total * 100}%`, endPercent = `${end / clipState.total * 100}%`;
  clipRangeTrack.style.setProperty("--clip-start", startPercent);
  clipRangeTrack.style.setProperty("--clip-end", endPercent);
  clipRangeTrack.classList.toggle("start-on-top", start > clipState.total / 2);
  if (seek) clipPreview.currentTime = changed === "end" ? Math.max(start, end - 0.05) : start;
}

function updateClipCropSelection() {
  if (!clipState) return;
  const aspect = Number(clipCrop.value);
  if (!aspect) { resetClipCropSelection(); return; }
  const width = clipStage.clientWidth, height = clipStage.clientHeight;
  if (!width || !height) return;
  const frameAspect = width / height;
  let cropWidth = 1, cropHeight = 1;
  if (frameAspect > aspect) cropWidth = aspect / frameAspect;
  else cropHeight = frameAspect / aspect;
  clipState.cropRect = { x: (1 - cropWidth) / 2, y: (1 - cropHeight) / 2, width: cropWidth, height: cropHeight };
  renderClipCrop();
}

function renderClipCrop() {
  if (!clipState?.cropRect || !Number(clipCrop.value)) {
    clipCropOverlay.hidden = true; clipCropHelp.hidden = true; return;
  }
  const rect = clipState.cropRect;
  clipCropBox.style.left = `${rect.x * 100}%`; clipCropBox.style.top = `${rect.y * 100}%`;
  clipCropBox.style.width = `${rect.width * 100}%`; clipCropBox.style.height = `${rect.height * 100}%`;
  clipCropOverlay.hidden = false; clipCropHelp.hidden = false;
}

function resetClipCropSelection() {
  clipCropGesture = null;
  if (clipState) clipState.cropRect = null;
  clipCropOverlay.hidden = true; clipCropHelp.hidden = true;
}

function beginClipCropGesture(event) {
  if (!clipState?.cropRect || clipState.busy) return;
  const bounds = clipStage.getBoundingClientRect(), rect = clipState.cropRect;
  const handle = event.target.closest("[data-crop-handle]")?.dataset.cropHandle || "";
  clipCropGesture = {
    pointerId: event.pointerId, handle, startX: event.clientX, startY: event.clientY,
    rect: { x: rect.x * bounds.width, y: rect.y * bounds.height, width: rect.width * bounds.width, height: rect.height * bounds.height }
  };
  clipCropBox.setPointerCapture(event.pointerId); event.preventDefault();
}

function moveClipCropGesture(event) {
  if (!clipCropGesture || event.pointerId !== clipCropGesture.pointerId || !clipState) return;
  const bounds = clipStage.getBoundingClientRect(), start = clipCropGesture.rect;
  let next;
  if (!clipCropGesture.handle) {
    next = {
      x: clamp(start.x + event.clientX - clipCropGesture.startX, 0, bounds.width - start.width),
      y: clamp(start.y + event.clientY - clipCropGesture.startY, 0, bounds.height - start.height),
      width: start.width, height: start.height
    };
  } else {
    next = resizedClipCrop(start, clipCropGesture.handle, event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height, Number(clipCrop.value));
  }
  setNormalizedClipCrop(next, bounds.width, bounds.height); event.preventDefault();
}

function resizedClipCrop(rect, handle, pointerX, pointerY, boundsWidth, boundsHeight, aspect) {
  const west = handle.includes("w"), north = handle.includes("n");
  const anchorX = west ? rect.x + rect.width : rect.x, anchorY = north ? rect.y + rect.height : rect.y;
  const widthFromPointer = Math.abs(pointerX - anchorX), widthFromHeight = Math.abs(pointerY - anchorY) * aspect;
  let width = Math.abs(widthFromPointer - rect.width) >= Math.abs(widthFromHeight - rect.width) ? widthFromPointer : widthFromHeight;
  const maxWidth = Math.max(2, Math.min(west ? anchorX : boundsWidth - anchorX, (north ? anchorY : boundsHeight - anchorY) * aspect));
  const minWidth = Math.min(maxWidth, Math.max(48, 48 * aspect));
  width = clamp(width, minWidth, maxWidth);
  const height = width / aspect;
  return { x: west ? anchorX - width : anchorX, y: north ? anchorY - height : anchorY, width, height };
}

function setNormalizedClipCrop(rect, boundsWidth, boundsHeight) {
  if (!clipState || !boundsWidth || !boundsHeight) return;
  clipState.cropRect = { x: rect.x / boundsWidth, y: rect.y / boundsHeight, width: rect.width / boundsWidth, height: rect.height / boundsHeight };
  renderClipCrop();
}

function endClipCropGesture(event) {
  if (!clipCropGesture || event.pointerId !== clipCropGesture.pointerId) return;
  if (clipCropBox.hasPointerCapture(event.pointerId)) clipCropBox.releasePointerCapture(event.pointerId);
  clipCropGesture = null;
}

function nudgeClipCrop(event) {
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (!direction || !clipState?.cropRect || clipState.busy) return;
  const bounds = clipStage.getBoundingClientRect(), rect = clipState.cropRect;
  const step = event.shiftKey ? 10 : 1;
  const next = {
    x: clamp(rect.x * bounds.width + direction[0] * step, 0, bounds.width - rect.width * bounds.width),
    y: clamp(rect.y * bounds.height + direction[1] * step, 0, bounds.height - rect.height * bounds.height),
    width: rect.width * bounds.width, height: rect.height * bounds.height
  };
  setNormalizedClipCrop(next, bounds.width, bounds.height); event.preventDefault();
}

function markClipBoundary(boundary) {
  if (!clipState?.total || clipState.busy) return;
  const time = Math.max(0, Math.min(clipPreview.currentTime, clipState.total));
  if (boundary === "start") clipStart.value = String(Math.min(time, Number(clipEnd.value) - MIN_CLIP_SECONDS));
  else clipEnd.value = String(Math.max(time, Number(clipStart.value) + MIN_CLIP_SECONDS));
  updateClipRange(boundary);
}

async function playClipSelection() {
  if (!clipState?.total || clipState.busy) return;
  clipPreview.currentTime = Number(clipStart.value); clipState.playing = true;
  try { await clipPreview.play(); } catch { clipState.playing = false; }
}

async function applyClip() {
  if (!clipState?.total || clipState.busy) return;
  const state = clipState;
  let range;
  try { range = normalizeTrimRange(clipStart.value, clipEnd.value, state.total); }
  catch (error) { clipError.textContent = error.message; return; }
  const cropAspect = Number(clipCrop.value) || 0;
  const crop = cropAspect ? videoCropFromNormalized(clipPreview.videoWidth, clipPreview.videoHeight, state.cropRect) : null;
  if (cropAspect && !crop) { clipError.textContent = "The crop area could not be read from the video preview."; return; }
  if (range.start < 0.05 && state.total - range.end < 0.05 && !cropAspect) { closeClipper(); showToast("The full video is already selected."); return; }
  setClipBusy(true); clipError.textContent = ""; clipProgress.hidden = false;
  clipOperationActive = true;
  try {
    const item = draft.media[state.index];
    const blob = await trimVideo(item.url, { start: range.start, end: range.end, total: state.total, crop }, {
      onProgress: value => { if (canCommitClip(state, clipState)) clipProgress.value = value; }
    });
    if (!canCommitClip(state, clipState)) return;
    const url = URL.createObjectURL(blob); objectUrls.push(url); releaseObjectUrl(item.url);
    draft.media[state.index] = { ...withoutStoredReference(item), url, local: true, filename: `clip-${Date.now()}.mp4`, trim: range, crop: cropAspect ? clipCrop.selectedOptions[0].textContent : item.crop };
    setClipBusy(false); renderMedia(); closeClipper(); showToast(`Clip ready · ${formatTime(range.duration)}`);
  } catch (error) {
    if (!canCommitClip(state, clipState)) return;
    clipError.textContent = error instanceof Error ? error.message : "The video could not be clipped.";
    setClipBusy(false);
  } finally {
    clipOperationActive = false;
  }
}

async function openImageEditor(index) {
  const item = draft.media[index];
  if (!item || item.kind !== "image") return;
  imageError.textContent = ""; setActiveImageCropPreset("free");
  try {
    // Fabric.js is ~780 KB; import it only when the editor actually opens so
    // it stays out of the compose page's startup module graph.
    const { DEFAULT_MARKUP_COLOR, FabricImageEditor } = await import("./shared/fabric-image-editor.js");
    imageColor.value = DEFAULT_MARKUP_COLOR;
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`Could not load the image (${response.status}).`);
    const blob = await response.blob(), sourceUrl = URL.createObjectURL(blob), image = await loadEditorImage(sourceUrl);
    const editor = new FabricImageEditor(imageCanvas, {
      onToolChange: setActiveImageTool,
      onHistory: (position, length) => {
        document.querySelector("#imageUndo").disabled = position <= 0;
        document.querySelector("#imageRedo").disabled = position >= length - 1;
      }
    });
    imageState = { index, editor, sourceUrl, type: blob.type };
    await editor.load(image); setActiveImageTool("select"); imageDialog.showModal();
  } catch (error) { showToast(error instanceof Error ? error.message : "The image could not be edited."); }
}

async function applyImageEdit() {
  if (!imageState) return;
  try {
    const outputType = imageState.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await canvasBlob(imageState.editor.exportCanvas(), outputType), item = draft.media[imageState.index], url = URL.createObjectURL(blob);
    objectUrls.push(url); releaseObjectUrl(item.url);
    draft.media[imageState.index] = { ...withoutStoredReference(item), url, local: true, filename: `edited-${Date.now()}.${outputType === "image/png" ? "png" : "jpg"}`, edited: true };
    renderMedia(); closeImageEditor(); showToast("Edited image ready.");
  } catch (error) { imageError.textContent = error instanceof Error ? error.message : "The image could not be saved."; }
}
function closeImageEditor() {
  if (imageState) { imageState.editor.dispose(); URL.revokeObjectURL(imageState.sourceUrl); }
  imageState = null; imageError.textContent = "";
  if (imageDialog.open) imageDialog.close();
}
function setActiveImageTool(tool) {
  document.querySelectorAll("[data-image-tool]").forEach(button => button.classList.toggle("active", button.dataset.imageTool === tool));
  imageCropControls.hidden = tool !== "crop";
}
function beginImageCrop(preset) {
  if (!imageState) return;
  setActiveImageCropPreset(preset); imageState.editor.beginCrop(preset);
}
function cancelImageCrop() { imageState?.editor.setTool("select"); }
function setActiveImageCropPreset(preset) {
  document.querySelectorAll("[data-image-crop]").forEach(button => button.classList.toggle("active", button.dataset.imageCrop === preset));
}
function loadEditorImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("The image preview could not be loaded.")); image.src = url;
  });
}

function setClipBusy(busy) {
  if (!clipState) return;
  clipState.busy = busy;
  for (const element of [clipStart, clipEnd, clipCrop, document.querySelector("#clipPlay"), document.querySelector("#clipMarkStart"), document.querySelector("#clipMarkEnd"), clipApply]) element.disabled = busy;
  clipCropBox.dataset.disabled = String(busy);
  document.querySelector("#clipCancel").disabled = false;
  document.querySelector("#clipClose").disabled = false;
  clipApply.innerHTML = busy ? `${icon("refresh")}Creating clip…` : `Use clip${icon("check")}`;
}

function closeClipper() {
  if (clipState) clipState.cancelled = true;
  resetClipCropSelection();
  clipPreview.pause(); clipPreview.removeAttribute("src"); clipPreview.load();
  if (clipDialog.open) clipDialog.close();
  clipState = null; clipError.textContent = ""; clipApply.innerHTML = `Use clip${icon("check")}`;
}

function releaseObjectUrl(url) {
  const index = objectUrls.indexOf(url);
  if (index < 0) return;
  URL.revokeObjectURL(url); objectUrls.splice(index, 1);
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0), minutes = Math.floor(safe / 60), remainder = (safe % 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${remainder}`;
}
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(value, maximum)); }
function setHandoffActive(active) {
  handoffOverlay.hidden = !active;
  composeMain.inert = active;
  composeTopbar.inert = active;
  document.body.classList.toggle("handoff-active", active);
  if (!active) handoffCancelError.textContent = "";
}

async function cancelNativeHandoff() {
  ++publishGeneration;
  handoffCancel.disabled = true;
  handoffCancel.textContent = "Cancelling…";
  handoffCancelError.textContent = "";
  const response = await ext.runtime.sendMessage({ type: "CANCEL_NATIVE_HANDOFF", sessionId, attemptId: activeHandoffAttemptId }).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  handoffCancel.disabled = false;
  handoffCancel.textContent = "Cancel crosspost";
  if (!response?.ok) {
    handoffCancelError.textContent = response?.error || "The crosspost could not be cancelled.";
    return;
  }
  publishBusy = false;
  activeHandoffAttemptId = "";
  document.querySelector("#errors").textContent = "";
  setHandoffActive(false);
  renderPublishAction();
  showToast("Crossposting cancelled. You can continue editing.");
}

async function publish() {
  const errors = validateDraft(draft); const box = document.querySelector("#errors"); box.textContent = errors.join(" "); if (errors.length) return;
  const selected = selectedNativeDestinations(draft), networkIds = selected.map(destination => destination.id), button = document.querySelector("#publish");
  const generation = ++publishGeneration;
  const attemptId = crypto.randomUUID();
  activeHandoffAttemptId = attemptId;
  publishBusy = true;
  button.disabled = true;
  button.innerHTML = `Preparing…${icon("refresh")}`;
  setHandoffActive(true);
  // Sidebar APIs require a live user gesture. Open the extension-owned surface
  // before any asynchronous storage or media work, then populate it while the
  // native tabs open.
  try { await openNativeTray(networkIds, attemptId); }
  catch (error) {
    if (generation !== publishGeneration) return;
    box.textContent = error instanceof Error ? error.message : String(error);
    publishBusy = false; activeHandoffAttemptId = ""; setHandoffActive(false); renderPublishAction(); return;
  }
  if (generation !== publishGeneration) return;
  await saveDraftHistory().catch(error => showToast(error instanceof Error ? error.message : "Draft history could not be saved."));
  if (generation !== publishGeneration) return;
  try {
    const handoff = await startNativeHandoff(networkIds, attemptId);
    if (generation !== publishGeneration || handoff.cancelled) return;
    const failed = (handoff.results || []).filter(result => result.error);
    box.textContent = [
      ...failed.map(result => `${label(result.network)}: ${result.error}`),
      ...(handoff.failures || []).map(error => `Media: ${error}`),
      ...(handoff.groupError ? [`Tab group: ${handoff.groupError}`] : [])
    ].join(" ");
    showToast(`${networkIds.length} native composer${networkIds.length === 1 ? " is" : "s are"} ready for review.`);
  } catch (error) {
    if (generation === publishGeneration) box.textContent = error instanceof Error ? error.message : String(error);
  }
  if (generation !== publishGeneration) return;
  publishBusy = false; renderPublishAction();
  // Native composers are deliberately unobservable after handoff: keep the
  // draft available because only the user knows whether they clicked Post.
  await ext.storage.local.set({ pendingDraft: draft });
}
async function openNativeTray(networks, attemptId) {
  const response = await ext.runtime.sendMessage({ type: "OPEN_NATIVE_TRAY", sessionId, attemptId, text: draft.text, networks });
  if (!response?.ok) throw new Error(response?.error || "Could not open the Crossposter handoff tray.");
  return response;
}

async function startNativeHandoff(networks, attemptId) {
  await prepareStreamPreviews();
  const prepared = [], preparedForHistory = [], failures = [];
  for (let index = 0; index < draft.media.length; index++) {
    const item = draft.media[index];
    try {
      let reference;
      if (item.mediaId) {
        const record = await getHandoffMedia(item.mediaId);
        if (!record?.blob) throw new Error("Saved media is no longer available.");
        reference = {
          mediaId: record.id, kind: item.kind || record.kind, name: item.name || record.name,
          type: item.type || record.type, size: record.size, lastModified: item.lastModified || record.lastModified
        };
      } else {
        const blob = isStreamMedia(item)
          ? await prepareStreamMedia(item)
          : await fetch(item.url).then(response => {
            if (!response.ok) throw new Error(`Media download failed (${response.status}).`);
            return response.blob();
          });
        reference = await storeHandoffMedia(blob, {
          kind: item.kind,
          name: handoffFilename({ ...item, type: blob.type }, index),
          type: blob.type || (item.kind === "video" ? "video/mp4" : "image/jpeg"),
          lastModified: Date.now()
        });
      }
      prepared.push(reference);
      preparedForHistory.push({ ...reference, sourceIndex: index });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "A media item could not be prepared.");
    }
  }
  await saveDraftHistory(preparedForHistory);
  const response = await ext.runtime.sendMessage({ type: "OPEN_NATIVE_HANDOFF", sessionId, attemptId, networks, handoff: { text: draft.text, media: prepared, mediaErrors: failures } });
  if (!response?.ok) throw new Error(response?.error || "Could not prepare the native composers.");
  if (failures.length) showToast(failures.join(" "));
  return {
    cancelled: response.cancelled === true,
    failures,
    results: response.results || [],
    tabGroupId: response.tabGroupId ?? null,
    groupError: response.groupError || ""
  };
}

function label(id) { return NATIVE_DESTINATIONS.find(destination => destination.id === id)?.label || id; }
function escapeAttr(value) { return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"); }
function formatHistoryTime(timestamp) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp || Date.now())); }

async function readDraftHistory() {
  const result = await ext.storage.local.get(DRAFT_HISTORY_KEY);
  return Array.isArray(result[DRAFT_HISTORY_KEY]) ? result[DRAFT_HISTORY_KEY] : [];
}

async function saveDraftHistory(preparedMedia) {
  const history = await readDraftHistory();
  const entry = draftHistoryEntry(draft, preparedMedia === undefined ? draft.media : preparedMedia);
  const result = upsertDraftHistory(history, entry);
  await ext.storage.local.set({ [DRAFT_HISTORY_KEY]: result.history });
  await deleteHandoffMedia(result.removedMediaIds).catch(() => {});
}

async function hydrateStoredMedia(media = []) {
  const hydrated = [];
  for (const item of media || []) {
    if (!item?.mediaId) { hydrated.push(item); continue; }
    const record = await getHandoffMedia(item.mediaId).catch(() => null);
    if (!record?.blob) continue;
    const url = URL.createObjectURL(record.blob); objectUrls.push(url);
    hydrated.push({ ...item, kind: item.kind || record.kind, url, local: true, filename: item.filename || item.name || record.name });
  }
  return hydrated;
}

function withoutStoredReference(item = {}) {
  const {
    mediaId: _mediaId, name: _name, type: _type, size: _size, lastModified: _lastModified,
    resolving: _resolving, resolutionId: _resolutionId, resolveError: _resolveError,
    preparing: _preparing, prepareError: _prepareError, ...editable
  } = item;
  return editable;
}

function prepareStreamPreviews() {
  return Promise.all(draft.media.map((item, index) => !item?.resolving && isStreamMedia(item) ? prepareStreamPreview(index, item) : null));
}

function prepareStreamPreview(index, item = draft.media[index]) {
  if (item?.resolving || !isStreamMedia(item)) return Promise.resolve(item);
  const existing = streamPreparationTasks.get(item);
  if (existing) return existing;
  item.preparing = true; item.prepareError = ""; renderMedia();
  const task = streamPreparationQueue.catch(() => {}).then(async () => {
    const blob = await prepareStreamMedia(item);
    if (draft.media[index] !== item) return draft.media[index];
    if (!blob?.size) throw new Error("The prepared video was empty.");
    const url = URL.createObjectURL(blob); objectUrls.push(url);
    const { streamType: _streamType, audioUrl: _audioUrl, ...prepared } = withoutStoredReference(item);
    draft.media[index] = { ...prepared, url, local: true, filename: item.filename || "video.mp4" };
    renderMedia();
    return draft.media[index];
  }).catch(error => {
    streamPreparationTasks.delete(item);
    if (draft.media[index] === item) {
      item.preparing = false;
      item.prepareError = error instanceof Error ? error.message : "The video preview could not be prepared.";
      renderMedia();
    }
    throw error;
  });
  streamPreparationTasks.set(item, task);
  streamPreparationQueue = task;
  return task;
}
window.addEventListener("beforeunload", () => objectUrls.forEach(URL.revokeObjectURL));

if (composeUrl.searchParams.get("settings") === "1") {
  composeUrl.searchParams.delete("settings");
  history.replaceState(null, "", composeUrl.href);
  openSettings();
}
