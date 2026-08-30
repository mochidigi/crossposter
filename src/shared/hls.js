import { ext } from "./browser.js";

// HLS -> MP4 remux. Only reached for stream-only videos (no progressive mp4).
// ffmpeg.wasm is heavy (~30 MB), so it is imported lazily the first time an HLS
// download actually runs — never at extension start.

// Pick the highest-bandwidth video playlist and its associated audio playlist
// from a master. UpScrolled/Mux uses separate fragmented-MP4 renditions.
export function selectHlsRenditions(masterText, masterUrl, { maxBandwidth = Infinity } = {}) {
  if (/#EXTINF/.test(masterText)) return { videoUrl: masterUrl, audioUrl: null };
  const lines = masterText.split(/\r?\n/);
  const audioGroups = new Map();
  for (const line of lines) {
    if (!line.startsWith("#EXT-X-MEDIA") || attribute(line, "TYPE") !== "AUDIO") continue;
    const group = attribute(line, "GROUP-ID"), uri = attribute(line, "URI");
    if (group && uri && (!audioGroups.has(group) || attribute(line, "DEFAULT") === "YES")) {
      audioGroups.set(group, new URL(uri, masterUrl).href);
    }
  }
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const bandwidth = Number(attribute(lines[i], "BANDWIDTH") || 0);
    const uri = lines[i + 1]?.trim();
    if (uri && !uri.startsWith("#")) variants.push({ bandwidth, uri, audioGroup: attribute(lines[i], "AUDIO") });
  }
  const withinLimit = variants.filter(variant => variant.bandwidth <= maxBandwidth);
  const choices = withinLimit.length ? withinLimit : variants;
  const best = choices.reduce((selected, variant) => {
    if (!selected) return variant;
    return withinLimit.length
      ? (variant.bandwidth > selected.bandwidth ? variant : selected)
      : (variant.bandwidth < selected.bandwidth ? variant : selected);
  }, null);
  if (!best) return { videoUrl: masterUrl, audioUrl: null };
  return { videoUrl: new URL(best.uri, masterUrl).href, audioUrl: audioGroups.get(best.audioGroup) || null };
}

export function selectHlsVariant(masterText, masterUrl, options) {
  return selectHlsRenditions(masterText, masterUrl, options).videoUrl;
}

function attribute(line, name) {
  const match = line.match(new RegExp(`(?:^|[:,])${name}=(?:"([^"]*)"|([^,]*))`, "i"));
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

// Resolve the ordered list of segment URLs from a media playlist.
export function parseHlsSegments(mediaText, mediaUrl) {
  if (/#EXT-X-KEY(?!:METHOD=NONE)/.test(mediaText)) {
    throw new Error("This stream is encrypted and can't be downloaded.");
  }
  const init = mediaText.match(/#EXT-X-MAP:[^\r\n]*URI="([^"]+)"/i)?.[1];
  const segments = mediaText.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"))
    .map(uri => new URL(uri, mediaUrl).href);
  return init ? [new URL(init, mediaUrl).href, ...segments] : segments;
}

let ffmpegPromise;
export function loadFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import(ext.runtime.getURL("vendor/ffmpeg/ffmpeg/index.js"));
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: ext.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.js"),
        wasmURL: ext.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.wasm")
      });
      return ffmpeg;
    })().catch(error => {
      ffmpegPromise = null;
      throw error;
    });
  }
  return ffmpegPromise;
}

// Download every segment, concatenate the transport stream, and remux (stream
// copy, no re-encode) to MP4. Dependencies are injected so the parsing/plumbing
// is testable without a real browser or ffmpeg.
export async function muxHlsToMp4(playlistUrl, { fetcher = fetch, onProgress = () => {}, loadFfmpeg: getFfmpeg = loadFfmpeg, maxBandwidth = Infinity } = {}) {
  const masterText = await fetchText(fetcher, playlistUrl);
  const { videoUrl, audioUrl } = selectHlsRenditions(masterText, playlistUrl, { maxBandwidth });
  const videoText = videoUrl === playlistUrl ? masterText : await fetchText(fetcher, videoUrl);
  const audioText = audioUrl ? await fetchText(fetcher, audioUrl) : "";
  const videoSegments = parseHlsSegments(videoText, videoUrl);
  const audioSegments = audioUrl ? parseHlsSegments(audioText, audioUrl) : [];
  if (!videoSegments.length) throw new Error("This stream has no downloadable segments.");

  const segmentTotal = videoSegments.length + audioSegments.length;
  let downloaded = 0;
  const download = async urls => {
    const chunks = [];
    for (const url of urls) {
      const response = await fetcher(url);
      if (response.ok === false) throw new Error(`A video segment could not be downloaded (${response.status}).`);
      chunks.push(new Uint8Array(await response.arrayBuffer()));
      downloaded += 1;
      onProgress(downloaded / segmentTotal * 0.8);
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    return joined;
  };
  const videoBytes = await download(videoSegments);
  const audioBytes = audioSegments.length ? await download(audioSegments) : null;

  const ffmpeg = await getFfmpeg();
  onProgress(0.9);
  await ffmpeg.writeFile("input-video.mp4", videoBytes);
  if (audioBytes) await ffmpeg.writeFile("input-audio.mp4", audioBytes);
  try {
    const command = audioBytes
      ? ["-i", "input-video.mp4", "-i", "input-audio.mp4", "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", "output.mp4"]
      : ["-i", "input-video.mp4", "-c", "copy", "-movflags", "+faststart", "output.mp4"];
    const exitCode = await ffmpeg.exec(command);
    if (exitCode !== 0) throw new Error("FFmpeg could not prepare this stream.");
    const out = await ffmpeg.readFile("output.mp4");
    onProgress(1);
    return new Blob([out], { type: "video/mp4" });
  } finally {
    await Promise.allSettled([
      ffmpeg.deleteFile?.("input-video.mp4"),
      audioBytes ? ffmpeg.deleteFile?.("input-audio.mp4") : null,
      ffmpeg.deleteFile?.("output.mp4")
    ].filter(Boolean));
  }
}

// Facebook's DASH player exposes complete MP4 video and audio tracks rather
// than HLS segments. Join those tracks without re-encoding.
export async function muxMp4Tracks(videoUrl, audioUrl, { fetcher = fetch, onProgress = () => {}, loadFfmpeg: getFfmpeg = loadFfmpeg } = {}) {
  if (!videoUrl || !audioUrl) throw new Error("This video is missing a downloadable track.");
  const download = async (url, progress) => {
    const response = await fetcher(url);
    if (response.ok === false) throw new Error(`A video track could not be downloaded (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress(progress);
    return bytes;
  };
  const [videoBytes, audioBytes] = await Promise.all([
    download(videoUrl, 0.4),
    download(audioUrl, 0.8)
  ]);
  const ffmpeg = await getFfmpeg();
  await ffmpeg.writeFile("input-video.mp4", videoBytes);
  await ffmpeg.writeFile("input-audio.mp4", audioBytes);
  try {
    const exitCode = await ffmpeg.exec(["-i", "input-video.mp4", "-i", "input-audio.mp4", "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", "output.mp4"]);
    if (exitCode !== 0) throw new Error("FFmpeg could not prepare this Facebook video.");
    const out = await ffmpeg.readFile("output.mp4");
    onProgress(1);
    return new Blob([out], { type: "video/mp4" });
  } finally {
    await Promise.allSettled([
      ffmpeg.deleteFile?.("input-video.mp4"),
      ffmpeg.deleteFile?.("input-audio.mp4"),
      ffmpeg.deleteFile?.("output.mp4")
    ].filter(Boolean));
  }
}

async function fetchText(fetcher, url) {
  const response = await fetcher(url);
  if (response.ok === false) throw new Error(`A video playlist could not be downloaded (${response.status}).`);
  return response.text();
}
