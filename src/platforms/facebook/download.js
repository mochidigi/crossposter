const FACEBOOK_VIDEO_KEYS = [
  "browser_native_hd_url",
  "playable_url_quality_hd",
  "hd_src",
  "browser_native_sd_url",
  "playable_url",
  "sd_src"
];

function decodeFacebookUrl(value = "") {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded
      .replace(/\\u0025/gi, "%")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u003d/gi, "=")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&");
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function decodeJsonString(value = "") {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = JSON.parse(`"${decoded}"`);
      if (next === decoded) break;
      decoded = next;
    } catch { break; }
  }
  return decoded;
}

function xmlAttribute(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1] || "";
}

function decodeXml(value = "") {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export function parseFacebookVideoUrl(html = "") {
  // Comet sometimes embeds the video object directly and sometimes as an
  // escaped JSON string. Normalizing escaped quotes covers both forms.
  const documents = [html, html.replace(/\\"/g, '"')];
  for (const key of FACEBOOK_VIDEO_KEYS) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"([^"\\n]+)"`, "g");
    for (const document of documents) {
      for (const match of document.matchAll(pattern)) {
        const url = decodeFacebookUrl(match[1]);
        if (/^https?:\/\//i.test(url)) return url;
      }
    }
  }
  return "";
}

export function parseFacebookDashManifest(html = "") {
  const match = html.match(/"manifest_xml"\s*:\s*"((?:\\.|[^"\\])*)"/);
  return match ? decodeJsonString(match[1]) : "";
}

export function parseFacebookDashTracks(manifest = "", { maxHeight = 720 } = {}) {
  const representations = [...manifest.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi)]
    .map(match => {
      const base = match[2].match(/<BaseURL>([\s\S]*?)<\/BaseURL>/i)?.[1] || "";
      return {
        url: decodeXml(base.trim()),
        mimeType: xmlAttribute(match[1], "mimeType"),
        codecs: xmlAttribute(match[1], "codecs"),
        width: Number(xmlAttribute(match[1], "width") || 0),
        height: Number(xmlAttribute(match[1], "height") || 0),
        bandwidth: Number(xmlAttribute(match[1], "bandwidth") || 0)
      };
    })
    .filter(item => /^https?:\/\//i.test(item.url));
  const videos = representations.filter(item => item.mimeType === "video/mp4");
  const withinLimit = videos.filter(item => {
    const shortEdge = Math.min(item.width || Infinity, item.height || Infinity);
    return !Number.isFinite(shortEdge) || shortEdge <= maxHeight;
  });
  const choices = withinLimit.length ? withinLimit : videos;
  const video = choices.sort((a, b) => {
    const aCompatible = /^avc1/i.test(a.codecs) ? 1 : 0;
    const bCompatible = /^avc1/i.test(b.codecs) ? 1 : 0;
    const aShortEdge = Math.min(a.width || Infinity, a.height || Infinity);
    const bShortEdge = Math.min(b.width || Infinity, b.height || Infinity);
    return bCompatible - aCompatible || bShortEdge - aShortEdge || b.bandwidth - a.bandwidth;
  })[0];
  const audio = representations
    .filter(item => item.mimeType === "audio/mp4")
    .sort((a, b) => b.bandwidth - a.bandwidth)[0];
  return video ? { videoUrl: video.url, audioUrl: audio?.url || "" } : null;
}

export async function resolveFacebook(videoId, fallbackSrc = "", fetcher = fetch) {
  if (typeof fallbackSrc === "function") { fetcher = fallbackSrc; fallbackSrc = ""; }
  if (!/^\d+$/.test(String(videoId || ""))) throw new Error("No Facebook video ID was found.");
  if (/^https?:\/\/[^\s]+\.mp4(?:[?#]|$)/i.test(fallbackSrc)) {
    return { source: "facebook", container: "mp4", url: fallbackSrc, filename: `facebook-${videoId}.mp4` };
  }
  const response = await fetcher(`https://www.facebook.com/watch/?v=${encodeURIComponent(videoId)}`, {
    credentials: "include",
    headers: { Accept: "text/html" }
  });
  if (!response.ok) throw new Error(`Facebook video lookup failed (${response.status}).`);
  const html = await response.text();
  const url = parseFacebookVideoUrl(html);
  if (url) return { source: "facebook", container: "mp4", url, filename: `facebook-${videoId}.mp4` };
  const tracks = parseFacebookDashTracks(parseFacebookDashManifest(html));
  if (!tracks) throw new Error("Facebook did not expose a downloadable video for this post.");
  return {
    source: "facebook",
    container: tracks.audioUrl ? "dash" : "mp4",
    url: tracks.videoUrl,
    ...(tracks.audioUrl ? { audioUrl: tracks.audioUrl } : {}),
    filename: `facebook-${videoId}.mp4`
  };
}
