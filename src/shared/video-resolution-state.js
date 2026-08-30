export function markVideoResolving(media = [], resolutionId = "") {
  const index = media.findIndex(item => item?.kind === "video");
  if (index < 0 || !resolutionId) return [...media];
  return media.map((item, itemIndex) => itemIndex === index
    ? { ...item, resolving: true, resolutionId, resolveError: "" }
    : item);
}

export function settleVideoResolution(media = [], resolutionId = "", resolvedItem, error = "") {
  const index = media.findIndex(item => item?.resolutionId === resolutionId);
  if (index < 0) return media;
  const pending = media[index];
  const { resolving: _resolving, resolutionId: _resolutionId, resolveError: _resolveError, ...original } = pending;
  const settled = error
    ? { ...original, resolveError: String(error) }
    : { ...original, ...(resolvedItem || {}), resolveError: "" };
  return media.map((item, itemIndex) => itemIndex === index ? settled : item);
}
