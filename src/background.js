import { ext } from "./shared/browser.js";
import { createDraft } from "./shared/draft.js";
import { resolveReshareMedia } from "./shared/downloaders.js";
import { nativeDestination } from "./shared/destinations.js";
import { COMPOSER_DELIVERY_RETRY_MS, COMPOSER_DELIVERY_TIMEOUT_MS, COMPOSER_GROUP_APPEARANCE, composerTabProperties, isMissingContentScriptError, shouldRetryCanonicalComposer, shouldRetryComposerDelivery, shouldRetryMediaAttachment, shouldRetryTextInsertion } from "./shared/handoff.js";
import { chooseContextMedia } from "./shared/capture.js";
import { clearHandoffMedia, readHandoffMediaChunk } from "./shared/media-store.js";
import { contentScriptFilesForUrl, PLATFORM_CONTENT_SCRIPTS, platformContentScriptForUrl, platformDocumentUrlPatterns, platformOriginsForIds, registeredPlatformContentScripts } from "./shared/content-scripts.js";
import { DEFAULT_DESTINATIONS_KEY, ENABLED_PLATFORMS_KEY, inlineActionsEnabled, normalizeDefaultDestinations, normalizeEnabledPlatforms, SHOW_INLINE_ACTIONS_KEY } from "./shared/preferences.js";
import { linkedInPublishCandidate } from "./shared/linkedin-monitor.js";
import { linkedInDashManifestRequest, linkedInDashPlaylist, linkedInVhsPlaylist, linkedInVideoRequest, selectLinkedInVideoRequest } from "./platforms/linkedin/network.js";
import { DETECTED_DRAFTS_KEY, detectedBadgeText, enqueueDetectedDraft, removeDetectedDraft } from "./shared/detected-posts.js";
import { CROSSPOST_SESSIONS_KEY, crosspostComposerUrl, recordPostedDestination, resetCrosspostHandoff, sessionForTab, sessionPreview, sessionTabIds } from "./shared/crosspost-sessions.js";
import { markVideoResolving, settleVideoResolution } from "./shared/video-resolution-state.js";
import { resolvePageVideoHint } from "./shared/source-video.js";
import { allPlatformIds, incompletePlatformPermissions, missingSitePlatforms, SITE_ACCESS_DISMISSED_KEY, SITE_ACCESS_PAGE } from "./shared/platform-permissions.js";

const MENU_ID = "crosspost-studio";
let trayWindowId = null;
const scopedSidePanel = Boolean(ext.sidePanel?.setOptions && ext.sidePanel?.open);
let sidePanelOptionsQueue = Promise.resolve();
const nativeSidePanelTabs = new Map();
const nativeSidePanelSourceTabs = new Map();
const nativeSidePanelWindows = new Set();
const pendingNativeTabWindows = new Map();
const crosspostSessions = new Map();
const NATIVE_SIDE_PANEL_TABS_KEY = "crossposterNativeSidePanelTabs";
const nativeSessionStorage = ext.storage.session || ext.storage.local;
let nativeSidePanelStorageQueue = Promise.resolve();
let crosspostSessionStorageQueue = Promise.resolve();
let platformContentScriptSyncQueue = Promise.resolve();
const closingCrosspostWindows = new Set();
const suppressPanelCloseUntil = new Map();
const pendingLinkedInPublishes = new Map();
const linkedInVideoRequests = new Map();
const LINKEDIN_NOTIFICATION_PREFIX = "crossposter-linkedin:";
ext.windows.onRemoved?.addListener(windowId => { if (windowId === trayWindowId) trayWindowId = null; });
ext.tabs.onCreated?.addListener(tab => {
  if (!scopedSidePanel || !nativeSidePanelWindows.has(tab.windowId)) return;
  if ((pendingNativeTabWindows.get(tab.windowId) || 0) > 0) return;
  if ([tab.url, tab.pendingUrl].some(url => String(url || "").startsWith(ext.runtime.getURL("compose.html")))) return;
  setTabSidePanelEnabled(tab.id, false).catch(() => {});
});
ext.tabs.onRemoved?.addListener(tabId => {
  forgetNativeSidePanelTab(tabId);
  linkedInVideoRequests.delete(tabId);
  removeTabFromCrosspostSessions(tabId).catch(() => {});
});
ext.tabs.onActivated?.addListener(activeInfo => noteActiveCrosspostTab(activeInfo).catch(() => {}));
ext.sidePanel?.onClosed?.addListener(info => closeComposerTabsForPanel(info, false).catch(() => {}));
// Buffer/account settings are obsolete in the native-composer model. Remove
// any previously stored token/profile data when the rebuilt worker starts.
ext.storage.local.remove("settings").catch?.(() => {});
refreshDetectedBadge().catch(() => {});
synchronizePlatformContentScripts().catch(error => console.warn("Crossposter content-script registration failed:", error));
const backgroundStateReady = Promise.all([restoreNativeSidePanelState(), restoreCrosspostSessions()]);
backgroundStateReady.then(() => {
  if (scopedSidePanel) setDefaultSidePanelEnabled(Boolean(nativeSidePanelTabs.size)).catch(() => {});
}).catch(() => {
  if (scopedSidePanel) setDefaultSidePanelEnabled(false).catch(() => {});
});

if (ext.webRequest?.onBeforeRequest) {
  const filter = { urls: ["https://www.linkedin.com/voyager/api/*"], types: ["xmlhttprequest", "other"] };
  ext.webRequest.onBeforeRequest.addListener(details => {
    const candidate = linkedInPublishCandidate(details);
    if (!candidate) return;
    pruneLinkedInCandidates();
    pendingLinkedInPublishes.set(candidate.requestId, candidate);
    const armed = ext.tabs.sendMessage(candidate.tabId, { type: "ARM_LINKEDIN_POST_DETECTION", candidate });
    armed?.catch?.(() => {});
  }, filter, ["requestBody"]);
  ext.webRequest.onCompleted.addListener(details => {
    const candidate = pendingLinkedInPublishes.get(String(details.requestId));
    if (!candidate) return;
    pendingLinkedInPublishes.delete(String(details.requestId));
    if (details.statusCode >= 200 && details.statusCode < 300) handleLinkedInPublishCompleted(candidate).catch(error => console.warn("Crossposter LinkedIn detection failed:", error));
  }, filter);
  ext.webRequest.onErrorOccurred.addListener(details => pendingLinkedInPublishes.delete(String(details.requestId)), filter);

  const videoFilter = { urls: ["https://*.licdn.com/*"], types: ["media", "xmlhttprequest", "other"] };
  ext.webRequest.onBeforeRequest.addListener(details => {
    const request = linkedInVideoRequest(details.url);
    if (!request || !Number.isInteger(details.tabId) || details.tabId < 0) return;
    const previous = linkedInVideoRequests.get(details.tabId) || [];
    const entries = [{ url: request.url, time: Date.now() }, ...previous.filter(entry => entry.url !== request.url)].slice(0, 40);
    linkedInVideoRequests.set(details.tabId, entries);
  }, videoFilter);
}

ext.runtime.onInstalled.addListener(async details => {
  await ext.contextMenus.removeAll();
  await ext.contextMenus.create({
    id: MENU_ID,
    title: "Crosspost",
    contexts: ["page", "selection", "link", "image", "video"],
    documentUrlPatterns: platformDocumentUrlPatterns()
  });
  const enabled = await synchronizePlatformContentScripts().catch(error => {
    console.warn("Crossposter content-script registration failed:", error);
    return [];
  });
  await reinjectOpenPlatformTabs(enabled);
  // A fresh install or update is a new chance to ask: forget an earlier "not now".
  if (details?.reason === "install" || details?.reason === "update") await ext.storage.local.remove(SITE_ACCESS_DISMISSED_KEY).catch(() => {});
  await promptForMissingSiteAccess();
});
ext.runtime.onStartup?.addListener(async () => {
  const enabled = await synchronizePlatformContentScripts().catch(error => {
    console.warn("Crossposter content-script registration failed:", error);
    return [];
  });
  await reinjectOpenPlatformTabs(enabled);
  await promptForMissingSiteAccess();
});
// Host access granted later (welcome page, popup, compose, or about:addons)
// must bring already-open platform tabs back to life without a reload.
ext.permissions?.onAdded?.addListener(async () => {
  const enabled = await synchronizePlatformContentScripts().catch(() => []);
  await reinjectOpenPlatformTabs(enabled);
});

async function siteAccessPageTab() {
  const url = ext.runtime.getURL(SITE_ACCESS_PAGE);
  const tabs = await ext.tabs.query({}).catch(() => []);
  return tabs.find(tab => typeof tab.url === "string" && tab.url.startsWith(url)) || null;
}

async function openSiteAccessPage({ focus = true } = {}) {
  const existing = await siteAccessPageTab();
  if (existing && Number.isInteger(existing.id)) {
    if (focus) {
      await ext.tabs.update(existing.id, { active: true }).catch(() => {});
      if (Number.isInteger(existing.windowId)) await ext.windows?.update?.(existing.windowId, { focused: true }).catch(() => {});
    }
    return existing;
  }
  return ext.tabs.create({ url: ext.runtime.getURL(SITE_ACCESS_PAGE), active: focus });
}

// Firefox MV3 treats host permissions as optional and never grants hosts
// added by an update, so the extension asks for the complete set itself
// right after installation instead of failing silently on the first post.
async function promptForMissingSiteAccess() {
  try {
    if (!ext.permissions?.contains) return;
    const missing = await missingSitePlatforms(ext.permissions, ext.runtime.getManifest());
    if (!missing.length) return;
    const stored = await ext.storage.local.get(SITE_ACCESS_DISMISSED_KEY);
    if (stored[SITE_ACCESS_DISMISSED_KEY]) return;
    await openSiteAccessPage();
  } catch (error) {
    console.warn("Crossposter site-access prompt failed:", error);
  }
}

ext.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[ENABLED_PLATFORMS_KEY]) synchronizePlatformContentScripts().catch(error => console.warn("Crossposter content-script registration failed:", error));
  if (changes[SHOW_INLINE_ACTIONS_KEY]) broadcastInlineActionPreference(inlineActionsEnabled(changes[SHOW_INLINE_ACTIONS_KEY].newValue)).catch(() => {});
});

ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  // The menu click is a user action, so the browser accepts a permission
  // request here as long as nothing is awaited first. When the site is already
  // allowed this resolves silently; otherwise the user sees one prompt on the
  // page itself instead of a dead composer.
  const gesture = requestSourceAccessInGesture(platformContentScriptForUrl(tab?.url || tab?.pendingUrl || "")?.platformId);
  handleCrosspostMenuClick(info, tab, gesture).catch(error => console.warn("Crossposter capture failed:", error));
});

function requestSourceAccessInGesture(platformId) {
  if (!platformId || !ext.permissions?.request) return Promise.resolve(null);
  if (!allPlatformIds(ext.runtime.getManifest()).includes(platformId)) return Promise.resolve(null);
  try {
    return Promise.resolve(ext.permissions.request({ origins: platformOriginsForIds([platformId]) })).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

async function handleCrosspostMenuClick(info, tab, gesture) {
  await gesture;
  let captured = {};
  // LinkedIn can render its feed in a same-origin preload frame. Address the
  // frame that actually received the context-menu click so capture does not
  // fall back to the top document and mix several posts together.
  const frameId = Number.isInteger(info.frameId) ? info.frameId : undefined;
  try { captured = await sendContentMessage(tab.id, { type: "CAPTURE_POST" }, frameId) || {}; } catch {}
  const media = chooseContextMedia(info, captured);
  const videoHint = media.some(item => item.kind === "video")
    ? capturedVideoHint(tab, frameId)
    : null;
  await openCapturedPost({
    ...captured,
    text: info.selectionText || captured.text || "",
    // Prefer the post permalink discovered by the content script over a feed
    // page URL supplied by the context-menu event.
    sourceUrl: captured.sourceUrl || info.pageUrl || tab.url,
    media
  }, videoHint, { windowId: tab?.windowId, openerTabId: tab?.id });
}

async function capturedVideoHint(tab, frameId) {
  const platform = platformContentScriptForUrl(tab?.url || tab?.pendingUrl || "");
  const resolved = await resolvePageVideoHint(platform?.platformId, { ext, tab, frameId }).catch(() => null);
  if (resolved?.src) return resolved;
  const hint = await sendContentMessage(tab.id, { type: "VIDEO_INFO" }, frameId);
  return resolvedLinkedInVideoHint(tab.id, hint, frameId);
}

async function sendContentMessage(tabId, message, frameId) {
  const options = Number.isInteger(frameId) ? { frameId } : undefined;
  try {
    return await ext.tabs.sendMessage(tabId, message, options);
  } catch (error) {
    // Reloading an unpacked extension invalidates content scripts already
    // running in open tabs. Reinject once under the activeTab grant from the
    // context-menu click, then retry instead of silently opening an empty draft.
    if (!await reinjectContentScripts(tabId, frameId)) throw error;
    return ext.tabs.sendMessage(tabId, message, options);
  }
}

async function reinjectContentScripts(tabId, frameId) {
  if (!ext.scripting?.executeScript) return false;
  const tab = await ext.tabs.get(tabId);
  const preferences = await readPlatformPreferences();
  const files = contentScriptFilesForUrl(tab.url, preferences.enabledPlatforms);
  if (!files.length) return false;
  const platform = platformContentScriptForUrl(tab.url);
  const target = {
    tabId,
    ...(Number.isInteger(frameId) ? { frameIds: [frameId] } : platform?.allFrames ? { allFrames: true } : {})
  };
  await ext.scripting.executeScript({ target, files });
  return true;
}

// Composer messages go to every frame of the tab, and only the frame that
// renders the platform UI answers. Keep asking until one does: the tab reports
// "complete" before that frame's content script (or the UI itself) exists.
async function sendComposerMessage(tabId, message) {
  const deadline = Date.now() + COMPOSER_DELIVERY_TIMEOUT_MS;
  let reinjected = false;
  let reinjectionError = null;
  for (;;) {
    let response, error = null;
    try { response = await ext.tabs.sendMessage(tabId, message); }
    catch (caught) { error = caught; }
    if (!shouldRetryComposerDelivery(response, error)) {
      if (error) throw error;
      return response;
    }
    if (error && !reinjected && isMissingContentScriptError(error)) {
      reinjected = true;
      try {
        if (await reinjectContentScripts(tabId)) {
          continue;
        }
      } catch (caught) {
        reinjectionError = caught;
      }
    }
    if (Date.now() >= deadline) break;
    await delay(COMPOSER_DELIVERY_RETRY_MS);
  }
  // No frame claimed the composer in time: make the top document answer so
  // the user gets its manual-fallback guidance instead of a silent timeout.
  try { return await ext.tabs.sendMessage(tabId, { ...message, force: true }, { frameId: 0 }); }
  catch (error) { throw reinjectionError || error; }
}

async function readPlatformPreferences() {
  const stored = await ext.storage.local.get([ENABLED_PLATFORMS_KEY, SHOW_INLINE_ACTIONS_KEY, DEFAULT_DESTINATIONS_KEY]);
  return {
    enabledPlatforms: normalizeEnabledPlatforms(stored[ENABLED_PLATFORMS_KEY]),
    showInlineActions: inlineActionsEnabled(stored[SHOW_INLINE_ACTIONS_KEY]),
    defaultDestinations: normalizeDefaultDestinations(stored[DEFAULT_DESTINATIONS_KEY])
  };
}

function synchronizePlatformContentScripts(enabledPlatforms) {
  platformContentScriptSyncQueue = platformContentScriptSyncQueue.catch(() => {}).then(async () => {
    const enabled = normalizeEnabledPlatforms(enabledPlatforms ?? (await readPlatformPreferences()).enabledPlatforms);
    const managedIds = new Set(PLATFORM_CONTENT_SCRIPTS.map(script => script.id));
    const registered = await ext.scripting.getRegisteredContentScripts();
    const existingIds = registered.map(script => script.id).filter(id => managedIds.has(id));
    if (existingIds.length) await ext.scripting.unregisterContentScripts({ ids: existingIds });
    const desired = registeredPlatformContentScripts(enabled);
    if (desired.length) await ext.scripting.registerContentScripts(desired);
    return enabled;
  });
  return platformContentScriptSyncQueue;
}

async function reinjectOpenPlatformTabs(enabledPlatforms) {
  if (!ext.scripting?.executeScript) return;
  const enabled = new Set(enabledPlatforms || []);
  const tabs = await ext.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    if (!Number.isInteger(tab.id)) return;
    const platform = platformContentScriptForUrl(tab.url || tab.pendingUrl || "");
    if (!platform || platform.activeTabOnly || (!platform.sourceOnly && !enabled.has(platform.platformId))) return;
    const target = { tabId: tab.id, ...(platform.allFrames ? { allFrames: true } : {}) };
    await ext.scripting.executeScript({ target, files: ["content.js", platform.file] }).catch(() => {});
  }));
}

async function applyPlatformPreferences(message) {
  const previous = await readPlatformPreferences();
  const enabledPlatforms = normalizeEnabledPlatforms(message.enabledPlatforms);
  const showInlineActions = inlineActionsEnabled(message.showInlineActions);
  const defaultDestinations = normalizeDefaultDestinations(message.defaultDestinations);
  await ext.storage.local.set({
    [ENABLED_PLATFORMS_KEY]: enabledPlatforms,
    [SHOW_INLINE_ACTIONS_KEY]: showInlineActions,
    [DEFAULT_DESTINATIONS_KEY]: defaultDestinations
  });
  await synchronizePlatformContentScripts(enabledPlatforms);
  await reconcileOpenPlatformTabs(previous.enabledPlatforms, enabledPlatforms, showInlineActions);
  return { enabledPlatforms, showInlineActions, defaultDestinations };
}

async function reconcileOpenPlatformTabs(previousEnabled, enabledPlatforms, showInlineActions) {
  const previous = new Set(previousEnabled), enabled = new Set(enabledPlatforms);
  const tabs = await ext.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    if (!Number.isInteger(tab.id)) return;
    const platform = platformContentScriptForUrl(tab.url || tab.pendingUrl || "");
    if (!platform) return;
    if (platform.activeTabOnly) return;
    if (!platform.sourceOnly && !enabled.has(platform.platformId)) {
      if (previous.has(platform.platformId)) {
        await ext.tabs.sendMessage(tab.id, { type: "DISABLE_CROSSPOSTER" }).catch(() => {});
        if (platform.allFrames) {
          await ext.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: () => { try { globalThis.CrossposterContent?.dispose?.(); } catch {} }
          }).catch(() => {});
        }
      }
      return;
    }
    if (platform.sourceOnly || !previous.has(platform.platformId)) {
      await ext.scripting.executeScript({ target: { tabId: tab.id, ...(platform.allFrames ? { allFrames: true } : {}) }, files: ["content.js", platform.file] }).catch(() => {});
    }
    await ext.tabs.sendMessage(tab.id, { type: "SET_INLINE_ACTIONS", enabled: showInlineActions }).catch(() => {});
  }));
}

async function broadcastInlineActionPreference(enabled) {
  const preferences = await readPlatformPreferences();
  const tabs = await ext.tabs.query({});
  await Promise.all(tabs.map(tab => {
    const platform = platformContentScriptForUrl(tab.url || tab.pendingUrl || "");
    if (!platform || !preferences.enabledPlatforms.includes(platform.platformId) || !Number.isInteger(tab.id)) return null;
    return ext.tabs.sendMessage(tab.id, { type: "SET_INLINE_ACTIONS", enabled }).catch(() => {});
  }));
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_PLATFORM_PREFERENCES") {
    readPlatformPreferences().then(preferences => sendResponse({ ok: true, ...preferences })).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "APPLY_PLATFORM_PREFERENCES") {
    applyPlatformPreferences(message).then(preferences => sendResponse({ ok: true, ...preferences })).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "OPEN_CAPTURED_POST") {
    const captured = message.draft || {};
    const media = Array.isArray(captured.media) ? captured.media : [];
    const videoHint = media.some(item => item.kind === "video")
      ? resolvedLinkedInVideoHint(sender.tab?.id, message.videoHint || {}, sender.frameId)
      : null;
    openCapturedPost({ ...captured, media }, videoHint, { windowId: sender.tab?.windowId, openerTabId: sender.tab?.id })
      .then(session => sendResponse({ ok: true, sessionId: session.id, deferred: session.deferred === true }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "RESUME_PENDING_CAPTURE") {
    resumePendingCapture(String(message.token || ""), sender.tab?.id)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "CANCEL_PENDING_CAPTURE") {
    cancelPendingCapture(String(message.token || ""))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "NATIVE_TRAY_CLOSED") {
    closeComposerTabsForPanel({ path: "tray.html", windowId: message.windowId }, true).catch(() => {});
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "OPEN_SITE_ACCESS_PAGE") {
    openSiteAccessPage()
      .then(tab => sendResponse({ ok: true, tabId: tab?.id }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "OPEN_CROSSPOST_COMPOSER") {
    openCrosspostComposer(createDraft(message.draft || {}), { fresh: message.fresh === true, showOnboarding: message.showOnboarding === true, showSettings: message.showSettings === true, windowId: sender.tab?.windowId, openerTabId: sender.tab?.id })
      .then(session => sendResponse({ ok: true, sessionId: session.id, tabId: session.sourceTabId, tabGroupId: session.groupId }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "GET_CROSSPOST_SESSION") {
    getCrosspostSession(message.sessionId)
      .then(session => sendResponse({ ok: Boolean(session), session }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "REGISTER_NATIVE_TRAY_TAB") {
    if (!scopedSidePanel || !Number.isInteger(sender.tab?.id)) {
      sendResponse({ ok: true });
      return;
    }
    registerCrosspostComposer(message.sessionId, sender.tab)
      .then(session => prepareNativeSidePanelWindow(sender.tab).then(() => session))
      .then(session => sendResponse({ ok: true, sessionId: session?.id || message.sessionId || "" }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "GET_DETECTED_DRAFTS") {
    ext.storage.local.get(DETECTED_DRAFTS_KEY)
      .then(stored => sendResponse({ ok: true, drafts: stored[DETECTED_DRAFTS_KEY] || [] }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "OPEN_DETECTED_DRAFT") {
    openDetectedDraft(message.id)
      .then(opened => sendResponse({ ok: opened }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "GET_HANDOFF_MEDIA_CHUNK") {
    readHandoffMediaChunk(message.mediaId, message.offset, message.length)
      .then(chunk => sendResponse({ ok: true, ...chunk }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "GET_NATIVE_TAB_STATUS") {
    nativeTabPostStatus(sender.tab?.id)
      .then(posted => sendResponse({ ok: true, posted }))
      .catch(() => sendResponse({ ok: true, posted: false }));
    return true;
  }
  if (message?.type === "NATIVE_POST_CONFIRMED") {
    markNativePostForTab(sender.tab?.id, message.network, "composer-dismissed-v1")
      .then(posted => sendResponse({ ok: true, posted }))
      .catch(error => sendResponse({ ok: false, posted: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "GET_CROSSPOST_SESSIONS" || message?.type === "GET_NATIVE_HANDOFF") {
    crosspostSessionPayload(message.windowId)
      .then(payload => sendResponse({ ok: true, ...payload, handoff: payload.sessions.find(item => item.id === payload.activeSessionId)?.handoff || { state: "idle" } }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "RESUME_CAPTURED_VIDEO") {
    resumeCapturedVideoResolution(message.sessionId, sender.tab?.id)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "ACTIVATE_CROSSPOST_SESSION") {
    activateCrosspostSession(message.sessionId)
      .then(tab => sendResponse({ ok: true, tabId: tab?.id }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "CLOSE_CROSSPOST_SESSION") {
    closeCrosspostSession(message.sessionId)
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "CANCEL_NATIVE_HANDOFF") {
    cancelNativeHandoff(message.sessionId, message.attemptId)
      .then(closedTabs => sendResponse({ ok: true, closedTabs }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "CLEAR_ALL_CROSSPOSTER_DATA") {
    clearAllCrossposterData(message.sessionId, sender.tab)
      .then(closedTabs => sendResponse({ ok: true, closedTabs }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "OPEN_NATIVE_TRAY") {
    // sidePanel.open() must be invoked synchronously while Chrome still carries
    // the Compose button's user activation through this message handler.
    const surface = openTraySurface(sender);
    Promise.all([
      surface,
      prepareCrosspostHandoff(message.sessionId, message.attemptId, message.text, message.networks, sender.tab)
    ])
      .then(([openedSurface]) => sendResponse({ ok: true, surface: openedSurface }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "OPEN_NATIVE_HANDOFF") {
    openNativeHandoffs(message.sessionId, message.attemptId, message.networks, message.handoff, sender.tab?.windowId, sender.tab?.id)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => markCrosspostError(message.sessionId, error, message.attemptId).then(message => sendResponse({ ok: false, error: message })));
    return true;
  }
});

function linkedInNetworkVideoHint(tabId, hint = {}) {
  if (hint.source !== "linkedin" || !Number.isInteger(tabId)) return hint;
  const selected = selectLinkedInVideoRequest(linkedInVideoRequests.get(tabId) || [], hint.assetId || "");
  if (!selected || hint.sources) return hint;
  return {
    ...hint,
    sources: JSON.stringify([{
      src: selected.url,
      type: selected.container === "hls" ? "application/x-mpegURL" : "video/mp4",
      "data-bitrate": 0
    }])
  };
}

async function resolvedLinkedInVideoHint(tabId, hint = {}, frameId) {
  if (hint.source !== "linkedin" || !Number.isInteger(tabId) || hint.sources) return linkedInNetworkVideoHint(tabId, hint);
  try {
    const target = { tabId, ...(Number.isInteger(frameId) ? { frameIds: [frameId] } : {}) };
    const results = await ext.scripting.executeScript({
      target,
      world: "MAIN",
      args: [hint.assetId || "", hint.playerId || ""],
      func: (expectedAssetId, expectedPlayerId) => {
        const assetIdFrom = value => String(value || "").match(/\/playlist\/vid\/(?:v\d+|dash)\/([^/\"')]+)/i)?.[1]
          || String(value || "").match(/\/dms\/image\/v\d+\/([^/\"')]+)\/videocover-/i)?.[1]
          || "";
        const candidates = [...document.querySelectorAll("video")].map(video => {
          const playerElement = video.closest("[data-vjs-player], .video-js") || video.parentElement;
          const player = playerElement?.player;
          return {
            playerId: playerElement?.id || video.id || "",
            assetId: assetIdFrom(playerElement?.outerHTML),
            cacheSource: typeof player?.cache_?.src === "string" ? player.cache_.src : ""
          };
        }).filter(candidate => candidate.cacheSource.startsWith("data:application/vnd.videojs.vhs+json,")
          || /^https:\/\/[^/]*\.licdn\.com\/playlist\/vid\/dash\//i.test(candidate.cacheSource));
        return candidates.find(candidate => expectedPlayerId && candidate.playerId === expectedPlayerId)
          || candidates.find(candidate => expectedAssetId && candidate.assetId === expectedAssetId)
          || (candidates.length === 1 ? candidates[0] : null);
      }
    });
    const player = results.map(result => result?.result).find(Boolean);
    const cacheSource = player?.cacheSource || "";
    let playlist = linkedInVhsPlaylist(cacheSource, hint.assetId || player?.assetId || "");
    const dash = linkedInDashManifestRequest(cacheSource);
    if (!playlist && dash) {
      const response = await fetch(dash.url);
      if (!response.ok) throw new Error(`LinkedIn's video manifest could not be downloaded (${response.status}).`);
      playlist = linkedInDashPlaylist(await response.text(), dash.url, hint.assetId || player?.assetId || dash.assetId);
    }
    if (playlist) {
      return {
        ...hint,
        assetId: hint.assetId || playlist.assetId,
        sources: JSON.stringify([{
          src: playlist.url,
          type: "application/x-mpegURL",
          "data-bitrate": playlist.bandwidth
        }])
      };
    }
  } catch {}
  return linkedInNetworkVideoHint(tabId, hint);
}

ext.notifications?.onClicked?.addListener(notificationId => {
  if (notificationId.startsWith(LINKEDIN_NOTIFICATION_PREFIX)) openDetectedDraft(notificationId.slice(LINKEDIN_NOTIFICATION_PREFIX.length)).catch(() => {});
});
ext.notifications?.onButtonClicked?.addListener((notificationId, buttonIndex) => {
  if (buttonIndex === 0 && notificationId.startsWith(LINKEDIN_NOTIFICATION_PREFIX)) openDetectedDraft(notificationId.slice(LINKEDIN_NOTIFICATION_PREFIX.length)).catch(() => {});
});

async function confirmLinkedInPost(candidate) {
  await delay(700);
  const response = await sendContentMessage(candidate.tabId, { type: "DETECT_LINKEDIN_POST", candidate });
  if (!response?.ok || !response.captured) return false;
  const captured = response.captured;
  const media = Array.isArray(captured.media) ? captured.media : [];
  const draft = createDraft({ ...captured, media, sourceIsOwn: true, detectedAt: Date.now() });
  const stored = await ext.storage.local.get(DETECTED_DRAFTS_KEY);
  const result = enqueueDetectedDraft(stored[DETECTED_DRAFTS_KEY], draft);
  if (!result.added) return false;
  await ext.storage.local.set({ [DETECTED_DRAFTS_KEY]: result.queue });
  await refreshDetectedBadge(result.queue);
  try {
    await ext.notifications?.create(`${LINKEDIN_NOTIFICATION_PREFIX}${draft.id}`, {
      type: "basic",
      iconUrl: ext.runtime.getURL("icons/icon-128.png"),
      title: "New LinkedIn post detected",
      message: draft.text ? `${draft.text.slice(0, 150)}${draft.text.length > 150 ? "…" : ""}` : "Your new media post is ready to crosspost.",
      buttons: [{ title: "Open in Crossposter" }]
    });
  } catch {}
  return true;
}

async function handleLinkedInPublishCompleted(candidate) {
  const marked = await markNativePostForTab(candidate.tabId, "linkedin", "linkedin-publish-response-v1");
  if (marked) {
    const sent = ext.tabs.sendMessage(candidate.tabId, { type: "MARK_NATIVE_POSTED" });
    sent?.catch?.(() => {});
    return true;
  }
  return confirmLinkedInPost(candidate);
}

async function openDetectedDraft(id) {
  const stored = await ext.storage.local.get(DETECTED_DRAFTS_KEY);
  const queue = stored[DETECTED_DRAFTS_KEY] || [];
  const draft = queue.find(item => item?.id === id);
  if (!draft) return false;
  const remaining = removeDetectedDraft(queue, id);
  await ext.storage.local.set({ [DETECTED_DRAFTS_KEY]: remaining });
  await refreshDetectedBadge(remaining);
  try { await ext.notifications?.clear(`${LINKEDIN_NOTIFICATION_PREFIX}${id}`); } catch {}
  const video = draft.media.find(item => item?.kind === "video");
  const videoHint = video ? { source: "linkedin", sources: video.sources || null, src: video.url || "" } : null;
  await openCapturedPost(draft, videoHint);
  return true;
}

async function refreshDetectedBadge(queue) {
  if (!queue) {
    const stored = await ext.storage.local.get(DETECTED_DRAFTS_KEY);
    queue = stored[DETECTED_DRAFTS_KEY] || [];
  }
  await ext.action?.setBadgeBackgroundColor?.({ color: "#111111" });
  await ext.action?.setBadgeText?.({ text: detectedBadgeText(queue.length) });
  await ext.action?.setTitle?.({ title: queue.length ? `${queue.length} detected post${queue.length === 1 ? "" : "s"} ready in Crossposter` : "Open Crossposter" });
}

function pruneLinkedInCandidates() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [requestId, candidate] of pendingLinkedInPublishes) if (candidate.detectedAt < cutoff) pendingLinkedInPublishes.delete(requestId);
}

const PENDING_CAPTURES_KEY = "crossposterPendingCaptures";

async function readPendingCaptures() {
  const stored = await nativeSessionStorage.get(PENDING_CAPTURES_KEY);
  return stored[PENDING_CAPTURES_KEY] && typeof stored[PENDING_CAPTURES_KEY] === "object" ? stored[PENDING_CAPTURES_KEY] : {};
}

async function writePendingCaptures(pending) {
  await nativeSessionStorage.set({ [PENDING_CAPTURES_KEY]: pending });
}

function sourceAccessPlatform(draft) {
  return allPlatformIds(ext.runtime.getManifest()).includes(draft?.sourceNetwork) ? draft.sourceNetwork : null;
}

// Park the capture and let the site-access page ask for the source platform's
// hosts before the composer exists, so it never opens with media it cannot
// resolve. The page resumes the capture once access is granted.
async function deferCaptureForSiteAccess(captured, videoHint, options, platformId) {
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pending = await readPendingCaptures();
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [key, entry] of Object.entries(pending)) if (!entry || entry.createdAt < cutoff) delete pending[key];
  pending[token] = {
    captured,
    videoHint: await Promise.resolve(videoHint).catch(() => null),
    windowId: Number.isInteger(options.windowId) ? options.windowId : null,
    openerTabId: Number.isInteger(options.openerTabId) ? options.openerTabId : null,
    platformId,
    createdAt: Date.now()
  };
  await writePendingCaptures(pending);
  const url = `${ext.runtime.getURL(SITE_ACCESS_PAGE)}?resume=${encodeURIComponent(token)}&platform=${encodeURIComponent(platformId)}`;
  const tab = await ext.tabs.create({ url, active: true, ...(Number.isInteger(options.windowId) ? { windowId: options.windowId } : {}) });
  return { id: null, deferred: true, token, tabId: tab.id };
}

async function resumePendingCapture(token, senderTabId) {
  const pending = await readPendingCaptures();
  const entry = pending[token];
  if (!entry) throw new Error("This crosspost is no longer waiting. Right-click the post and choose Crosspost again.");
  const missing = await incompletePlatformPermissions(ext.permissions, [entry.platformId]);
  if (missing.length) return { ok: false, missing };
  delete pending[token];
  await writePendingCaptures(pending);
  const session = await openCapturedPost(entry.captured, entry.videoHint, { windowId: entry.windowId ?? undefined, openerTabId: entry.openerTabId ?? undefined, skipAccessGate: true });
  if (Number.isInteger(senderTabId)) ext.tabs.remove(senderTabId).catch(() => {});
  return { ok: true, sessionId: session.id };
}

async function cancelPendingCapture(token) {
  const pending = await readPendingCaptures();
  if (pending[token]) {
    delete pending[token];
    await writePendingCaptures(pending);
  }
}

async function openCapturedPost(captured = {}, videoHint, options = {}) {
  const media = Array.isArray(captured.media) ? captured.media : [];
  if (!options.skipAccessGate) {
    const platformId = sourceAccessPlatform(createDraft({ ...captured, media }));
    if (platformId && (await incompletePlatformPermissions(ext.permissions, [platformId])).length) {
      return deferCaptureForSiteAccess(captured, videoHint, options, platformId);
    }
  }
  const hasVideo = media.some(item => item?.kind === "video");
  if (!hasVideo) return openCrosspostComposer(createDraft({ ...captured, media }), options);

  const draft = createDraft({ ...captured, media });
  const resolutionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const permissionsComplete = !(await incompletePlatformPermissions(ext.permissions, [draft.sourceNetwork])).length;
  const pendingVideoResolution = permissionsComplete ? null : {
    resolutionId,
    hint: await Promise.resolve(videoHint || {})
  };
  const session = await openCrosspostComposer({
    ...draft,
    media: markVideoResolving(media, resolutionId)
  }, { ...options, pendingVideoResolution });

  if (permissionsComplete) startCapturedVideoResolution(session.id, resolutionId, media, videoHint);
  return session;
}

function startCapturedVideoResolution(sessionId, resolutionId, media, videoHint) {
  return Promise.resolve(videoHint)
    .then(hint => resolveReshareMedia(media, hint || {}))
    .then(
      resolved => ({ resolvedItem: resolved.find(item => item?.kind === "video"), error: "" }),
      error => ({
        resolvedItem: null,
        error: error instanceof Error ? error.message : "The video could not be located."
      })
    )
    .then(result => settleCapturedVideo(sessionId, resolutionId, result.resolvedItem, result.error))
    .catch(() => {});
}

async function resumeCapturedVideoResolution(sessionId, tabId) {
  const session = await requireCrosspostSession(sessionId, tabId);
  const pending = session.pendingVideoResolution;
  if (!pending) return { resumed: false, media: session.draft.media };
  const missing = await incompletePlatformPermissions(ext.permissions, [session.draft.sourceNetwork]);
  if (missing.length) throw new Error(`Allow Crossposter full access to ${session.draft.sourceNetwork} before continuing.`);
  session.pendingVideoResolution = null;
  session.updatedAt = Date.now();
  await persistCrosspostSessions();
  // Keep the runtime message event alive until lookup settles. Firefox may
  // suspend the background page once an immediate response is sent, leaving
  // the Compose card permanently marked as resolving.
  await startCapturedVideoResolution(session.id, pending.resolutionId, session.draft.media, pending.hint);
  return { resumed: true, media: session.draft.media };
}

async function settleCapturedVideo(sessionId, resolutionId, resolvedItem, error = "") {
  const session = crosspostSessions.get(sessionId);
  if (!session) return;
  const media = settleVideoResolution(session.draft.media, resolutionId, resolvedItem, error);
  if (media === session.draft.media) return;
  session.draft = { ...session.draft, media };
  session.updatedAt = Date.now();
  await persistCrosspostSessions();
  if (Number.isInteger(session.sourceTabId)) {
    const sent = ext.runtime.sendMessage({
      type: "CAPTURED_VIDEO_RESOLVED",
      sessionId,
      resolutionId,
      resolvedItem: resolvedItem || null,
      error
    });
    await sent?.catch?.(() => {});
  }
  notifyTray();
}

// Place the composer right after the tab Crossposter was invoked on (or the
// active tab of that window) so its tab group forms beside the source post
// instead of at the far end of the tab strip.
async function composerTabPlacement(openerTabId, windowId) {
  try {
    const opener = Number.isInteger(openerTabId)
      ? await ext.tabs.get(openerTabId)
      : (await ext.tabs.query({ active: true, ...(Number.isInteger(windowId) ? { windowId } : { lastFocusedWindow: true }) }))[0];
    if (!opener || !Number.isInteger(opener.index)) return {};
    if (Number.isInteger(windowId) && opener.windowId !== windowId) return {};
    return { index: opener.index + 1, windowId: opener.windowId };
  } catch {
    return {};
  }
}

async function openCrosspostComposer(draftInput = {}, { fresh = false, showOnboarding = false, showSettings = false, windowId, openerTabId, pendingVideoResolution = null } = {}) {
  await backgroundStateReady.catch(() => {});
  const draft = createDraft(draftInput);
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const session = {
    id,
    draft,
    fresh,
    windowId: Number.isInteger(windowId) ? windowId : null,
    groupId: null,
    sourceTabId: null,
    tabIds: [],
    lastActiveTabId: null,
    pendingVideoResolution,
    handoff: { state: "idle", text: draft.text || "", media: [], networks: [] },
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  crosspostSessions.set(id, session);
  await persistCrosspostSessions();
  try {
    const url = crosspostComposerUrl(ext.runtime.getURL("compose.html"), id, fresh, showOnboarding, showSettings);
    const placement = await composerTabPlacement(openerTabId, windowId);
    const tab = await ext.tabs.create({ url, active: true, ...(Number.isInteger(windowId) ? { windowId } : {}), ...placement });
    session.windowId = tab.windowId;
    session.sourceTabId = tab.id;
    session.lastActiveTabId = tab.id;
    session.tabIds = [tab.id];
    session.groupId = await groupComposerTabs([tab.id]);
    session.updatedAt = Date.now();
    await persistCrosspostSessions(); notifyTray();
    return session;
  } catch (error) {
    crosspostSessions.delete(id);
    await persistCrosspostSessions();
    throw error;
  }
}

async function getCrosspostSession(sessionId) {
  await backgroundStateReady.catch(() => {});
  return crosspostSessions.get(sessionId) || null;
}

async function requireCrosspostSession(sessionId, tabId) {
  await backgroundStateReady.catch(() => {});
  const direct = crosspostSessions.get(sessionId);
  const session = direct || sessionForTab([...crosspostSessions.values()], tabId);
  if (!session) throw new Error("This crosspost session is no longer available. Open a new Compose window.");
  return session;
}

async function registerCrosspostComposer(sessionId, tab) {
  if (!Number.isInteger(tab?.id)) return null;
  const session = await requireCrosspostSession(sessionId, tab.id).catch(() => null);
  if (!session) return null;
  session.windowId = tab.windowId;
  session.sourceTabId = tab.id;
  session.lastActiveTabId = tab.id;
  session.tabIds = sessionTabIds(session, [tab.id]);
  if (!Number.isInteger(session.groupId) || session.groupId < 0) session.groupId = await groupComposerTabs([tab.id]);
  session.updatedAt = Date.now();
  await persistCrosspostSessions(); notifyTray();
  return session;
}

async function prepareCrosspostHandoff(sessionId, attemptId, text, networks, sourceTab) {
  const session = await requireCrosspostSession(sessionId, sourceTab?.id);
  session.handoff = { state: "preparing", attemptId: String(attemptId || ""), text: text || "", media: [], networks: networks || [], results: [] };
  session.lastActiveTabId = sourceTab?.id || session.lastActiveTabId;
  session.updatedAt = Date.now();
  await persistCrosspostSessions(); notifyTray();
  return session;
}

async function markCrosspostError(sessionId, error, attemptId) {
  const message = error instanceof Error ? error.message : String(error);
  const session = crosspostSessions.get(sessionId);
  if (session && (!attemptId || session.handoff?.attemptId === attemptId)) {
    session.handoff = { ...(session.handoff || {}), state: "error", error: message };
    session.updatedAt = Date.now();
    await persistCrosspostSessions(); notifyTray();
  }
  return message;
}

async function crosspostSessionPayload(windowId) {
  await backgroundStateReady.catch(() => {});
  const filterToWindow = Number.isInteger(windowId);
  let resolvedWindowId = filterToWindow ? windowId : null;
  if (!Number.isInteger(resolvedWindowId)) resolvedWindowId = (await ext.windows.getLastFocused().catch(() => null))?.id ?? null;
  const sessions = [...crosspostSessions.values()]
    .filter(session => !filterToWindow || session.windowId === resolvedWindowId)
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(session => ({ ...session, preview: sessionPreview(session) }));
  const [activeTab] = Number.isInteger(resolvedWindowId) ? await ext.tabs.query({ active: true, windowId: resolvedWindowId }) : [];
  const active = sessionForTab(sessions, activeTab?.id);
  return { sessions, activeSessionId: active?.id || sessions.at(-1)?.id || "", windowId: resolvedWindowId };
}

async function activateCrosspostSession(sessionId) {
  const session = await requireCrosspostSession(sessionId);
  const openTabs = [];
  for (const tabId of [session.lastActiveTabId, ...(session.tabIds || [])]) {
    if (!Number.isInteger(tabId) || openTabs.some(tab => tab.id === tabId)) continue;
    try { openTabs.push(await ext.tabs.get(tabId)); } catch {}
  }
  const tab = openTabs[0];
  if (!tab) throw new Error("This crosspost no longer has any open tabs.");
  if (Number.isInteger(session.groupId) && session.groupId >= 0) await ext.tabGroups?.update(session.groupId, { collapsed: false }).catch(() => {});
  await ext.tabs.update(tab.id, { active: true });
  if (Number.isInteger(tab.windowId)) await ext.windows.update(tab.windowId, { focused: true });
  session.lastActiveTabId = tab.id; session.updatedAt = Date.now();
  await persistCrosspostSessions(); notifyTray();
  return tab;
}

async function noteActiveCrosspostTab({ tabId, windowId }) {
  await backgroundStateReady.catch(() => {});
  const session = sessionForTab([...crosspostSessions.values()], tabId);
  if (!session) return;
  session.lastActiveTabId = tabId;
  session.windowId = windowId;
  session.updatedAt = Date.now();
  await persistCrosspostSessions(); notifyTray();
}

async function markNativePostForTab(tabId, network, evidence) {
  await backgroundStateReady.catch(() => {});
  if (!Number.isInteger(tabId) || !nativeDestination(network)) return false;
  const session = sessionForTab([...crosspostSessions.values()], tabId);
  const updated = recordPostedDestination(session, tabId, network, Date.now(), evidence);
  if (!updated) return false;
  crosspostSessions.set(updated.id, updated);
  await persistCrosspostSessions(); notifyTray();
  return true;
}

async function nativeTabPostStatus(tabId) {
  await backgroundStateReady.catch(() => {});
  const session = sessionForTab([...crosspostSessions.values()], tabId);
  return Boolean(session?.postedTabIds?.includes(tabId));
}

async function openTraySurface(sender) {
  if (ext.sidePanel?.open) {
    try {
      const windowId = sender.tab?.windowId ?? (await ext.windows.getCurrent()).id;
      if (scopedSidePanel && !Number.isInteger(sender.tab?.id)) throw new Error("The Crossposter tab is unavailable.");
      await ext.sidePanel.open({ windowId });
      return "side-panel";
    } catch (error) {
      // A Chrome side-panel failure should be reported to the composer. Do not
      // silently substitute a detached popup window with different behavior.
      if (scopedSidePanel) throw error;
    }
  }
  if (ext.sidebarAction?.open) {
    // Firefox only honors open() inside a user-action handler, and the user
    // gesture does not survive the message hop from the compose page — so the
    // page opens the sidebar itself on click and this recovers gracefully.
    try { await ext.sidebarAction.open(); return "sidebar"; } catch {}
    try { if (await ext.sidebarAction.isOpen({})) return "sidebar"; } catch {}
  }
  if (trayWindowId != null) {
    try { await ext.windows.update(trayWindowId, { focused: true }); return "window"; }
    catch { trayWindowId = null; }
  }
  const popup = await ext.windows.create({ url: ext.runtime.getURL("tray.html"), type: "popup", width: 340, height: 620, focused: true });
  trayWindowId = popup.id ?? null;
  return "window";
}

function notifyTray() {
  try {
    crosspostSessionPayload().then(payload => {
      const sent = ext.runtime.sendMessage({ type: "CROSSPOST_SESSIONS_UPDATED", ...payload });
      sent?.catch?.(() => {});
    }).catch(() => {});
  } catch {}
}

async function openNativeHandoffs(sessionId, attemptId, networks, handoff, sourceWindowId, sourceTabId) {
  if (!handoff || typeof handoff.text !== "string" || !Array.isArray(handoff.media)) throw new Error("The native handoff is incomplete.");
  const session = await requireCrosspostSession(sessionId, sourceTabId);
  if (!isCurrentHandoff(session.id, attemptId)) return { results: [], tabGroupId: session.groupId ?? null, groupError: "", cancelled: true };
  const targets = [...new Set(networks || [])].map(nativeDestination).filter(Boolean);
  if (!targets.length) throw new Error("Choose at least one supported destination.");
  const entries = [];
  const results = [];
  session.handoff = { ...handoff, attemptId: String(attemptId || ""), networks: targets.map(target => target.id), state: "filling", currentNetwork: "", error: "", results: [] };
  session.updatedAt = Date.now();
  await persistCrosspostSessions(); notifyTray();

  // Create every destination in the background first. Grouping here keeps
  // page load and composer automation from delaying the visible tab group.
  for (const target of targets) {
    if (!isCurrentHandoff(session.id, attemptId)) break;
    try { entries.push({ target, tab: await createNativeComposerTab(target, session, attemptId, sourceWindowId, sourceTabId) }); }
    catch (error) { entries.push({ target, error: error instanceof Error ? error.message : String(error) }); }
  }

  if (!isCurrentHandoff(session.id, attemptId)) return { results: [], tabGroupId: session.groupId ?? null, groupError: "", cancelled: true };
  session.handoff = {
    ...session.handoff,
    destinationTabs: Object.fromEntries(entries.filter(entry => Number.isInteger(entry.tab?.id)).map(entry => [entry.target.id, entry.tab.id]))
  };
  session.updatedAt = Date.now(); await persistCrosspostSessions(); notifyTray();

  let tabGroupId = session.groupId ?? null, groupError = "";
  try {
    tabGroupId = await groupComposerTabs(session.tabIds, session.groupId);
    session.groupId = tabGroupId;
  }
  catch (error) { groupError = error instanceof Error ? error.message : String(error); }

  for (const entry of entries) {
    if (!isCurrentHandoff(session.id, attemptId)) break;
    const { target, tab, error } = entry;
    session.handoff = { ...session.handoff, currentNetwork: target.id, results: [...results], tabGroupId, groupError };
    session.updatedAt = Date.now(); await persistCrosspostSessions(); notifyTray();
    if (error) {
      results.push({ network: target.id, error, result: null });
      continue;
    }
    try { results.push({ network: target.id, ...await fillNativeComposer(target, tab, handoff) }); }
    catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      results.push({ network: target.id, tabId: tab.id, error: message, result: null });
    }
  }
  if (!isCurrentHandoff(session.id, attemptId)) return { results, tabGroupId, groupError, cancelled: true };
  session.handoff = { ...session.handoff, state: "ready", currentNetwork: "", results, tabGroupId, groupError };
  session.updatedAt = Date.now(); await persistCrosspostSessions(); notifyTray();
  return { results, tabGroupId, groupError };
}

async function groupComposerTabs(tabIds, existingGroupId) {
  const groupIds = [...new Set(tabIds.filter(Number.isInteger))];
  if (!groupIds.length || !ext.tabs.group || !ext.tabGroups?.update) return Number.isInteger(existingGroupId) ? existingGroupId : null;
  let groupId;
  if (Number.isInteger(existingGroupId) && existingGroupId >= 0) {
    try { groupId = await ext.tabs.group({ groupId: existingGroupId, tabIds: groupIds }); }
    catch { groupId = await ext.tabs.group({ tabIds: groupIds }); }
  } else groupId = await ext.tabs.group({ tabIds: groupIds });
  await ext.tabGroups.update(groupId, COMPOSER_GROUP_APPEARANCE);
  return groupId;
}

function isCurrentHandoff(sessionId, attemptId) {
  const handoff = crosspostSessions.get(sessionId)?.handoff;
  return handoff?.state !== "idle" && handoff?.attemptId === String(attemptId || "");
}

async function createNativeComposerTab(target, session, attemptId, sourceWindowId, sourceTabId) {
  // Keep new tabs inactive until every destination has been created and
  // grouped. The filling phase activates them one at a time.
  incrementPendingNativeTabs(sourceWindowId);
  try {
    const tab = await ext.tabs.create(composerTabProperties(target.homeUrl, sourceWindowId, false));
    if (!isCurrentHandoff(session.id, attemptId)) {
      await ext.tabs.remove(tab.id).catch(() => {});
      throw new Error("Crossposting was cancelled.");
    }
    rememberNativeSidePanelTab(tab.id, tab.windowId, sourceTabId);
    session.tabIds = sessionTabIds(session, [tab.id]);
    session.lastActiveTabId = tab.id;
    session.updatedAt = Date.now();
    await persistCrosspostSessions();
    return tab;
  } finally { decrementPendingNativeTabs(sourceWindowId); }
}

async function fillNativeComposer(target, initialTab, handoff) {
  let tab = initialTab;
  tab = await ext.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) await ext.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await waitForTab(tab.id, tab.status, target.label);
  let result;
  try { result = await sendComposerMessage(tab.id, { type: "OPEN_NATIVE_COMPOSER", network: target.id, handoff }); }
  catch (error) { result = { ok: true, composerOpened: false, textInserted: false, mediaInserted: 0, error: error instanceof Error ? error.message : String(error) }; }
  // If X's SPA ignored its visible compose control, use the canonical route as
  // a deterministic fallback and retry after the document has loaded. This is
  // deliberately limited to opening/filling the composer; posting stays manual.
  if (shouldRetryCanonicalComposer(target.id, result)) {
    tab = await ext.tabs.update(tab.id, { url: target.homeUrl, active: true });
    await waitForTab(tab.id, tab.status, target.label);
    try { result = await sendComposerMessage(tab.id, { type: "OPEN_NATIVE_COMPOSER", network: target.id, handoff }); }
    catch (error) { result = { ok: true, composerOpened: false, textInserted: false, mediaInserted: 0, error: error instanceof Error ? error.message : String(error) }; }
  }
  const retryMedia = shouldRetryMediaAttachment(target.id, result, handoff.media.length);
  const retryText = shouldRetryTextInsertion(target.id, result, handoff.text);
  if (retryMedia || retryText) {
    await delay(1500);
    const firstResult = result;
    const retryHandoff = retryMedia && firstResult.textInserted && !retryText ? { ...handoff, text: "" } : handoff;
    try {
      result = await sendComposerMessage(tab.id, { type: "OPEN_NATIVE_COMPOSER", network: target.id, handoff: retryHandoff });
      if (!retryHandoff.text && handoff.text) result = { ...result, textInserted: true };
    }
    catch (error) { result = { ok: true, composerOpened: true, textInserted: firstResult.textInserted, mediaInserted: 0, error: error instanceof Error ? error.message : String(error) }; }
  }
  if (!result?.ok) result = { ...result, textInserted: false, mediaInserted: 0 };
  return { tabId: tab.id, result };
}

function queueSidePanelOptions(options) {
  sidePanelOptionsQueue = sidePanelOptionsQueue
    .catch(() => {})
    .then(() => ext.sidePanel.setOptions(options));
  return sidePanelOptionsQueue;
}

function setDefaultSidePanelEnabled(enabled) {
  return queueSidePanelOptions({ path: "tray.html", enabled });
}

function setTabSidePanelEnabled(tabId, enabled) {
  return queueSidePanelOptions({ tabId, ...(enabled ? { path: "tray.html" } : {}), enabled });
}

async function prepareNativeSidePanelWindow(tab) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) throw new Error("The Crossposter tab is unavailable.");
  nativeSidePanelWindows.add(tab.windowId);
  rememberNativeSidePanelTab(tab.id, tab.windowId);
  await setDefaultSidePanelEnabled(true);
  const tabs = await ext.tabs.query({ windowId: tab.windowId });
  for (const candidate of tabs) {
    if (!nativeSidePanelTabs.has(candidate.id)) await setTabSidePanelEnabled(candidate.id, false);
  }
}

function rememberNativeSidePanelTab(tabId, windowId, sourceTabId) {
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) return;
  nativeSidePanelTabs.set(tabId, windowId);
  if (Number.isInteger(sourceTabId) && sourceTabId !== tabId) nativeSidePanelSourceTabs.set(tabId, sourceTabId);
  persistNativeSidePanelTabs();
}

function forgetNativeSidePanelTab(tabId) {
  const windowId = nativeSidePanelTabs.get(tabId);
  if (!Number.isInteger(windowId)) return;
  if ((suppressPanelCloseUntil.get(windowId) || 0) > Date.now()) return;
  nativeSidePanelTabs.delete(tabId);
  nativeSidePanelSourceTabs.delete(tabId);
  persistNativeSidePanelTabs();
  if ([...nativeSidePanelTabs.values()].includes(windowId)) return;
  nativeSidePanelWindows.delete(windowId);
  if (!nativeSidePanelWindows.size) setDefaultSidePanelEnabled(false).catch(() => {});
}

function incrementPendingNativeTabs(windowId) {
  if (!Number.isInteger(windowId)) return;
  pendingNativeTabWindows.set(windowId, (pendingNativeTabWindows.get(windowId) || 0) + 1);
}

function decrementPendingNativeTabs(windowId) {
  if (!Number.isInteger(windowId)) return;
  const remaining = (pendingNativeTabWindows.get(windowId) || 1) - 1;
  if (remaining > 0) pendingNativeTabWindows.set(windowId, remaining);
  else pendingNativeTabWindows.delete(windowId);
}

async function closeComposerTabsForPanel(info = {}, fallbackEvent = false) {
  if (!String(info.path || "").endsWith("tray.html")) return;
  await backgroundStateReady.catch(() => {});
  let windowId = info.windowId;
  if (!Number.isInteger(windowId)) windowId = (await ext.windows.getLastFocused()).id;
  if (!Number.isInteger(windowId)) return;
  const [activeTab] = await ext.tabs.query({ active: true, windowId });
  if (!Number.isInteger(activeTab?.id)) return;
  const activeSession = sessionForTab([...crosspostSessions.values()], activeTab.id);
  // pagehide can also fire when Chrome merely swaps side-panel documents. Only
  // treat it as a close when the browser is visibly on a Crossposter session.
  if (!activeSession && fallbackEvent) return;
  if (!activeSession) return;
  await closeAllCrosspostSessions(windowId);
}

function persistNativeSidePanelTabs() {
  const snapshot = Object.fromEntries([...nativeSidePanelTabs].map(([tabId, windowId]) => [tabId, {
    windowId,
    sourceTabId: nativeSidePanelSourceTabs.get(tabId) ?? null
  }]));
  nativeSidePanelStorageQueue = nativeSidePanelStorageQueue
    .catch(() => {})
    .then(() => nativeSessionStorage.set({ [NATIVE_SIDE_PANEL_TABS_KEY]: snapshot }));
  return nativeSidePanelStorageQueue;
}

async function restoreNativeSidePanelState() {
  const stored = await nativeSessionStorage.get(NATIVE_SIDE_PANEL_TABS_KEY);
  const entries = Object.entries(stored[NATIVE_SIDE_PANEL_TABS_KEY] || {});
  for (const [tabIdValue, storedValue] of entries) {
    const tabId = Number(tabIdValue);
    const windowId = Number(typeof storedValue === "object" ? storedValue?.windowId : storedValue);
    const sourceTabId = Number(typeof storedValue === "object" ? storedValue?.sourceTabId : NaN);
    if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) continue;
    try {
      const tab = await ext.tabs.get(tabId);
      nativeSidePanelTabs.set(tabId, tab.windowId);
      if (Number.isInteger(sourceTabId)) nativeSidePanelSourceTabs.set(tabId, sourceTabId);
      nativeSidePanelWindows.add(tab.windowId);
    } catch {}
  }
  await persistNativeSidePanelTabs();
}

function persistCrosspostSessions() {
  const snapshot = [...crosspostSessions.values()];
  crosspostSessionStorageQueue = crosspostSessionStorageQueue
    .catch(() => {})
    .then(() => nativeSessionStorage.set({ [CROSSPOST_SESSIONS_KEY]: snapshot }));
  return crosspostSessionStorageQueue;
}

async function restoreCrosspostSessions() {
  const stored = await nativeSessionStorage.get(CROSSPOST_SESSIONS_KEY);
  for (const candidate of stored[CROSSPOST_SESSIONS_KEY] || []) {
    if (!candidate?.id || !Array.isArray(candidate.tabIds)) continue;
    const tabs = [];
    for (const tabId of candidate.tabIds) {
      try { tabs.push(await ext.tabs.get(tabId)); } catch {}
    }
    if (!tabs.length) continue;
    const session = {
      ...candidate,
      windowId: tabs[0].windowId,
      tabIds: tabs.map(tab => tab.id),
      sourceTabId: tabs.some(tab => tab.id === candidate.sourceTabId) ? candidate.sourceTabId : null,
      lastActiveTabId: tabs.some(tab => tab.id === candidate.lastActiveTabId) ? candidate.lastActiveTabId : tabs[0].id
    };
    crosspostSessions.set(session.id, session);
  }
  await persistCrosspostSessions();
}

async function removeTabFromCrosspostSessions(tabId) {
  await backgroundStateReady.catch(() => {});
  const session = sessionForTab([...crosspostSessions.values()], tabId);
  if (!session) return;
  session.tabIds = (session.tabIds || []).filter(id => id !== tabId);
  if (session.sourceTabId === tabId) session.sourceTabId = null;
  if (session.lastActiveTabId === tabId) session.lastActiveTabId = session.tabIds[0] ?? null;
  if (!session.tabIds.length) crosspostSessions.delete(session.id);
  else session.updatedAt = Date.now();
  await persistCrosspostSessions(); notifyTray();
}

async function tabsForCrosspostSession(session) {
  const groupTabs = Number.isInteger(session.groupId) && session.groupId >= 0 && Number.isInteger(session.windowId)
    ? await ext.tabs.query({ windowId: session.windowId, groupId: session.groupId }).catch(() => [])
    : [];
  return sessionTabIds(session, groupTabs.map(tab => tab.id));
}

async function closeCrosspostSession(sessionId) {
  await backgroundStateReady.catch(() => {});
  const session = crosspostSessions.get(sessionId);
  if (!session) return;
  const tabIds = await tabsForCrosspostSession(session);
  const [activeTab] = Number.isInteger(session.windowId) ? await ext.tabs.query({ active: true, windowId: session.windowId }) : [];
  const replacement = [...crosspostSessions.values()].find(item => item.id !== sessionId && item.windowId === session.windowId);
  if (replacement && tabIds.includes(activeTab?.id)) {
    suppressPanelCloseUntil.set(session.windowId, Date.now() + 750);
    await activateCrosspostSession(replacement.id).catch(() => {});
  }
  crosspostSessions.delete(sessionId);
  await persistCrosspostSessions(); notifyTray();
  if (tabIds.length) await ext.tabs.remove(tabIds).catch(() => {});
}

async function cancelNativeHandoff(sessionId, attemptId) {
  await backgroundStateReady.catch(() => {});
  const session = crosspostSessions.get(sessionId);
  if (!session) throw new Error("This crosspost session is no longer available.");
  if (attemptId && session.handoff?.attemptId && session.handoff.attemptId !== attemptId) throw new Error("A newer crosspost is already in progress.");
  const groupTabs = Number.isInteger(session.groupId) && session.groupId >= 0 && Number.isInteger(session.windowId)
    ? await ext.tabs.query({ windowId: session.windowId, groupId: session.groupId }).catch(() => [])
    : [];
  const reset = resetCrosspostHandoff(session, groupTabs.map(tab => tab.id));
  crosspostSessions.set(sessionId, reset.session);
  await persistCrosspostSessions(); notifyTray();
  if (Number.isInteger(reset.session.sourceTabId)) {
    await ext.tabs.update(reset.session.sourceTabId, { active: true }).catch(() => {});
  }
  if (reset.tabIdsToClose.length) await ext.tabs.remove(reset.tabIdsToClose).catch(() => {});
  return reset.tabIdsToClose.length;
}

async function clearAllCrossposterData(sessionId, currentTab) {
  await backgroundStateReady.catch(() => {});
  if (!Number.isInteger(currentTab?.id) || !Number.isInteger(currentTab?.windowId)) throw new Error("The current Compose tab is unavailable.");
  await Promise.all([nativeSidePanelStorageQueue.catch(() => {}), crosspostSessionStorageQueue.catch(() => {})]);
  const sessionTabs = (await Promise.all([...crosspostSessions.values()].map(tabsForCrosspostSession))).flat();
  const tabsToClose = [...new Set([...sessionTabs, ...nativeSidePanelTabs.keys()])].filter(tabId => tabId !== currentTab.id);
  await clearHandoffMedia();
  await ext.storage.local.clear();
  if (ext.storage.session && ext.storage.session !== ext.storage.local) await ext.storage.session.clear();
  await synchronizePlatformContentScripts(normalizeEnabledPlatforms());
  await broadcastInlineActionPreference(true);

  crosspostSessions.clear();
  nativeSidePanelTabs.clear();
  nativeSidePanelSourceTabs.clear();
  nativeSidePanelWindows.clear();
  pendingNativeTabWindows.clear();
  pendingLinkedInPublishes.clear();
  suppressPanelCloseUntil.clear();

  const id = String(sessionId || crypto.randomUUID());
  const draft = createDraft({});
  crosspostSessions.set(id, {
    id,
    draft,
    fresh: true,
    windowId: currentTab.windowId,
    groupId: Number.isInteger(currentTab.groupId) && currentTab.groupId >= 0 ? currentTab.groupId : null,
    sourceTabId: currentTab.id,
    tabIds: [currentTab.id],
    lastActiveTabId: currentTab.id,
    handoff: { state: "idle", text: "", media: [], networks: [], results: [] },
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  nativeSidePanelTabs.set(currentTab.id, currentTab.windowId);
  nativeSidePanelWindows.add(currentTab.windowId);
  await Promise.all([persistCrosspostSessions(), persistNativeSidePanelTabs()]);
  await refreshDetectedBadge([]);
  let notifications = null;
  try { notifications = await ext.notifications?.getAll?.(); } catch {}
  if (notifications) await Promise.all(Object.keys(notifications).filter(id => id.startsWith(LINKEDIN_NOTIFICATION_PREFIX)).map(id => ext.notifications.clear(id).catch(() => {})));
  notifyTray();
  if (tabsToClose.length) await ext.tabs.remove(tabsToClose).catch(() => {});
  return tabsToClose.length;
}

async function closeAllCrosspostSessions(windowId) {
  await backgroundStateReady.catch(() => {});
  if (closingCrosspostWindows.has(windowId)) return;
  closingCrosspostWindows.add(windowId);
  try {
    const sessions = [...crosspostSessions.values()].filter(session => session.windowId === windowId);
    const tabIds = [...new Set((await Promise.all(sessions.map(tabsForCrosspostSession))).flat())];
    sessions.forEach(session => crosspostSessions.delete(session.id));
    await persistCrosspostSessions(); notifyTray();
    if (tabIds.length) await ext.tabs.remove(tabIds).catch(() => {});
  } finally { closingCrosspostWindows.delete(windowId); }
}

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

function waitForTab(tabId, currentStatus, label) {
  if (currentStatus === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`${label} took too long to load.`)), 20000);
    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === "complete") finish();
    };
    function finish(error) {
      clearTimeout(timeout);
      ext.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    }
    ext.tabs.onUpdated.addListener(listener);
  });
}
