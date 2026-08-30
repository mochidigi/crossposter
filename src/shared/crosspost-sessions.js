export const CROSSPOST_SESSIONS_KEY = "crossposterSessions";

export function crosspostSessionIdFromUrl(url = "") {
  try { return new URL(url).searchParams.get("session") || ""; }
  catch { return ""; }
}

export function crosspostComposerUrl(baseUrl, sessionId, fresh = false, showOnboarding = false, showSettings = false) {
  const url = new URL(baseUrl);
  url.searchParams.set("session", sessionId);
  if (fresh) url.searchParams.set("mode", "fresh");
  if (showOnboarding) url.searchParams.set("onboarding", "1");
  if (showSettings) url.searchParams.set("settings", "1");
  return url.href;
}

export function sessionForTab(sessions = [], tabId) {
  return sessions.find(session => session?.tabIds?.includes(tabId)) || null;
}

export function sessionTabIds(session = {}, groupTabIds = []) {
  return [...new Set([...(session.tabIds || []), ...groupTabIds].filter(Number.isInteger))];
}

export function sessionPreview(session = {}) {
  const text = String(session.handoff?.text || session.draft?.text || "").replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 80);
  const mediaCount = session.handoff?.media?.length || session.draft?.media?.length || 0;
  return mediaCount ? `Media post · ${mediaCount} item${mediaCount === 1 ? "" : "s"}` : "New crosspost";
}

export function recordPostedDestination(session, tabId, network, postedAt = Date.now(), evidence = "") {
  if (!session || !Number.isInteger(tabId) || !evidence || !(session.handoff?.networks || []).includes(network)) return null;
  const result = (session.handoff.results || []).find(item => item.network === network);
  const expectedTabId = session.handoff.destinationTabs?.[network] ?? result?.tabId;
  if (!Number.isInteger(expectedTabId) || expectedTabId !== tabId) return null;
  return {
    ...session,
    postedTabIds: [...new Set([...(session.postedTabIds || []), tabId])],
    handoff: {
      ...session.handoff,
      postedNetworks: [...new Set([...(session.handoff.postedNetworks || []), network])],
      postedAt: { ...(session.handoff.postedAt || {}), [network]: postedAt },
      postedEvidence: { ...(session.handoff.postedEvidence || {}), [network]: evidence }
    },
    updatedAt: postedAt
  };
}

export function resetCrosspostHandoff(session, groupTabIds = [], updatedAt = Date.now()) {
  if (!session) return null;
  const sourceTabId = Number.isInteger(session.sourceTabId) ? session.sourceTabId : null;
  const tabIdsToClose = sessionTabIds(session, groupTabIds).filter(tabId => tabId !== sourceTabId);
  return {
    tabIdsToClose,
    session: {
      ...session,
      tabIds: sourceTabId == null ? [] : [sourceTabId],
      lastActiveTabId: sourceTabId,
      postedTabIds: [],
      handoff: {
        state: "idle",
        text: session.handoff?.text || session.draft?.text || "",
        media: [],
        networks: [],
        results: []
      },
      updatedAt
    }
  };
}
