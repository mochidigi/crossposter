// This function is serialized by chrome.scripting.executeScript and runs in
// YouTube's MAIN world. Keep it self-contained: module-scope references are not
// available after Chrome moves the function into the page.
export async function readYoutubePlayerData() {
  const flexy = document.querySelector("ytd-watch-flexy");
  const current = flexy?.playerData || globalThis.ytInitialPlayerResponse || null;
  const videoId = current?.videoDetails?.videoId || new URL(location.href).searchParams.get("v") || "";
  const apiKey = globalThis.ytcfg?.get?.("INNERTUBE_API_KEY") || "";
  let response = null;
  if (videoId && apiKey) {
    try {
      const request = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          context: {
            client: { clientName: "ANDROID", clientVersion: "20.10.38", hl: "en", gl: "US" }
          }
        })
      });
      const candidate = request.ok ? await request.json() : null;
      if (candidate?.playabilityStatus?.status === "OK" && candidate.streamingData) response = candidate;
    } catch {}
  }
  response ||= current;
  if (!response) return null;
  return {
    videoDetails: response.videoDetails || null,
    streamingData: response.streamingData || null
  };
}

function isHttpUrl(value) {
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
}

function bestFormat(formats, predicate) {
  return (Array.isArray(formats) ? formats : [])
    .filter(format => isHttpUrl(format?.url) && predicate(format))
    .sort((a, b) => Number(b.height || 0) - Number(a.height || 0) || Number(b.bitrate || 0) - Number(a.bitrate || 0))[0] || null;
}

export function youtubeVideoInfo(playerData = {}) {
  const streaming = playerData?.streamingData || {};
  const details = playerData?.videoDetails || {};
  const videoId = String(details.videoId || "");
  const progressive = bestFormat(streaming.formats, format => /^video\/mp4\b/i.test(format.mimeType || ""));
  if (progressive) {
    return { source: "youtube", videoId, container: "mp4", src: progressive.url };
  }

  const adaptive = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : [];
  const videos = adaptive.filter(format => Number(format.height || 0) <= 720);
  const video = bestFormat(videos.length ? videos : adaptive, format => /^video\/mp4\b/i.test(format.mimeType || "") && /avc1/i.test(format.mimeType || ""));
  const audio = bestFormat(adaptive, format => /^audio\/mp4\b/i.test(format.mimeType || ""));
  if (video && audio) {
    return { source: "youtube", videoId, container: "dash", src: video.url, audioUrl: audio.url };
  }

  if (isHttpUrl(streaming.hlsManifestUrl)) {
    return { source: "youtube", videoId, container: "hls", src: streaming.hlsManifestUrl };
  }
  return { source: "youtube", videoId, src: "" };
}

export function resolveYoutube(info = {}) {
  if (!isHttpUrl(info.src)) throw new Error("YouTube did not expose a reusable video stream for this video.");
  const container = info.container === "dash" && isHttpUrl(info.audioUrl)
    ? "dash"
    : info.container === "hls" || /\.m3u8(?:[?#]|$)/i.test(info.src)
      ? "hls"
      : "mp4";
  return {
    source: "youtube",
    container,
    url: info.src,
    ...(container === "dash" ? { audioUrl: info.audioUrl } : {}),
    filename: `youtube-${info.videoId || "video"}.mp4`
  };
}
