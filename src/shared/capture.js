export function chooseContextMedia(info = {}, captured = {}) {
  const capturedMedia = Array.isArray(captured.media) ? captured.media : [];
  // A video card can expose its poster as the context-menu target. When the
  // content script found a real post, its site-aware classification is more
  // accurate than Chrome's raw mediaType (which reports that poster as image).
  if (captured.capturedFromPost === true && capturedMedia.length) return capturedMedia;
  if (info.srcUrl) {
    return [{ kind: info.mediaType === "video" ? "video" : "image", url: info.srcUrl }];
  }
  return capturedMedia;
}
