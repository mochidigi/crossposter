export const DETECTED_DRAFTS_KEY = "detectedDrafts";
export const MAX_DETECTED_DRAFTS = 20;

export function detectedDraftKey(draft = {}) {
  const sourceUrl = String(draft.sourceUrl || "");
  const stableUrl = sourceUrl.match(/(?:activity|ugcPost|share)[-:%\w]+/i)?.[0];
  if (stableUrl) return `linkedin:${stableUrl.toLowerCase()}`;
  const text = String(draft.text || "").replace(/\s+/g, " ").trim().toLowerCase();
  const media = (draft.media || []).map(item => `${item.kind || ""}:${item.url || ""}`).join("|");
  return `fallback:${text.slice(0, 500)}:${media}`;
}

export function enqueueDetectedDraft(queue, draft, maximum = MAX_DETECTED_DRAFTS) {
  const items = Array.isArray(queue) ? queue.filter(Boolean) : [];
  const key = detectedDraftKey(draft);
  if (items.some(item => detectedDraftKey(item) === key)) return { queue: items, added: false };
  return { queue: [draft, ...items].slice(0, maximum), added: true };
}

export function removeDetectedDraft(queue, id) {
  return (Array.isArray(queue) ? queue : []).filter(draft => draft?.id !== id);
}

export function detectedBadgeText(count) {
  const value = Math.max(0, Number(count) || 0);
  if (!value) return "";
  return value > 99 ? "99+" : String(value);
}
