// Stored handoff media stays until Crossposter deletes it: extension storage
// has no expiry, and unlimitedStorage exempts it from browser eviction.

// A handoff stores its media a moment before it records the history entry
// or session that refers to it, so recently stored media is never swept.
export const UNREFERENCED_MEDIA_GRACE_MS = 24 * 60 * 60 * 1000;

// Media ids referred to by drafts, history entries' drafts, or session
// handoffs: anything with a `media` array of stored references.
export function referencedMediaIds(holders = []) {
  return new Set(holders.flatMap(holder => Array.isArray(holder?.media) ? holder.media : [])
    .map(item => item?.mediaId)
    .filter(Boolean));
}

export function unreferencedMediaIds(records = [], referenced = new Set(), now = Date.now(), graceMs = UNREFERENCED_MEDIA_GRACE_MS) {
  return records
    .filter(record => record?.id && !referenced.has(record.id) && now - (Number(record.createdAt) || 0) >= graceMs)
    .map(record => record.id);
}
