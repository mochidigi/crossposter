import { ext } from "./shared/browser.js";
import { setHtml } from "./shared/dom.js";
import { createDraft, creditPrefix, postText, validateDraft } from "./shared/draft.js";
import { canCommitClip, MIN_CLIP_SECONDS, normalizeTrimRange, trimVideo, videoCropFromNormalized } from "./shared/video-editor.js";
import { canvasBlob, imageEditorShortcut, MARKUP_COLORS } from "./shared/image-editor.js";
import { icon } from "./shared/icons.js";
import { handoffFilename, handoffMediaType } from "./shared/handoff.js";
import { muxMp4Tracks } from "./shared/hls.js";
import { isStreamMedia, prepareStreamMedia } from "./shared/media-preparation.js";
import { deleteHandoffMedia, getHandoffMedia, storeHandoffMedia } from "./shared/media-store.js";
import { DRAFT_HISTORY_KEY, draftHistoryEntry, expireDraftHistory, removeDraftHistoryEntry, upsertDraftHistory } from "./shared/draft-history.js";
import { continueLabel, NATIVE_DESTINATIONS, nativeDestinationBlocker, selectedNativeDestinations } from "./shared/destinations.js";
import { handoffNetworkStatuses, handoffStatusRow, handoffSummary } from "./shared/handoff-status.js";
import { CLIP_CUT_KEY, DEFAULT_DESTINATIONS_KEY, ENABLED_PLATFORMS_KEY, initialDraftDestinations, inlineActionsEnabled, KNOWN_PLATFORMS_KEY, normalizeClipCut, normalizeDefaultDestinations, normalizeEnabledPlatforms, SHOW_INLINE_ACTIONS_KEY, storedEnabledPlatforms } from "./shared/preferences.js";
import { isFreshComposerUrl } from "./shared/compose-mode.js";
import { CROSSPOST_SESSIONS_KEY, crosspostSessionIdFromUrl } from "./shared/crosspost-sessions.js";
import { settleVideoResolution } from "./shared/video-resolution-state.js";
import { incompletePlatformPermissions, platformLabel, requestCompletePlatformPermissions } from "./shared/platform-permissions.js";
import { feedbackOverlay } from "./shared/feedback-overlay.js";

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
// Declared before the awaits below: Feedback can be clicked while Compose loads.
let toastTimer = 0;
const openFeedbackOverlay = feedbackOverlay(document.querySelector("#feedbackDialog"));
document.querySelector("#feedbackOpen").onclick = () => openFeedback("manual");
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
  ext.storage.local.get(["pendingDraft", DEFAULT_DESTINATIONS_KEY, ENABLED_PLATFORMS_KEY, KNOWN_PLATFORMS_KEY, SHOW_INLINE_ACTIONS_KEY, CLIP_CUT_KEY]),
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
// Drop expired history and its stored media (see sweepStoredData).
ext.runtime.sendMessage({ type: "SWEEP_STORED_DATA" }).catch(() => {});
let defaultDestinations = normalizeDefaultDestinations(stored[DEFAULT_DESTINATIONS_KEY]);
let enabledPlatforms = storedEnabledPlatforms(stored);
let showInlineActions = inlineActionsEnabled(stored[SHOW_INLINE_ACTIONS_KEY]);
let clipCut = normalizeClipCut(stored[CLIP_CUT_KEY]);
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
const clipStage = document.querySelector("#clipStage"), clipFrame = document.querySelector("#clipFrame");
const clipCropOverlay = document.querySelector("#clipCropOverlay"), clipCropBox = document.querySelector("#clipCropBox");
const clipPlay = document.querySelector("#clipPlay"), clipTime = document.querySelector("#clipTime"), clipDuration = document.querySelector("#clipDuration");
const clipFilmstrip = document.querySelector("#clipFilmstrip"), clipMeta = document.querySelector("#clipMeta"), clipHint = document.querySelector("#clipHint");
const clipBusy = document.querySelector("#clipBusy"), clipProgressLabel = document.querySelector("#clipProgressLabel");
const imageDialog = document.querySelector("#imageDialog"), imageCanvas = document.querySelector("#imageCanvas"), imageStage = document.querySelector("#imageStage");
const imageCropControls = document.querySelector("#imageCropControls"), imageMarkupOptions = document.querySelector("#imageMarkupOptions");
const imageCropActions = document.querySelector("#imageCropActions"), imageEditActions = document.querySelector("#imageEditActions");
const imageColor = document.querySelector("#imageColor"), imageSwatches = document.querySelector("#imageSwatches"), imageDelete = document.querySelector("#imageDelete");
const imageError = document.querySelector("#imageError"), imageHint = document.querySelector("#imageHint"), imageMeta = document.querySelector("#imageMeta"), imageApply = document.querySelector("#imageApply");
const composeMain = document.querySelector("main"), composeTopbar = document.querySelector(".topbar");
const handoffOverlay = document.querySelector("#handoffOverlay"), handoffCancel = document.querySelector("#handoffCancel"), handoffCancelError = document.querySelector("#handoffCancelError");
const handoffTitle = document.querySelector("#handoffOverlayTitle"), handoffLead = document.querySelector("#handoffOverlayLead"), handoffStatus = document.querySelector("#handoffStatus");
const handoffNotice = document.querySelector("#handoffNotice"), handoffNew = document.querySelector("#handoffNew"), handoffActionsNote = document.querySelector("#handoffActionsNote");
const permissionDialog = document.querySelector("#permissionDialog"), permissionTitle = document.querySelector("#permissionTitle"), permissionCopy = document.querySelector("#permissionCopy");
const permissionAllow = document.querySelector("#permissionAllow"), permissionCancel = document.querySelector("#permissionCancel"), permissionError = document.querySelector("#permissionError");
let clipState = null;
let clipCropGesture = null;
let clipScrubPointer = null;
let imageState = null;
let imageOpenAttempt = 0;
let clipOperationActive = false;
let publishBusy = false;
let publishGeneration = 0;
let activeHandoffAttemptId = crosspostSession?.handoff?.attemptId || "";
let handoffFinished = false;
let settingsSnapshot = "";
// The background broadcasts every session change; follow this composer's
// handoff so its status panel shows where each destination stands.
ext.runtime.onMessage.addListener(message => {
  if (message?.type !== "CROSSPOST_SESSIONS_UPDATED" || !sessionId) return;
  const handoff = (message.sessions || []).find(session => session?.id === sessionId)?.handoff;
  if (!handoff || handoffOverlay.hidden) return;
  if (handoff.state === "idle") { if (!publishBusy) setHandoffActive(false); return; }
  renderHandoffPanel(handoff);
});
draft.destinations = initialDraftDestinations(draft, stored[DEFAULT_DESTINATIONS_KEY], enabledPlatforms);
// First paint: text and destinations immediately; media hydration reads blobs
// from IndexedDB and stays off the critical path.
text.value = draft.text; text.placeholder = "What do you want to share?";
renderMeta(); renderDestinations();
console.debug(`[crossposter] first paint ${Math.round(performance.now())}ms since navigation (module start ${Math.round(moduleStartAt)}ms, data loaded ${Math.round(dataLoadedAt)}ms)`);
draft.media = await hydrateStoredMedia(draft.media);
renderAll();
composerReady = true;
// A late permission grant or a suspended background page can leave the card
// marked "Locating video" after the session has already settled; keep
// reconciling with the stored session until nothing is resolving.
const resolutionWatch = setInterval(() => {
  if (!draft.media.some(item => item?.resolving)) return;
  reconcileCapturedVideoResolution().catch(() => {});
}, 5000);
setTimeout(() => clearInterval(resolutionWatch), 5 * 60 * 1000);
initializeSourcePermissions().catch(error => showSourcePermissionGate(error instanceof Error ? error.message : String(error)));
const addLink = document.querySelector("#addLink");
renderComposerMode();
if (addLink) addLink.onclick = () => { if (draft.sourceUrl && !text.value.includes(draft.sourceUrl)) { text.value = `${text.value.trim()}\n\n${draft.sourceUrl}`.trim(); text.dispatchEvent(new Event("input")); } };

text.addEventListener("input", () => { draft.text = text.value; renderMeta(); });
document.querySelector("#creditToggle").onclick = () => { draft.credit = draft.credit === false; renderMeta(); };
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
document.querySelector("#addMedia").onclick = () => document.querySelector("#file").click();
document.querySelector("#file").onchange = event => {
  for (const file of [...event.target.files].slice(0, 4 - draft.media.length)) {
    const url = URL.createObjectURL(file); objectUrls.push(url); draft.media.push({ kind: file.type.startsWith("video") ? "video" : "image", url, local: true, filename: file.name });
  }
  event.target.value = "";
  renderMedia();
};
document.querySelector("#clipClose").onclick = closeClipper;
document.querySelector("#clipCancel").onclick = closeClipper;
clipPlay.onclick = toggleClipPlayback;
clipPreview.onclick = toggleClipPlayback;
document.querySelector("#clipMarkStart").onclick = () => markClipBoundary("start");
document.querySelector("#clipMarkEnd").onclick = () => markClipBoundary("end");
clipStart.oninput = () => updateClipRange("start", true);
clipEnd.oninput = () => updateClipRange("end", true);
clipApply.onclick = applyClip;
document.querySelectorAll("[data-clip-crop]").forEach(button => button.onclick = () => selectClipCrop(button));
clipPreview.onloadedmetadata = initializeClipRange;
clipPreview.ontimeupdate = () => {
  if (clipState?.playing && clipPreview.currentTime >= Number(clipEnd.value)) {
    clipPreview.pause(); clipPreview.currentTime = Number(clipStart.value); clipState.playing = false;
  }
  updateClipPlayhead();
};
clipPreview.onseeked = () => updateClipPlayhead();
clipPreview.onplay = () => { setClipPlaying(true); followClipPlayhead(); };
clipPreview.onpause = () => setClipPlaying(false);
clipPreview.onerror = () => { if (clipState) clipError.textContent = "The video preview could not be loaded."; };
clipRangeTrack.onpointerdown = beginClipScrub;
clipRangeTrack.onpointermove = moveClipScrub;
clipRangeTrack.onpointerup = endClipScrub;
clipRangeTrack.onpointercancel = endClipScrub;
clipCropBox.onpointerdown = beginClipCropGesture;
clipCropBox.onpointermove = moveClipCropGesture;
clipCropBox.onpointerup = endClipCropGesture;
clipCropBox.onpointercancel = endClipCropGesture;
clipCropBox.onkeydown = nudgeClipCrop;
window.addEventListener("resize", () => { fitClipFrame(); paintClipFilmstrip(); });
clipDialog.addEventListener("cancel", event => { event.preventDefault(); closeClipper(); });
document.addEventListener("keydown", clipKeyDown);
document.querySelector("#imageClose").onclick = closeImageEditor;
document.querySelector("#imageCancel").onclick = closeImageEditor;
imageApply.onclick = applyImageEdit;
document.querySelector("#imageUndo").onclick = () => imageState?.editor.undo();
document.querySelector("#imageRedo").onclick = () => imageState?.editor.redo();
document.querySelector("#imageRotate").onclick = () => imageState?.editor.rotate();
document.querySelector("#imageCropCancel").onclick = cancelImageCrop;
document.querySelector("#imageCropApply").onclick = applyImageCrop;
imageDelete.onclick = () => imageState?.editor.deleteSelection();
document.querySelectorAll("[data-image-crop]").forEach(button => button.onclick = () => beginImageCrop(button.dataset.imageCrop));
for (const { color, label } of MARKUP_COLORS) {
  const swatch = document.createElement("button");
  Object.assign(swatch, { type: "button", className: "swatch", title: label });
  swatch.dataset.imageColor = color; swatch.style.setProperty("--swatch", color);
  swatch.setAttribute("aria-label", label); swatch.setAttribute("aria-pressed", "false");
  swatch.onclick = () => setImageColor(color);
  imageSwatches.append(swatch);
}
imageColor.oninput = () => setImageColor(imageColor.value);
document.querySelectorAll("[data-image-tool]").forEach(button => button.onclick = () => selectImageTool(button.dataset.imageTool));
imageDialog.addEventListener("cancel", event => {
  event.preventDefault();
  imageState?.editor.tool === "crop" ? cancelImageCrop() : closeImageEditor();
});
document.addEventListener("keydown", imageKeyDown);
document.querySelector("#publish").onclick = publish;
handoffCancel.onclick = cancelNativeHandoff;
handoffNew.onclick = startNewPost;
permissionAllow.onclick = grantSourcePermissions;
permissionCancel.onclick = cancelPermissionGate;
permissionDialog.addEventListener("cancel", event => event.preventDefault());
if (crosspostSession?.handoff && crosspostSession.handoff.state !== "idle") {
  setHandoffActive(true);
  renderHandoffPanel(crosspostSession.handoff);
}

async function initializeSourcePermissions() {
  const missing = await incompletePlatformPermissions(ext.permissions, [draft.sourceNetwork]);
  if (missing.length) {
    showSourcePermissionGate();
    return;
  }
  await sourcePermissionsReady();
}

function showSourcePermissionGate(error = "") {
  const platform = platformLabel(draft.sourceNetwork);
  permissionTitle.textContent = `Allow access to ${platform}`;
  permissionCopy.textContent = `Crossposter needs access to ${platform} and its related media services as one set. This prevents incomplete captures and media errors.`;
  permissionError.textContent = error;
  permissionAllow.disabled = false;
  permissionAllow.textContent = "Allow access";
  if (!permissionDialog.open) permissionDialog.showModal();
}

async function grantSourcePermissions() {
  permissionAllow.disabled = true;
  permissionAllow.textContent = "Checking…";
  permissionError.textContent = "";
  const result = await requestCompletePlatformPermissions(ext.permissions, [draft.sourceNetwork]);
  if (!result.ok) {
    const platform = result.missing.map(platformLabel).join(", ") || platformLabel(draft.sourceNetwork);
    showSourcePermissionGate(result.error || `Allow every requested permission for ${platform} to use it with Crossposter.`);
    return;
  }
  permissionDialog.close();
  await sourcePermissionsReady();
}

async function cancelPermissionGate() {
  permissionCancel.disabled = true;
  permissionAllow.disabled = true;
  const response = await ext.runtime.sendMessage({ type: "CLOSE_CROSSPOST_SESSION", sessionId }).catch(() => null);
  if (!response?.ok) {
    permissionCancel.disabled = false;
    permissionAllow.disabled = false;
    permissionError.textContent = response?.error || "This Crossposter draft could not be closed.";
  }
}

async function sourcePermissionsReady() {
  const response = sessionId
    ? await ext.runtime.sendMessage({ type: "RESUME_CAPTURED_VIDEO", sessionId }).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    : { ok: true };
  if (!response?.ok) {
    showSourcePermissionGate(response?.error || "Crossposter could not verify access to this platform.");
    return;
  }
  if (response.resumed && Array.isArray(response.media)) {
    draft.media = response.media;
    renderMedia();
    renderPublishAction();
    if (!draft.media.some(item => item?.resolveError)) prepareStreamPreviews().catch(() => {});
    queuedVideoResolution = null;
    return;
  }
  if (queuedVideoResolution) {
    applyCapturedVideoResolution(queuedVideoResolution);
    queuedVideoResolution = null;
    return;
  }
  prepareStreamPreviews().catch(() => {});
  reconcileCapturedVideoResolution().catch(() => {});
}

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
// `report` adds a button that opens the feedback form for this error.
function showToast(message, { report = false } = {}) {
  const toast = document.querySelector("#toast");
  toast.replaceChildren(message);
  if (report) toast.append(reportButton(message, "toast-action", () => toast.classList.remove("show")));
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), report ? 9000 : 4000);
}

function reportButton(error, className, beforeOpen = () => {}) {
  const button = document.createElement("button");
  button.type = "button"; button.className = className; button.textContent = "Report this problem";
  button.title = "Opens Crossposter’s feedback form with details for fixing this. Nothing is sent until you press Send there.";
  button.onclick = () => { beforeOpen(); openFeedback("error", error); };
  return button;
}

// Opens Crossposter's feedback form over Compose; nothing is sent from here.
function openFeedback(kind, error = "", network = "") {
  openFeedbackOverlay({ kind, error, network, surface: "compose", sessionId })
    .catch(() => showToast("The feedback form could not be opened."));
}
// The credit is shown as the post's first line, outside the editable text:
// postText puts it in front of the text every destination receives.
function renderCredit() {
  const prefix = creditPrefix(draft).trim(), on = draft.credit !== false;
  const line = document.querySelector("#credit"), toggle = document.querySelector("#creditToggle");
  line.hidden = !prefix;
  line.classList.toggle("off", !on);
  document.querySelector("#creditText").textContent = prefix;
  toggle.setAttribute("aria-pressed", String(on));
  toggle.title = on ? "Each platform’s post starts with this credit. Select to leave it out." : "The credit is left out. Select to start each platform’s post with it.";
}

function renderMeta() {
  renderCredit();
  document.querySelector("#count").textContent = `${postText(draft).length} / 3000`;
  const source = document.querySelector("#source");
  if (!draft.sourceUrl) { source.textContent = "Fresh post"; return; }
  // Name the network properly and link back to the original post.
  let host = "";
  try { host = new URL(draft.sourceUrl).hostname.replace(/^www\./, ""); } catch {}
  const link = document.createElement("a");
  link.textContent = draft.sourceNetwork === "web" ? host || "the web" : platformLabel(draft.sourceNetwork);
  link.title = "Open the original post";
  if (/^https?:/i.test(draft.sourceUrl)) { link.href = draft.sourceUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; }
  source.replaceChildren("Captured from ", link);
}

function renderDestinations() {
  const enabled = new Set(enabledPlatforms);
  // Rebuilding the tiles must not drop keyboard focus from the one in use.
  const focusedId = document.activeElement?.closest?.("#destinations .destination")?.dataset.id;
  setHtml(destinations, NATIVE_DESTINATIONS.filter(destination => enabled.has(destination.id)).map(destination => {
    const blocker = nativeDestinationBlocker(draft, destination.id);
    const selected = !blocker && draft.destinations.includes(destination.id);
    const reason = blocker ? `<small>${escapeAttr(blocker)}</small>` : "";
    return `<label class="destination ${selected ? "selected" : ""} ${blocker ? "disabled" : ""}" data-id="${destination.id}"><span class="network-icon"><img src="${destination.icon}" alt=""></span><span class="destination-copy"><b>${escapeAttr(destination.label)}</b>${reason}</span><input type="checkbox" ${selected ? "checked" : ""} ${blocker ? "disabled" : ""}></label>`;
  }).join(""));
  destinations.querySelectorAll("input").forEach(input => input.onchange = event => { const id = event.target.closest("label").dataset.id; draft.destinations = event.target.checked ? [...new Set([...draft.destinations, id])] : draft.destinations.filter(item => item !== id); renderDestinations(); });
  if (focusedId) destinations.querySelector(`.destination[data-id="${focusedId}"] input:not(:disabled)`)?.focus();
  renderPublishAction();
}

function openSettings() {
  setHtml(settingsDestinations, NATIVE_DESTINATIONS.map(destination => {
    const enabled = enabledPlatforms.includes(destination.id);
    const checked = defaultDestinations.includes(destination.id);
    return `<div class="platform-preference ${enabled ? "" : "platform-disabled"}" data-platform="${destination.id}"><span class="platform-preference-name"><span class="network-icon"><img src="${destination.icon}" alt=""></span><b>${escapeAttr(destination.label)}</b></span><label class="preference-check"><span class="sr-only">Enable ${escapeAttr(destination.label)}</span><input data-platform-enabled type="checkbox" ${enabled ? "checked" : ""}></label><label class="preference-check"><span class="sr-only">Select ${escapeAttr(destination.label)} by default</span><input data-platform-default type="checkbox" ${checked ? "checked" : ""} ${enabled ? "" : "disabled"}></label></div>`;
  }).join(""));
  settingsDestinations.querySelectorAll("[data-platform-enabled]").forEach(input => input.onchange = () => updatePlatformPreferenceRow(input.closest("[data-platform]")));
  settingsInlineActions.checked = showInlineActions;
  settingsError.textContent = "";
  settingsClearError.textContent = "";
  settingsDialog.querySelector(".settings-danger").open = false;
  settingsSnapshot = settingsFormState();
  settingsDialog.showModal();
}

function settingsFormState() {
  const rows = [...settingsDestinations.querySelectorAll("[data-platform]")].map(row => [row.dataset.platform, row.querySelector("[data-platform-enabled]").checked, row.querySelector("[data-platform-default]").checked]);
  return JSON.stringify([rows, settingsInlineActions.checked]);
}

function updatePlatformPreferenceRow(row) {
  const enabled = row.querySelector("[data-platform-enabled]").checked;
  row.classList.toggle("platform-disabled", !enabled);
  row.querySelector("[data-platform-default]").disabled = !enabled;
}

// Closing without saving asks first when something was changed.
function closeSettings({ discard = false } = {}) {
  if (!settingsDialog.open) return;
  if (!discard && settingsFormState() !== settingsSnapshot && !confirm("Discard your unsaved changes to Settings?")) return;
  settingsDialog.close();
}

function renderComposerMode() {
  const captured = Boolean(draft.sourceUrl);
  document.querySelector("#composerTitle").textContent = captured ? "Edit the crosspost" : "New post";
  document.querySelector("#composerLede").textContent = captured
    ? "Polish the captured post, choose destinations, then review and post in each network’s own composer."
    : "Write it once, choose destinations, then review and post in each network’s own composer.";
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
    historyList.innerHTML = '<p class="history-empty">No saved crossposts yet. Drafts appear here when you select Continue.</p>';
    return;
  }
  setHtml(historyList, history.map(entry => {
    const item = entry.draft || {}, preview = item.text?.trim() || (item.media?.length ? "Media post" : "Untitled draft");
    const destinations = (item.destinations || []).map(label).join(", ") || "No destinations";
    const media = item.media?.length ? ` · ${item.media.length} media` : "";
    return `<article class="history-item" data-history-id="${escapeAttr(entry.id)}"><div class="history-copy"><time>${escapeAttr(formatHistoryTime(entry.savedAt))}</time><strong>${escapeAttr(preview.slice(0, 120))}</strong><span>${escapeAttr(destinations)}${media}</span></div><div class="history-actions"><button class="secondary" data-history-restore type="button">Restore</button><button class="icon-button" data-history-delete type="button" aria-label="Delete saved draft" title="Delete">${icon("trash")}</button></div></article>`;
  }).join(""));
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
  const permissionResult = await requestCompletePlatformPermissions(ext.permissions, nextEnabled);
  if (!permissionResult.ok) {
    const platforms = permissionResult.missing.map(platformLabel).join(", ");
    settingsError.textContent = permissionResult.error || `Allow every requested permission for ${platforms}, or disable those platforms.`;
    return;
  }
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
  closeSettings({ discard: true }); showToast("Settings saved.");
}

async function clearAllData() {
  if (!confirm("Clear all Crossposter data? This deletes saved drafts, history, preferences, temporary media, and other open Crossposter sessions.")) return;
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
  setHtml(button, `${action}${icon("arrow-right")}`);
}
function renderMedia() {
  setHtml(document.querySelector("#media"), draft.media.map((item, index) => {
    const video = item.kind === "video";
    const busyMedia = item.resolving || item.preparing;
    const edits = [item.resolveError || "", item.prepareError || "", item.trim ? `Clipped to ${formatTime(item.trim.duration)}` : "", item.crop ? `Cropped ${item.crop}` : "", item.edited ? "Edited image" : ""].filter(Boolean);
    const note = edits.length ? `<figcaption>${escapeAttr(edits.join(" · "))}</figcaption>` : "";
    const poster = video && item.poster ? ` poster="${escapeAttr(item.poster)}"` : "";
    const source = video && (isStreamMedia(item) || item.resolving || item.resolveError) ? "" : ` src="${escapeAttr(item.url)}"`;
    const disabled = busyMedia || item.resolveError ? " disabled" : "";
    const edit = video
      ? `<button class="media-clip" data-clip="${index}" type="button"${disabled}>${icon("scissors")}Edit</button>`
      : `<button class="media-clip" data-image-edit="${index}" type="button">${icon("pen")}Edit</button>`;
    const download = video ? `<button class="media-download" data-download="${index}" type="button"${disabled}>${icon("download")}Download</button>` : "";
    const busy = busyMedia ? `<div class="media-busy" role="status" aria-live="polite"><span class="media-spinner" aria-hidden="true"></span><span>${item.resolving ? "Locating video…" : "Preparing video…"}</span></div>` : "";
    return `<figure${busyMedia ? ' class="is-preparing"' : ""}><${video ? "video controls preload=metadata" : "img"}${source}${poster}></${video ? "video" : "img"}>${busy}<button class="media-remove" data-remove="${index}" aria-label="Remove media">${icon("trash")}</button><div class="media-actions">${edit}${download}</div>${note}</figure>`;
  }).join(""));
  document.querySelectorAll("[data-remove]").forEach(button => button.onclick = () => {
    const [removed] = draft.media.splice(Number(button.dataset.remove), 1); releaseObjectUrl(removed?.url); renderMedia(); renderPublishAction();
  });
  document.querySelectorAll("[data-clip]").forEach(button => button.onclick = () => openClipper(Number(button.dataset.clip)));
  document.querySelectorAll("[data-download]").forEach(button => button.onclick = () => downloadVideo(Number(button.dataset.download), button));
  document.querySelectorAll("[data-image-edit]").forEach(button => button.onclick = () => openImageEditor(Number(button.dataset.imageEdit)));
  // Instagram's tile depends on whether the draft has media.
  renderDestinations();
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
    showToast(error instanceof Error ? error.message : "The video could not be downloaded.", { report: true });
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
      showToast(error instanceof Error ? error.message : "The video could not be prepared for editing.", { report: true });
      return;
    }
  }
  clipState = { index, total: 0, busy: false, playing: false, cancelled: false, cropRect: null, cropAspect: 0, cropLabel: "", frames: [] };
  clipError.textContent = ""; clipSelection.textContent = "Loading video…"; clipMeta.textContent = ""; setClipProgress(null);
  clipStart.disabled = true; clipEnd.disabled = true; clipApply.disabled = true;
  clipTime.value = formatTime(0); clipDuration.textContent = formatTime(0);
  clipRangeTrack.style.setProperty("--clip-playhead", "0%");
  setActiveClipCrop(""); resetClipCropSelection(); setClipPlaying(false); renderClipHint(); paintClipFilmstrip();
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
  clipDuration.textContent = formatTime(total);
  clipMeta.textContent = clipPreview.videoWidth ? `${formatTime(total)}, ${clipPreview.videoWidth} × ${clipPreview.videoHeight}` : formatTime(total);
  fitClipFrame(); updateClipRange(); updateClipPlayhead();
  // A shape picked before the metadata arrived was fitted to a guessed frame.
  if (clipState.cropAspect) updateClipCropSelection();
  captureClipFilmstrip(clipPreview.currentSrc || clipPreview.src, clipState);
}

// The frame wraps exactly the visible picture, so crop coordinates measured
// against it map straight onto the video's pixels.
function fitClipFrame() {
  if (!clipState || !clipPreview.videoWidth || !clipPreview.videoHeight) { clipFrame.style.width = ""; clipFrame.style.height = ""; return; }
  const available = innerSize(clipStage), aspect = clipPreview.videoWidth / clipPreview.videoHeight;
  let width = available.width, height = width / aspect;
  if (height > available.height) { height = available.height; width = height * aspect; }
  clipFrame.style.width = `${Math.max(1, Math.floor(width))}px`; clipFrame.style.height = `${Math.max(1, Math.floor(height))}px`;
  renderClipCrop();
}

function innerSize(element) {
  const style = getComputedStyle(element);
  return {
    width: Math.max(1, element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
    height: Math.max(1, element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
  };
}

const FILMSTRIP_FRAMES = 12;
// Fills the timeline with frames from a second, muted copy of the video so the
// preview's playhead never jumps. The strip is only a visual aid: any failure
// leaves the plain track.
async function captureClipFilmstrip(url, state) {
  const video = document.createElement("video");
  // Metadata only: each seek then fetches just the ranges it needs, so a
  // remote video is not downloaded in full for the strip.
  Object.assign(video, { muted: true, preload: "metadata", playsInline: true, src: url });
  try {
    await mediaEvent(video, "loadeddata");
    for (let frame = 0; frame < FILMSTRIP_FRAMES; frame++) {
      if (state !== clipState || state.cancelled) return;
      video.currentTime = Math.min(Math.max(0, video.duration - 0.05), (frame + 0.5) / FILMSTRIP_FRAMES * video.duration);
      await mediaEvent(video, "seeked");
      const canvas = document.createElement("canvas");
      canvas.height = 96; canvas.width = Math.max(1, Math.round(96 * video.videoWidth / video.videoHeight)) || 170;
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      state.frames[frame] = canvas;
      if (state === clipState) paintClipFilmstrip();
    }
  } catch {
    // Keep whatever frames arrived.
  } finally {
    video.removeAttribute("src"); video.load();
  }
}

function mediaEvent(element, type, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const done = event => { clearTimeout(timer); element.removeEventListener(type, done); element.removeEventListener("error", done); event.type === type ? resolve() : reject(new Error("media error")); };
    const timer = setTimeout(() => done({ type: "timeout" }), timeout);
    element.addEventListener(type, done); element.addEventListener("error", done);
  });
}

function paintClipFilmstrip() {
  const ratio = window.devicePixelRatio || 1, width = clipFilmstrip.clientWidth, height = clipFilmstrip.clientHeight;
  if (!width || !height) return;
  clipFilmstrip.width = Math.round(width * ratio); clipFilmstrip.height = Math.round(height * ratio);
  const context = clipFilmstrip.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
  const frames = clipState?.frames || [], sample = frames.find(Boolean);
  if (!sample) return;
  const slots = Math.max(1, Math.ceil(width / (height * sample.width / sample.height))), slotWidth = width / slots;
  for (let slot = 0; slot < slots; slot++) {
    const wanted = Math.min(FILMSTRIP_FRAMES - 1, Math.floor((slot + 0.5) / slots * FILMSTRIP_FRAMES));
    const frame = nearestFrame(frames, wanted);
    if (!frame) continue;
    // Cover the slot, cropping the frame's sides evenly.
    const scale = Math.max(slotWidth / frame.width, height / frame.height), sourceWidth = slotWidth / scale, sourceHeight = height / scale;
    context.drawImage(frame, (frame.width - sourceWidth) / 2, (frame.height - sourceHeight) / 2, sourceWidth, sourceHeight, slot * slotWidth, 0, Math.ceil(slotWidth) + 1, height);
  }
}

function nearestFrame(frames, index) {
  for (let distance = 0; distance < FILMSTRIP_FRAMES; distance++) {
    if (frames[index - distance]) return frames[index - distance];
    if (frames[index + distance]) return frames[index + distance];
  }
  return null;
}

function updateClipRange(changed = "", seek = false) {
  if (!clipState?.total) return;
  let start = Number(clipStart.value), end = Number(clipEnd.value);
  if (changed === "start" && end - start < MIN_CLIP_SECONDS) start = Math.max(0, end - MIN_CLIP_SECONDS);
  if (changed === "end" && end - start < MIN_CLIP_SECONDS) end = Math.min(clipState.total, start + MIN_CLIP_SECONDS);
  clipStart.value = String(start); clipEnd.value = String(end);
  clipStartLabel.value = formatTime(start); clipEndLabel.value = formatTime(end);
  clipSelection.textContent = `${formatSeconds(end - start)} clip`;
  const startPercent = `${start / clipState.total * 100}%`, endPercent = `${end / clipState.total * 100}%`;
  clipRangeTrack.style.setProperty("--clip-start", startPercent);
  clipRangeTrack.style.setProperty("--clip-end", endPercent);
  clipRangeTrack.classList.toggle("start-on-top", start > clipState.total / 2);
  if (seek) clipPreview.currentTime = changed === "end" ? Math.max(start, end - 0.05) : start;
  renderClipHint();
}

function updateClipPlayhead(time = clipPreview.currentTime) {
  if (!clipState?.total) return;
  const position = clamp(Number(time) || 0, 0, clipState.total);
  clipRangeTrack.style.setProperty("--clip-playhead", `${position / clipState.total * 100}%`);
  clipTime.value = formatTime(position);
}

function followClipPlayhead() {
  if (!clipState || clipPreview.paused) return;
  updateClipPlayhead();
  requestAnimationFrame(followClipPlayhead);
}

function setClipPlaying(playing) {
  clipPlay.classList.toggle("is-playing", playing);
  clipPlay.setAttribute("aria-label", playing ? "Pause" : "Play selection");
  clipPlay.title = playing ? "Pause (Space)" : "Play selection (Space)";
}

async function toggleClipPlayback() {
  if (!clipState?.total || clipState.busy) return;
  if (!clipPreview.paused) { clipPreview.pause(); clipState.playing = false; return; }
  const start = Number(clipStart.value), end = Number(clipEnd.value);
  if (clipPreview.currentTime < start || clipPreview.currentTime >= end - 0.05) clipPreview.currentTime = start;
  clipState.playing = true;
  try { await clipPreview.play(); } catch { clipState.playing = false; }
}

// Pressing or dragging on the filmstrip (not on a handle) moves the playhead.
function beginClipScrub(event) {
  if (!clipState?.total || clipState.busy || event.button > 0 || event.target instanceof HTMLInputElement) return;
  clipScrubPointer = event.pointerId; clipRangeTrack.setPointerCapture(event.pointerId);
  clipPreview.pause(); scrubClipTo(event); event.preventDefault();
}
function moveClipScrub(event) { if (event.pointerId === clipScrubPointer) scrubClipTo(event); }
function endClipScrub(event) {
  if (event.pointerId !== clipScrubPointer) return;
  if (clipRangeTrack.hasPointerCapture(event.pointerId)) clipRangeTrack.releasePointerCapture(event.pointerId);
  clipScrubPointer = null;
}
function scrubClipTo(event) {
  const bounds = clipRangeTrack.getBoundingClientRect(), time = clamp((event.clientX - bounds.left) / bounds.width, 0, 1) * clipState.total;
  clipPreview.currentTime = time; updateClipPlayhead(time);
}

function clipKeyDown(event) {
  if (!clipDialog.open || !clipState?.total || clipState.busy || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.defaultPrevented) return;
  const target = event.target;
  if (target?.matches?.("textarea, select, input:not([type=range])")) return;
  if (event.key === " " && !target?.closest?.("button")) { event.preventDefault(); toggleClipPlayback(); return; }
  const letter = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : (/^Key([A-Z])$/.exec(event.code || "")?.[1] || "").toLowerCase();
  if (letter === "i" || letter === "o") { event.preventDefault(); markClipBoundary(letter === "i" ? "start" : "end"); }
}

function selectClipCrop(button) {
  if (!clipState || clipState.busy) return;
  setActiveClipCrop(button.dataset.clipCrop);
  clipState.cropAspect = Number(button.dataset.clipCrop) || 0;
  clipState.cropLabel = button.dataset.cropLabel || "";
  updateClipCropSelection(); renderClipHint();
}

// The cut only matters when the start moved: a clip from 0:00 is copied and
// exact either way, and a crop always re-encodes. The choice is remembered
// for the next clip.
function selectClipCut(value) {
  if (!clipState || clipState.busy) return;
  clipCut = normalizeClipCut(value);
  ext.storage.local.set({ [CLIP_CUT_KEY]: clipCut }).catch(() => {});
  renderClipHint();
}

function clipCutOffered() {
  return Boolean(clipState?.total) && !clipState.cropAspect && Number(clipStart.value) > 0;
}

function setActiveClipCrop(value) {
  document.querySelectorAll("[data-clip-crop]").forEach(button => {
    const active = button.dataset.clipCrop === value;
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
  });
}

// Once the start moved (and nothing is cropped), the hint names the cut and
// offers the other one as a quiet text link.
function renderClipHint() {
  if (clipState?.cropAspect) { clipHint.textContent = "Drag the frame to reposition it, or a corner to resize. Cropping re-encodes the video, which takes about as long as the clip."; return; }
  if (!clipCutOffered()) { clipHint.textContent = "Drag the handles, or press I and O at the playhead, to set the start and end. Trimming keeps the original quality."; return; }
  const fast = clipCut === "fast", other = document.createElement("button");
  other.type = "button"; other.className = "hint-action";
  other.textContent = fast ? "Use a precise cut" : "Use a fast cut";
  other.onclick = () => { selectClipCut(fast ? "precise" : "fast"); clipHint.querySelector(".hint-action")?.focus(); };
  clipHint.replaceChildren(fast
    ? "Fast cut: instant, with the original quality, but starts at the keyframe before your start, often a second or more early. "
    : "Precise cut: starts on the exact frame you chose, and takes about as long as the clip to make. ", other);
}

function updateClipCropSelection() {
  if (!clipState) return;
  const aspect = clipState.cropAspect;
  if (!aspect) { resetClipCropSelection(); return; }
  const width = clipPreview.videoWidth || clipFrame.clientWidth, height = clipPreview.videoHeight || clipFrame.clientHeight;
  if (!width || !height) return;
  const frameAspect = width / height;
  let cropWidth = 1, cropHeight = 1;
  if (frameAspect > aspect) cropWidth = aspect / frameAspect;
  else cropHeight = frameAspect / aspect;
  clipState.cropRect = { x: (1 - cropWidth) / 2, y: (1 - cropHeight) / 2, width: cropWidth, height: cropHeight };
  renderClipCrop();
}

function renderClipCrop() {
  if (!clipState?.cropRect || !clipState.cropAspect) {
    clipCropOverlay.hidden = true; return;
  }
  const rect = clipState.cropRect;
  clipCropBox.style.left = `${rect.x * 100}%`; clipCropBox.style.top = `${rect.y * 100}%`;
  clipCropBox.style.width = `${rect.width * 100}%`; clipCropBox.style.height = `${rect.height * 100}%`;
  clipCropOverlay.hidden = false;
}

function resetClipCropSelection() {
  clipCropGesture = null;
  if (clipState) clipState.cropRect = null;
  clipCropOverlay.hidden = true;
}

function beginClipCropGesture(event) {
  if (!clipState?.cropRect || clipState.busy) return;
  const bounds = clipFrame.getBoundingClientRect(), rect = clipState.cropRect;
  const handle = event.target.closest("[data-crop-handle]")?.dataset.cropHandle || "";
  clipCropGesture = {
    pointerId: event.pointerId, handle, startX: event.clientX, startY: event.clientY,
    rect: { x: rect.x * bounds.width, y: rect.y * bounds.height, width: rect.width * bounds.width, height: rect.height * bounds.height }
  };
  clipCropBox.setPointerCapture(event.pointerId); event.preventDefault();
}

function moveClipCropGesture(event) {
  if (!clipCropGesture || event.pointerId !== clipCropGesture.pointerId || !clipState) return;
  const bounds = clipFrame.getBoundingClientRect(), start = clipCropGesture.rect;
  let next;
  if (!clipCropGesture.handle) {
    next = {
      x: clamp(start.x + event.clientX - clipCropGesture.startX, 0, bounds.width - start.width),
      y: clamp(start.y + event.clientY - clipCropGesture.startY, 0, bounds.height - start.height),
      width: start.width, height: start.height
    };
  } else {
    next = resizedClipCrop(start, clipCropGesture.handle, event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height, clipState.cropAspect);
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
  const bounds = clipFrame.getBoundingClientRect(), rect = clipState.cropRect;
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

async function applyClip() {
  if (!clipState?.total || clipState.busy) return;
  const state = clipState;
  let range;
  try { range = normalizeTrimRange(clipStart.value, clipEnd.value, state.total); }
  catch (error) { clipError.textContent = error.message; return; }
  const cropAspect = state.cropAspect || 0;
  const crop = cropAspect ? videoCropFromNormalized(clipPreview.videoWidth, clipPreview.videoHeight, state.cropRect) : null;
  if (cropAspect && !crop) { clipError.textContent = "The crop area could not be read from the video preview."; return; }
  if (range.start < 0.05 && state.total - range.end < 0.05 && !cropAspect) { closeClipper(); showToast("The full video is already selected."); return; }
  clipPreview.pause();
  setClipBusy(true); clipError.textContent = ""; setClipProgress(0);
  clipOperationActive = true;
  try {
    const item = draft.media[state.index];
    const blob = await trimVideo(item.url, { start: range.start, end: range.end, total: state.total, crop, exact: clipCut === "precise" }, {
      onProgress: value => { if (canCommitClip(state, clipState)) setClipProgress(value); }
    });
    if (!canCommitClip(state, clipState)) return;
    const url = URL.createObjectURL(blob); objectUrls.push(url); releaseObjectUrl(item.url);
    draft.media[state.index] = { ...withoutStoredReference(item), url, local: true, filename: `clip-${Date.now()}.mp4`, trim: range, crop: cropAspect ? state.cropLabel : item.crop };
    setClipBusy(false); renderMedia(); closeClipper(); showToast(`Clip ready · ${formatTime(range.duration)}`);
  } catch (error) {
    if (!canCommitClip(state, clipState)) return;
    clipError.textContent = error instanceof Error ? error.message : "The video could not be clipped.";
    setClipBusy(false);
  } finally {
    clipOperationActive = false;
  }
}

function setClipProgress(value) {
  clipBusy.hidden = value == null; clipHint.hidden = value != null;
  if (value == null) return;
  clipProgress.value = value; clipProgressLabel.textContent = `Creating clip… ${Math.round(value * 100)}%`;
}

async function openImageEditor(index) {
  const item = draft.media[index];
  if (!item || item.kind !== "image" || imageDialog.open) return;
  const attempt = ++imageOpenAttempt;
  imageError.textContent = ""; imageMeta.textContent = ""; imageDelete.hidden = true; imageApply.disabled = true;
  setActiveImageCropPreset("free"); setActiveImageTool("select"); imageHint.textContent = "Loading image…";
  // The canvas can still hold the previously edited picture until this one loads.
  imageStage.classList.add("is-loading");
  imageDialog.showModal();
  let sourceUrl = "";
  try {
    // Fabric.js is ~780 KB; import it only when the editor actually opens so
    // it stays out of the compose page's startup module graph.
    const { DEFAULT_MARKUP_COLOR, FabricImageEditor, markupColor } = await import("./shared/fabric-image-editor.js");
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`Could not load the image (${response.status}).`);
    const blob = await response.blob();
    sourceUrl = URL.createObjectURL(blob);
    const image = await loadEditorImage(sourceUrl);
    if (attempt !== imageOpenAttempt) { URL.revokeObjectURL(sourceUrl); return; }
    const editor = new FabricImageEditor(imageCanvas, {
      onToolChange: setActiveImageTool,
      onSelection: objects => renderImageSelection(objects),
      onHistory: (position, length) => {
        document.querySelector("#imageUndo").disabled = position <= 0;
        document.querySelector("#imageRedo").disabled = position >= length - 1;
        const size = editor.outputSize(); imageMeta.textContent = `${size.width} × ${size.height}`;
      }
    });
    imageState = { index, editor, sourceUrl, type: blob.type, cropPreset: "free", markupColor };
    const stage = innerSize(imageStage);
    await editor.load(image, { maxWidth: stage.width, maxHeight: stage.height });
    setImageColor(DEFAULT_MARKUP_COLOR); setActiveImageTool("select"); imageApply.disabled = false;
    imageStage.classList.remove("is-loading");
  } catch (error) {
    if (attempt !== imageOpenAttempt) return;
    if (sourceUrl && !imageState) URL.revokeObjectURL(sourceUrl);
    closeImageEditor(); showToast(error instanceof Error ? error.message : "The image could not be edited.");
  }
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
  imageOpenAttempt++;
  if (imageState) { imageState.editor.dispose(); URL.revokeObjectURL(imageState.sourceUrl); }
  imageState = null; imageError.textContent = "";
  if (imageDialog.open) imageDialog.close();
}
const IMAGE_TOOL_HINTS = Object.freeze({
  select: "Click an annotation to move, resize, or recolor it.",
  highlight: "Drag across the image to highlight an area.",
  rectangle: "Drag across the image to draw a box.",
  arrow: "Drag from where the arrow starts to what it points at.",
  text: "Click where the label goes, then type.",
  crop: "Drag the frame or its corners. Enter applies the crop; Esc cancels it."
});
function selectImageTool(tool) {
  if (!imageState) return;
  tool === "crop" ? beginImageCrop(imageState.cropPreset) : imageState.editor.setTool(tool);
}
function setActiveImageTool(tool) {
  document.querySelectorAll("[data-image-tool]").forEach(button => {
    const active = button.dataset.imageTool === tool;
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
  });
  imageCropControls.hidden = tool !== "crop"; imageCropActions.hidden = tool !== "crop";
  imageMarkupOptions.hidden = tool === "crop"; imageEditActions.hidden = tool === "crop";
  if (tool !== "select") imageDelete.hidden = true;
  imageHint.textContent = IMAGE_TOOL_HINTS[tool] || "";
}
function renderImageSelection(objects) {
  imageDelete.hidden = !objects.length;
  if (!imageState || imageState.editor.tool !== "select") return;
  imageHint.textContent = objects.length ? "Drag to move it, pull a corner to resize, or pick a new color. Delete removes it." : IMAGE_TOOL_HINTS.select;
  const color = objects.length === 1 ? imageState.markupColor(objects[0]) : "";
  if (color) { imageState.editor.color = color; markImageColor(color); }
}
function setImageColor(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  imageState?.editor.setColor(color);
  markImageColor(color.toLowerCase());
}
function markImageColor(color) {
  imageColor.value = color;
  let preset = false;
  imageSwatches.querySelectorAll("[data-image-color]").forEach(swatch => {
    const active = swatch.dataset.imageColor === color;
    preset ||= active;
    swatch.classList.toggle("active", active); swatch.setAttribute("aria-pressed", String(active));
  });
  const custom = imageColor.closest(".swatch-custom");
  custom.classList.toggle("active", !preset);
  custom.style.setProperty("--swatch", preset ? "" : color);
}
function beginImageCrop(preset = "free") {
  if (!imageState) return;
  imageState.cropPreset = preset;
  setActiveImageCropPreset(preset); imageState.editor.beginCrop(preset);
}
function applyImageCrop() { imageState?.editor.applyCrop(); }
function cancelImageCrop() { imageState?.editor.setTool("select"); }
function setActiveImageCropPreset(preset) {
  document.querySelectorAll("[data-image-crop]").forEach(button => {
    const active = button.dataset.imageCrop === preset;
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
  });
}
function imageKeyDown(event) {
  if (!imageDialog.open || !imageState || event.defaultPrevented) return;
  const editor = imageState.editor, target = event.target;
  if (target?.matches?.("textarea, select, [contenteditable='true'], input:not([type=color])") || editor.isEditingText()) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault(); event.shiftKey ? editor.redo() : editor.undo(); return;
  }
  // Enter applies the crop, also right after picking a shape or tool; other
  // buttons (Cancel crop, Close…) keep their own Enter.
  if (event.key === "Enter" && editor.tool === "crop" && !target?.closest?.("button:not([data-image-crop], [data-image-tool])")) { event.preventDefault(); applyImageCrop(); return; }
  const tool = event.repeat ? "" : imageEditorShortcut(event);
  if (tool) { event.preventDefault(); selectImageTool(tool); }
}
function loadEditorImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("The image preview could not be loaded.")); image.src = url;
  });
}

function setClipBusy(busy) {
  if (!clipState) return;
  clipState.busy = busy;
  for (const element of [clipStart, clipEnd, clipPlay, document.querySelector("#clipMarkStart"), document.querySelector("#clipMarkEnd"), clipApply, ...document.querySelectorAll("[data-clip-crop]")]) element.disabled = busy;
  clipCropBox.dataset.disabled = String(busy);
  clipRangeTrack.classList.toggle("is-busy", busy);
  document.querySelector("#clipCancel").disabled = false;
  document.querySelector("#clipClose").disabled = false;
  if (!busy) setClipProgress(null);
  setHtml(clipApply, busy ? `${icon("refresh")}Creating clip…` : `Use clip${icon("check")}`);
}

function closeClipper() {
  if (clipState) clipState.cancelled = true;
  resetClipCropSelection();
  clipPreview.pause(); clipPreview.removeAttribute("src"); clipPreview.load();
  if (clipDialog.open) clipDialog.close();
  clipState = null; clipError.textContent = ""; setClipProgress(null); setClipPlaying(false); setHtml(clipApply, `Use clip${icon("check")}`);
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
// A clip length for people: "6.2 s" or "1 min 4.5 s".
function formatSeconds(seconds) {
  const safe = Math.max(0, Number(seconds) || 0), minutes = Math.floor(safe / 60), remainder = (safe - minutes * 60).toFixed(1);
  return minutes ? `${minutes} min ${remainder} s` : `${remainder} s`;
}
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(value, maximum)); }
function setHandoffActive(active) {
  const opening = active && handoffOverlay.hidden;
  handoffOverlay.hidden = !active;
  composeMain.inert = active;
  composeTopbar.inert = active;
  document.body.classList.toggle("handoff-active", active);
  if (!active) { handoffCancelError.textContent = ""; handoffFinished = false; }
  // Focus the panel, not its first button: that one closes tabs.
  if (opening) handoffOverlay.querySelector(".handoff-overlay-card").focus({ preventScroll: true });
}

// The status panel shown over the composer once Continue is pressed: one row
// per destination, failures included, and what the user can do next.
function renderHandoffPanel(handoff) {
  const statuses = handoffNetworkStatuses(handoff);
  const summary = handoffSummary(handoff, statuses);
  handoffFinished = summary.finished;
  handoffTitle.textContent = summary.title || "Preparing your crosspost…";
  handoffLead.textContent = summary.lead;
  handoffStatus.replaceChildren(...statuses.map(status => handoffStatusRow(status, {
    openTab: row => focusComposerTab(row.tabId, row.label),
    retry: row => retryDestination(row),
    report: row => openFeedback("error", row.error || row.detail || row.text, row.network)
  })));
  handoffNotice.textContent = [
    ...(handoff.mediaErrors || []).map(error => `Media: ${error}`),
    ...(handoff.groupError ? [`Tab group: ${handoff.groupError}`] : [])
  ].join(" ");
  handoffNew.hidden = !summary.finished;
  if (!handoffCancel.disabled) handoffCancel.textContent = cancelLabel();
  handoffActionsNote.textContent = summary.finished
    ? "Edit and try again closes this crosspost’s composer tabs first."
    : "Cancelling closes this crosspost’s composer tabs.";
}

function cancelLabel() { return handoffFinished ? "Edit and try again" : "Cancel crosspost"; }

async function focusComposerTab(tabId, label) {
  try {
    const tab = await ext.tabs.update(tabId, { active: true });
    if (Number.isInteger(tab?.windowId)) await ext.windows.update(tab.windowId, { focused: true });
  } catch { showToast(`${label}’s tab is no longer open.`); }
}

// Fills one destination again; the panel follows the session updates.
function retryDestination(row) {
  const failed = message => showToast(message || `${row.label} could not be retried.`);
  ext.runtime.sendMessage({ type: "RETRY_NATIVE_HANDOFF", sessionId, network: row.network })
    .then(response => { if (!response?.ok) failed(response?.error); })
    .catch(() => failed());
}

async function startNewPost() {
  const response = await ext.runtime.sendMessage({ type: "OPEN_CROSSPOST_COMPOSER", fresh: true }).catch(() => null);
  if (!response?.ok) showToast(response?.error || "A new composer could not be opened.");
}

async function cancelNativeHandoff() {
  ++publishGeneration;
  const finished = handoffFinished;
  handoffCancel.disabled = true;
  handoffCancel.textContent = finished ? "Closing tabs…" : "Cancelling…";
  handoffCancelError.textContent = "";
  const response = await ext.runtime.sendMessage({ type: "CANCEL_NATIVE_HANDOFF", sessionId, attemptId: activeHandoffAttemptId }).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  handoffCancel.disabled = false;
  handoffCancel.textContent = cancelLabel();
  if (!response?.ok) {
    handoffCancelError.textContent = response?.error || "The crosspost could not be cancelled.";
    return;
  }
  publishBusy = false;
  activeHandoffAttemptId = "";
  document.querySelector("#errors").textContent = "";
  setHandoffActive(false);
  renderPublishAction();
  showToast(finished ? "Composer tabs closed. Edit the post, then continue again." : "Crossposting cancelled. You can continue editing.");
}

async function publish() {
  const errors = validateDraft(draft); const box = document.querySelector("#errors"); box.textContent = errors.join(" "); if (errors.length) return;
  const selected = selectedNativeDestinations(draft), networkIds = selected.map(destination => destination.id), button = document.querySelector("#publish");
  // Request each selected platform's complete page/API/media bundle while the
  // extension-page click still carries a user gesture. Recheck the source too
  // in case its access was revoked while this draft was open.
  const hostPermissionRequest = requestCompletePlatformPermissions(ext.permissions, [draft.sourceNetwork, ...networkIds]);
  // Firefox: sidebarAction.open() only works inside a user-action handler and
  // the gesture does not survive messaging to the background — open the
  // sidebar here, synchronously, while the Continue click is still live.
  // (Chrome routes through sidePanel.open() in the background instead.)
  if (!ext.sidePanel && ext.sidebarAction?.open) ext.sidebarAction.open().catch(() => {});
  const generation = ++publishGeneration;
  const attemptId = crypto.randomUUID();
  activeHandoffAttemptId = attemptId;
  publishBusy = true;
  button.disabled = true;
  setHtml(button, `Preparing…${icon("refresh")}`);
  setHandoffActive(true);
  renderHandoffPanel({ state: "preparing", networks: networkIds });
  // Sidebar APIs require a live user gesture. Open the extension-owned surface
  // before any asynchronous storage or media work, then populate it while the
  // native tabs open.
  // A declined permission prompt is the user's choice, not a problem to report.
  let reportable = false;
  try {
    const permissionResult = await hostPermissionRequest;
    if (!permissionResult.ok) {
      const platforms = permissionResult.missing.map(platformLabel).join(", ");
      throw new Error(permissionResult.error || `Allow every requested permission for ${platforms} before continuing.`);
    }
    reportable = true;
    await openNativeTray(networkIds, attemptId);
  }
  catch (error) {
    if (generation !== publishGeneration) return;
    const message = error instanceof Error ? error.message : String(error);
    box.textContent = message;
    if (reportable) box.append(" ", reportButton(message, "report-link"));
    publishBusy = false; activeHandoffAttemptId = ""; setHandoffActive(false); renderPublishAction(); return;
  }
  if (generation !== publishGeneration) return;
  await saveDraftHistory().catch(error => showToast(error instanceof Error ? error.message : "Draft history could not be saved."));
  if (generation !== publishGeneration) return;
  try {
    const handoff = await startNativeHandoff(networkIds, attemptId);
    if (generation !== publishGeneration || handoff.cancelled) return;
  } catch (error) {
    if (generation !== publishGeneration) return;
    // Shown in the status panel: the composer behind it is inert.
    renderHandoffPanel({ state: "error", error: error instanceof Error ? error.message : String(error), networks: networkIds });
  }
  // The broadcast updates may have been missed; render the final state.
  const settled = await ext.runtime.sendMessage({ type: "GET_CROSSPOST_SESSION", sessionId }).catch(() => null);
  if (generation === publishGeneration && ["ready", "error"].includes(settled?.session?.handoff?.state)) renderHandoffPanel(settled.session.handoff);
  if (generation !== publishGeneration) return;
  publishBusy = false; renderPublishAction();
  // Native composers are deliberately unobservable after handoff: keep the
  // draft available because only the user knows whether they clicked Post.
  await ext.storage.local.set({ pendingDraft: draft });
}
async function openNativeTray(networks, attemptId) {
  const response = await ext.runtime.sendMessage({ type: "OPEN_NATIVE_TRAY", sessionId, attemptId, text: postText(draft), networks });
  if (!response?.ok) throw new Error(response?.error || "Could not open the Crossposter sidebar.");
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
          type: handoffMediaType(blob.type, item.kind),
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
  const response = await ext.runtime.sendMessage({ type: "OPEN_NATIVE_HANDOFF", sessionId, attemptId, networks, handoff: { text: postText(draft), media: prepared, mediaErrors: failures } });
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

// Expired entries are never shown or re-saved; the background sweep deletes
// their stored media.
async function readDraftHistory() {
  const result = await ext.storage.local.get(DRAFT_HISTORY_KEY);
  const { history, expired } = expireDraftHistory(result[DRAFT_HISTORY_KEY]);
  if (expired) await ext.storage.local.set({ [DRAFT_HISTORY_KEY]: history });
  return history;
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
