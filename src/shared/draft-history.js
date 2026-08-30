export const DRAFT_HISTORY_KEY = "crossposterDraftHistory";
export const MAX_DRAFT_HISTORY = 20;

export function draftHistoryEntry(draft = {}, media = [], savedAt = Date.now()) {
  return {
    id: draft.id,
    savedAt,
    draft: {
      id: draft.id,
      text: String(draft.text || ""),
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
      ...(item.edited ? { edited: true } : {})
    };
  }).filter(Boolean);
}

function savedTimestamp(item) { return Number(item?.lastModified) || Date.now(); }

function mediaIdsNotReferenced(removed, remaining) {
  const retained = new Set((remaining || []).flatMap(item => item?.draft?.media || []).map(item => item?.mediaId).filter(Boolean));
  return [...new Set((removed || []).flatMap(item => item?.draft?.media || []).map(item => item?.mediaId).filter(id => id && !retained.has(id)))];
}
