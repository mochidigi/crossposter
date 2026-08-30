const BSKY_API = "https://public.api.bsky.app/xrpc";

export function parseBlueskyPostUrl(url) {
  const match = String(url || "").match(/\/profile\/([^/]+)\/post\/([^/?#]+)/);
  return match ? { actor: match[1], rkey: match[2] } : null;
}

function blueskyMedia(embed) {
  const type = embed?.["$type"] || "";
  if (type.startsWith("app.bsky.embed.video") && embed.playlist) return { container: "hls", url: embed.playlist };
  if (type.startsWith("app.bsky.embed.recordWithMedia")) return blueskyMedia(embed.media);
  if (type.startsWith("app.bsky.embed.external")) {
    const uri = embed.external?.uri || "";
    if (/\.mp4(\?|$)/i.test(uri)) return { container: "mp4", url: uri };
  }
  return null;
}

export async function resolveBluesky(actor, rkey, fetcher = fetch) {
  if (!actor || !rkey) throw new Error("Could not identify the Bluesky post.");
  let did = actor;
  if (!did.startsWith("did:")) {
    const response = await fetcher(`${BSKY_API}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`);
    if (!response.ok) throw new Error("Could not resolve this Bluesky handle.");
    did = (await response.json()).did;
  }
  const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
  const response = await fetcher(`${BSKY_API}/app.bsky.feed.getPostThread?depth=0&uri=${encodeURIComponent(uri)}`);
  if (!response.ok) throw new Error(`Bluesky returned ${response.status} for this post.`);
  const media = blueskyMedia((await response.json())?.thread?.post?.embed);
  if (!media) throw new Error("No downloadable video found in this Bluesky post.");
  return { source: "bluesky", container: media.container, url: media.url, filename: `bluesky-${rkey}.mp4` };
}
