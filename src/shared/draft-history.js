export const DRAFT_HISTORY_KEY = "crossposterDraftHistory";
export const MAX_DRAFT_HISTORY = 20;
// Handoffs are kept for 14 days. Extension storage never expires on its own,
// so older entries are dropped whenever history is read or swept.
export const DRAFT_HISTORY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export function expireDraftHistory(history, now = Date.now(), retentionMs = DRAFT_HISTORY_RETENTION_MS) {
  const previous = Array.isArray(history) ? history.filter(Boolean) : [];
  const cutoff = now - retentionMs;
  const next = previous.filter(item => Number(item.savedAt) >= cutoff);
  const expired = previous.filter(item => !next.includes(item));
  return { history: next, expired: expired.length, removedMediaIds: mediaIdsNotReferenced(expired, next) };
}

export function draftHistoryEntry(draft = {}, media = [], savedAt = Date.now()) {
  return {
    id: draft.id,
    savedAt,
    draft: {
      id: draft.id,
      text: String(draft.text || ""),
      credit: draft.credit !== false,
      sourceUrl: String(draft.sourceUrl || ""),
      sourceNetwork: String(draft.sourceNetwork || "web"),
      sourceAuthor: String(draft.sourceAuthor || ""),
      sourceIsOwn: draft.sourceIsOwn === true,
      destinations: Array.isArray(draft.destinations) ? [...draft.destinations] : [],
      createdAt: draft.createdAt || savedAt,
      media: historyMedia(draft.media, media)
    }
  };
}

// The one-line label a saved crosspost goes by in history lists and notices.
export function draftHistoryPreview(entry) {
  const item = entry?.draft || {};
  return String(item.text || "").replace(/\s+/g, " ").trim() || (item.media?.length ? "Media post" : "Untitled draft");
}

// "5 minutes ago", "yesterday". English like the rest of Crossposter's UI, so
// it never reads as a mix of languages inside an English sentence.
export function draftHistoryAge(savedAt, now = Date.now()) {
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const minutes = Math.min(0, Math.round((Number(savedAt) - now) / 60000)) || 0;
  if (!minutes) return "just now";
  if (minutes > -60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

export function upsertDraftHistory(history, entry, maximum = MAX_DRAFT_HISTORY) {
  const previous = Array.isArray(history) ? history : [];
  const replaced = previous.find(item => item?.id === entry.id);
  const next = [entry, ...previous.filter(item => item?.id !== entry.id)].slice(0, maximum);
  const removed = [replaced, ...previous.slice(maximum - (replaced ? 0 : 1))].filter(Boolean);
  return { history: next, removedMediaIds: mediaIdsNotReferenced(removed, next) };
}

export function removeDraftHistoryEntry(history, id) {
  const previous = Array.isArray(history) ? history : [];
  const removed = previous.filter(item => item?.id === id);
  const next = previous.filter(item => item?.id !== id);
  return { history: next, removedMediaIds: mediaIdsNotReferenced(removed, next) };
}

function historyMedia(sourceMedia = [], storedMedia = []) {
  const byIndex = new Map((storedMedia || []).map((item, index) => [Number.isInteger(item.sourceIndex) ? item.sourceIndex : index, item]));
  return (sourceMedia || []).map((item, index) => {
    const stored = byIndex.get(index) || (item.mediaId ? item : null);
    if (!stored?.mediaId) return null;
    return {
      mediaId: stored.mediaId,
      kind: item.kind || stored.kind,
      name: stored.name || item.filename || "crossposter-media",
      type: stored.type || "",
      size: stored.size || 0,
      lastModified: stored.lastModified || savedTimestamp(item),
      filename: item.filename || stored.name || "",
      ...(item.trim ? { trim: item.trim } : {}),
      ...(item.crop ? { crop: item.crop } : {}),
      ...(item.edited ? { edited: true } : {}),
      ...(item.textCard ? { textCard: item.textCard } : {})
    };
  }).filter(Boolean);
}

function savedTimestamp(item) { return Number(item?.lastModified) || Date.now(); }

function mediaIdsNotReferenced(removed, remaining) {
  const retained = new Set((remaining || []).flatMap(item => item?.draft?.media || []).map(item => item?.mediaId).filter(Boolean));
  return [...new Set((removed || []).flatMap(item => item?.draft?.media || []).map(item => item?.mediaId).filter(id => id && !retained.has(id)))];
}
