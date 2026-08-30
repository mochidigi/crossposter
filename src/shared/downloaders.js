import { resolveTwitter } from "../platforms/x/download.js";
import { resolveLinkedIn } from "../platforms/linkedin/download.js";
import { resolveUpScrolled } from "../platforms/upscrolled/download.js";
import { resolveBluesky } from "../platforms/bluesky/download.js";
import { resolveFacebook } from "../platforms/facebook/download.js";

export { bestByBitrate } from "./media-variants.js";
export { parseTweetVariants, resolveTwitter, syndicationToken } from "../platforms/x/download.js";
export { parseLinkedInSources, resolveLinkedIn } from "../platforms/linkedin/download.js";
export { resolveUpScrolled, upscrolledManifestUrl } from "../platforms/upscrolled/download.js";
export { parseBlueskyPostUrl, resolveBluesky } from "../platforms/bluesky/download.js";
export { parseFacebookDashManifest, parseFacebookDashTracks, parseFacebookVideoUrl, resolveFacebook } from "../platforms/facebook/download.js";

const resolvers = Object.freeze({
  x: (info, fetcher) => resolveTwitter(info.tweetId, fetcher),
  linkedin: info => resolveLinkedIn(info.sources, info.src),
  upscrolled: info => resolveUpScrolled(info.thumbnail, info.src),
  bluesky: (info, fetcher) => resolveBluesky(info.actor, info.rkey, fetcher),
  facebook: (info, fetcher) => resolveFacebook(info.videoId, info.src, fetcher)
});

// Route a content adapter's video hint to its platform resolver. New platforms
// add one resolver module and one entry here; the background worker stays generic.
export async function resolveDownload(info, fetcher = fetch) {
  const resolver = resolvers[info.source];
  if (resolver) return resolver(info, fetcher);
  if (/^https?:/i.test(info.src || "")) {
    return {
      source: info.source || "web",
      container: info.src.includes(".m3u8") ? "hls" : "mp4",
      url: info.src,
      filename: "video.mp4"
    };
  }
  throw new Error("No downloadable video found here.");
}

export async function resolveReshareMedia(media, hint, resolver = resolveDownload) {
  const items = Array.isArray(media) ? [...media] : [];
  const videoIndex = items.findIndex(item => item?.kind === "video");
  if (videoIndex < 0) return items;
  const descriptor = await resolver(hint);
  if (!descriptor?.url || !["mp4", "hls", "dash"].includes(descriptor.container)) return items;
  items[videoIndex] = {
    ...items[videoIndex],
    url: descriptor.url,
    filename: descriptor.filename || "video.mp4",
    ...(["hls", "dash"].includes(descriptor.container) ? { streamType: descriptor.container } : {}),
    ...(descriptor.audioUrl ? { audioUrl: descriptor.audioUrl } : {})
  };
  return items;
}

export function mediaDownloadDescriptor(item = {}) {
  if (item.kind !== "video" || !item.url) throw new Error("No downloadable video is available.");
  return {
    source: item.source || "web",
    container: item.streamType === "dash" ? "dash" : item.streamType === "hls" || /\.m3u8(?:[?#]|$)/i.test(item.url) ? "hls" : "mp4",
    url: item.url,
    ...(item.audioUrl ? { audioUrl: item.audioUrl } : {}),
    filename: item.filename || "video.mp4"
  };
}
