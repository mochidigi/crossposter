function decodedUrl(value = "") {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function linkedInVideoRequest(url = "") {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!(parsed.hostname === "licdn.com" || parsed.hostname.endsWith(".licdn.com"))) return null;
  const value = decodedUrl(parsed.href);
  if (/(?:videocover|thumbnail|\/dms\/image\/)/i.test(value)) return null;
  const hls = /\.m3u8(?:[?#]|$)/i.test(value);
  const mp4 = /\.mp4(?:[?#]|$)/i.test(value);
  if (!hls && !mp4) return null;
  const assetId = value.match(/\/dms\/(?:video|document)\/v\d+\/([^/?#]+)/i)?.[1] || "";
  return { url: parsed.href, assetId, container: hls ? "hls" : "mp4" };
}

export function selectLinkedInVideoRequest(entries = [], assetId = "") {
  const candidates = entries.map(entry => ({ ...linkedInVideoRequest(entry?.url || entry), time: Number(entry?.time || 0) })).filter(item => item.url);
  const exact = assetId ? candidates.filter(item => item.assetId === assetId || decodedUrl(item.url).includes(assetId)) : candidates;
  const pool = assetId ? exact : candidates;
  if (!pool.length) return null;
  return pool.sort((a, b) => {
    const aHls = a.container === "hls" ? 1 : 0, bHls = b.container === "hls" ? 1 : 0;
    const aMaster = /(?:master|playlist|index)/i.test(a.url) ? 1 : 0, bMaster = /(?:master|playlist|index)/i.test(b.url) ? 1 : 0;
    return bHls - aHls || bMaster - aMaster || b.time - a.time;
  })[0];
}

function parseVhsJson(value = "") {
  const marker = String(value).indexOf(",");
  if (marker < 0 || !/^data:application\/vnd\.videojs\.vhs\+json\b/i.test(value)) return null;
  const body = String(value).slice(marker + 1);
  try { return JSON.parse(body); }
  catch {
    try { return JSON.parse(decodeURIComponent(body)); }
    catch { return null; }
  }
}

function quotedAttribute(value = "") {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function mediaPlaylist(segments, { init = "", assetId = "", bandwidth = 0, codecs = "" } = {}) {
  if (!segments.length) return null;
  const targetDuration = Math.max(1, ...segments.map(segment => Math.ceil(segment.duration || 1)));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD"
  ];
  if (init) lines.push(`#EXT-X-MAP:URI="${quotedAttribute(init)}"`);
  for (const segment of segments) lines.push(`#EXTINF:${segment.duration || 0},`, segment.url);
  lines.push("#EXT-X-ENDLIST");
  return {
    assetId,
    bandwidth: Number(bandwidth || 0),
    codecs,
    container: "hls",
    url: `data:application/vnd.apple.mpegurl;charset=utf-8,${encodeURIComponent(lines.join("\n"))}`
  };
}

// LinkedIn's current player no longer requests a conventional .m3u8 URL. It
// gives Video.js a data: JSON manifest containing signed fragmented-MP4 URLs.
// Turn the best compatible rendition back into a small HLS media playlist so
// the existing downloader can fetch and remux it normally.
export function linkedInVhsPlaylist(cacheSource = "", expectedAssetId = "") {
  const manifest = parseVhsJson(cacheSource);
  const variants = (manifest?.playlists || []).filter(playlist => Array.isArray(playlist?.segments) && playlist.segments.length);
  if (!variants.length) return null;
  const matching = expectedAssetId
    ? variants.filter(playlist => playlist.segments.some(segment => String(segment?.resolvedUri || segment?.uri || "").includes(expectedAssetId)))
    : variants;
  const candidates = matching.length ? matching : variants;
  const h264 = candidates.filter(playlist => /(?:^|,)avc1\./i.test(playlist?.attributes?.CODECS || ""));
  const pool = h264.length ? h264 : candidates;
  const selected = pool.reduce((best, playlist) => Number(playlist?.attributes?.BANDWIDTH || 0) >= Number(best?.attributes?.BANDWIDTH || 0) ? playlist : best, null);
  if (!selected) return null;

  const segments = selected.segments.map(segment => ({
    url: segment?.resolvedUri || segment?.uri || "",
    duration: Number(segment?.duration || 0),
    init: segment?.map?.resolvedUri || segment?.map?.uri || ""
  })).filter(segment => /^https?:/i.test(segment.url));
  if (!segments.length) return null;
  const init = segments.find(segment => /^https?:/i.test(segment.init))?.init || "";
  return mediaPlaylist(segments, {
    init,
    assetId: expectedAssetId || segments[0].url.match(/\/playlist\/vid\/v\d+\/([^/?#]+)/i)?.[1] || "",
    bandwidth: selected?.attributes?.BANDWIDTH,
    codecs: selected?.attributes?.CODECS || ""
  });
}

function xmlAttribute(source = "", name = "") {
  return source.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i"))?.[1] || "";
}

function xmlUrl(value = "") {
  return String(value).replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

export function linkedInDashManifestRequest(url = "") {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!(parsed.hostname === "licdn.com" || parsed.hostname.endsWith(".licdn.com"))) return null;
  const assetId = decodedUrl(parsed.href).match(/\/playlist\/vid\/dash\/([^/?#]+)\//i)?.[1] || "";
  return assetId ? { url: parsed.href, assetId } : null;
}

// Some LinkedIn players expose an extensionless MPEG-DASH MPD rather than the
// Video.js JSON above. Its representations are still fragmented MP4 and can be
// expressed as the same local HLS media playlist used by our remuxer.
export function linkedInDashPlaylist(xml = "", manifestUrl = "", expectedAssetId = "") {
  const request = linkedInDashManifestRequest(manifestUrl);
  const assetId = expectedAssetId || request?.assetId || String(xml).match(/<MPD\b[^>]*\sid="([^"]+)"/i)?.[1] || "";
  const representations = [...String(xml).matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi)].map(match => {
    const attributes = match[1], body = match[2];
    const segmentListAttributes = body.match(/<SegmentList\b([^>]*)>/i)?.[1] || "";
    const duration = Number(xmlAttribute(segmentListAttributes, "duration") || 0);
    const timescale = Number(xmlAttribute(segmentListAttributes, "timescale") || 1);
    return {
      bandwidth: Number(xmlAttribute(attributes, "bandwidth") || 0),
      codecs: xmlAttribute(attributes, "codecs"),
      init: xmlUrl(body.match(/<Initialization\b[^>]*\ssourceURL="([^"]+)"/i)?.[1] || ""),
      segments: [...body.matchAll(/<SegmentURL\b[^>]*\smedia="([^"]+)"/gi)].map(segment => ({
        url: xmlUrl(segment[1]),
        duration: timescale ? duration / timescale : duration
      })).filter(segment => /^https?:/i.test(segment.url))
    };
  }).filter(representation => representation.segments.length);
  if (!representations.length) return null;
  const matching = assetId
    ? representations.filter(representation => representation.segments.some(segment => segment.url.includes(assetId)))
    : representations;
  const candidates = matching.length ? matching : representations;
  const h264 = candidates.filter(representation => /(?:^|,)avc1\./i.test(representation.codecs));
  const pool = h264.length ? h264 : candidates;
  const selected = pool.reduce((best, representation) => representation.bandwidth >= (best?.bandwidth || 0) ? representation : best, null);
  if (!selected) return null;
  return mediaPlaylist(selected.segments, {
    init: /^https?:/i.test(selected.init) ? selected.init : "",
    assetId,
    bandwidth: selected.bandwidth,
    codecs: selected.codecs
  });
}
