import { bestByBitrate } from "../../shared/media-variants.js";

export function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

export function parseTweetVariants(payload) {
  const variants = [];
  const collect = media => {
    if (media?.type !== "video" && media?.type !== "animated_gif") return;
    for (const variant of media.video_info?.variants || []) {
      variants.push({ url: variant.url, bitrate: variant.bitrate || 0, contentType: variant.content_type });
    }
  };
  for (const media of payload?.mediaDetails || payload?.video?.mediaDetails || []) collect(media);
  if (!variants.length) {
    // Promoted tweets carry their video inside a unified card instead of
    // native media; its media_entities use the same video_info shape.
    try {
      const card = JSON.parse(payload?.card?.binding_values?.unified_card?.string_value || "");
      for (const media of Object.values(card?.media_entities || {})) collect(media);
    } catch {}
  }
  return variants;
}

export async function resolveTwitter(tweetId, fetcher = fetch) {
  if (!tweetId) throw new Error("Could not identify the tweet for this video.");
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=${syndicationToken(tweetId)}`;
  const response = await fetcher(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`Twitter returned ${response.status} for this video.`);
  const best = bestByBitrate(parseTweetVariants(await response.json().catch(() => null)));
  if (!best) throw new Error("No downloadable video found in this tweet.");
  return { source: "x", container: best.container, url: best.url, filename: `x-${tweetId}.mp4` };
}
