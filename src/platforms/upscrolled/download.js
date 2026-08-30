export function upscrolledManifestUrl(thumbnail = "") {
  let url;
  try { url = new URL(thumbnail); } catch { return ""; }
  if (!url.hostname.startsWith("image.") || !url.hostname.endsWith(".video.upscrolled.com")) return "";
  const playbackId = url.pathname.match(/^\/([^/]+)\/thumbnail(?:\.[a-z0-9]+)?$/i)?.[1];
  if (!playbackId) return "";
  url.hostname = url.hostname.replace(/^image\./, "stream.");
  url.pathname = `/${playbackId}.m3u8`;
  url.search = "";
  return url.href;
}

export function resolveUpScrolled(thumbnail = "", fallbackSrc = "") {
  const url = /^https?:.*\.m3u8(?:[?#]|$)/i.test(fallbackSrc) ? fallbackSrc : upscrolledManifestUrl(thumbnail);
  if (!url) throw new Error("No downloadable video found in this UpScrolled post.");
  return { source: "upscrolled", container: "hls", url, filename: "upscrolled-video.mp4" };
}
