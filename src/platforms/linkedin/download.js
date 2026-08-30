import { bestByBitrate } from "../../shared/media-variants.js";

export function parseLinkedInSources(dataSources) {
  let list;
  try { list = typeof dataSources === "string" ? JSON.parse(dataSources) : dataSources; }
  catch { return null; }
  if (!Array.isArray(list) || !list.length) return null;
  return bestByBitrate(list.map(source => ({
    url: source.src,
    bitrate: Number(source["data-bitrate"] || source.bitrate || 0),
    contentType: source.type
  })));
}

export function resolveLinkedIn(dataSources, fallbackSrc = "") {
  const parsed = parseLinkedInSources(dataSources);
  if (parsed) return { source: "linkedin", container: parsed.container, url: parsed.url, filename: "linkedin-video.mp4" };
  if (/^https?:/i.test(fallbackSrc)) {
    return {
      source: "linkedin",
      container: fallbackSrc.includes(".m3u8") ? "hls" : "mp4",
      url: fallbackSrc,
      filename: "linkedin-video.mp4"
    };
  }
  throw new Error("No downloadable video found on this post.");
}
