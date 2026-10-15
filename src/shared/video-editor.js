import { loadFfmpeg } from "./hls.js";

export const MIN_CLIP_SECONDS = 0.5;
// The source is mounted read-only (WORKERFS), so ffmpeg reads it from the Blob
// and only the clip lives in wasm memory (2 GB at most), along with the copy
// readFile hands back. The limit applies to the clip's share of the source;
// a re-encode can come out larger than that.
export const MAX_CLIP_BYTES = 500 * 1024 * 1024;

let mountCount = 0;

export function canCommitClip(operation, currentOperation) {
  return operation === currentOperation && operation?.cancelled !== true;
}

export function normalizeTrimRange(start, end, duration) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) throw new Error("The video duration is unavailable.");
  const from = Math.max(0, Math.min(Number(start) || 0, total));
  const to = Math.max(from, Math.min(Number(end) || total, total));
  if (to - from < MIN_CLIP_SECONDS) throw new Error(`Choose at least ${MIN_CLIP_SECONDS} seconds.`);
  return { start: from, end: to, duration: to - from };
}

export function cropFilter(width, height, aspect) {
  const crop = typeof width === "object" ? normalizePixelCrop(width) : centeredVideoCrop(width, height, aspect);
  return crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}` : "";
}

export function centeredVideoCrop(width, height, aspect) {
  const w = Math.floor(Number(width) / 2) * 2, h = Math.floor(Number(height) / 2) * 2, ratio = Number(aspect);
  if (!w || !h || !Number.isFinite(ratio) || ratio <= 0) return null;
  let cropWidth = Math.floor(w / 2) * 2, cropHeight = Math.floor((cropWidth / ratio) / 2) * 2;
  if (cropHeight > h) { cropHeight = h; cropWidth = Math.floor((cropHeight * ratio) / 2) * 2; }
  return { width: cropWidth, height: cropHeight, x: Math.floor((w - cropWidth) / 4) * 2, y: Math.floor((h - cropHeight) / 4) * 2 };
}

export function videoCropFromNormalized(width, height, rect) {
  const sourceWidth = evenFloor(Number(width)), sourceHeight = evenFloor(Number(height));
  if (sourceWidth < 2 || sourceHeight < 2 || !rect) return null;
  const left = clamp(Number(rect.x) || 0, 0, 1), top = clamp(Number(rect.y) || 0, 0, 1);
  const cropWidth = Math.max(2, evenFloor(clamp(Number(rect.width) || 0, 0, 1 - left) * sourceWidth));
  const cropHeight = Math.max(2, evenFloor(clamp(Number(rect.height) || 0, 0, 1 - top) * sourceHeight));
  const x = Math.min(evenFloor(left * sourceWidth), sourceWidth - cropWidth);
  const y = Math.min(evenFloor(top * sourceHeight), sourceHeight - cropHeight);
  return { width: cropWidth, height: cropHeight, x, y };
}

// A stream copy can only begin at a keyframe, so a copied clip whose start
// moved begins at the keyframe before it (X's are 3 s apart). That is the
// Fast cut: instant and lossless. A Precise cut (`exact`) re-encodes when the
// start moved, at about the clip's own length in time. A crop always
// re-encodes; a clip that keeps the start is exact either way.
export function clipReencodes(range, crop = null, { exact = false } = {}) {
  return Boolean(crop) || (exact && range.start > 0);
}

export function trimCommand(range, crop = null, { exact = false, input = "input.mp4" } = {}) {
  const command = [
    "-ss", range.start.toFixed(3),
    "-i", input,
    "-t", range.duration.toFixed(3),
    "-map", "0:v?",
    "-map", "0:a?"
  ];
  if (crop) command.push("-vf", crop.x == null ? cropFilter(crop.width, crop.height, crop.aspect) : cropFilter(crop));
  // A re-encoded video starts exactly at the trim point. Copied audio would
  // start at the keyframe before it instead, and -avoid_negative_ts then
  // delays the video behind an edit list that browsers ignore, so the audio
  // ran about a second early (an X clip, 2026-10-12). Re-encoding the audio
  // trims it at the same point.
  if (clipReencodes(range, crop, { exact })) command.push("-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "128k");
  else command.push("-c", "copy");
  command.push(
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    "output.mp4"
  );
  return command;
}

export function compatibleTrimCommand(range, crop = null, { input = "input.mp4" } = {}) {
  const command = [
    "-i", input,
    // Seeking after opening the input is slower, but is frame-accurate and
    // works around AV1 keyframe/timestamp failures seen in Facebook clips.
    "-ss", range.start.toFixed(3),
    "-t", range.duration.toFixed(3),
    "-map", "0:v?",
    "-map", "0:a?"
  ];
  if (crop) command.push("-vf", crop.x == null ? cropFilter(crop.width, crop.height, crop.aspect) : cropFilter(crop));
  command.push(
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "output.mp4"
  );
  return command;
}

export async function trimVideo(input, range, {
  fetcher = fetch,
  onProgress = () => {},
  getFfmpeg = loadFfmpeg
} = {}) {
  onProgress(0.02);
  const blob = input instanceof Blob ? input : await fetcher(input).then(assertOk).then(response => response.blob());
  const total = range.total || range.end;
  const normalized = normalizeTrimRange(range.start, range.end, total);
  if (blob.size * (normalized.duration / total) > MAX_CLIP_BYTES) {
    throw new Error(`This clip is too large to make in the browser. Choose ${formatSeconds(MAX_CLIP_BYTES / blob.size * total)} or less.`);
  }
  const ffmpeg = await getFfmpeg();
  const progress = ({ progress: ratio }) => onProgress(0.15 + Math.max(0, Math.min(Number(ratio) || 0, 1)) * 0.75);
  ffmpeg.on?.("progress", progress);
  // Mount the source instead of writing it into wasm memory: WORKERFS reads
  // only the slices ffmpeg asks for. It is read-only, so the output goes to
  // the default in-memory filesystem.
  const mountPoint = `/clip-source-${++mountCount}`, source = `${mountPoint}/input.mp4`;
  let mounted = false;
  try {
    onProgress(0.1);
    await ffmpeg.createDir(mountPoint);
    if (await ffmpeg.mount("WORKERFS", { blobs: [{ name: "input.mp4", data: blob }] }, mountPoint) === false) {
      throw new Error("This browser cannot read the video for clipping.");
    }
    mounted = true;
    onProgress(0.15);
    let exitCode = await ffmpeg.exec(trimCommand(normalized, range.crop, { exact: range.exact === true, input: source }));
    if (exitCode !== 0) {
      // Facebook commonly supplies AV1 video and HE-AAC audio as separate DASH
      // tracks. They mux cleanly for sharing, but stream-copy seeking or copied
      // audio timestamps can fail during edits. Retry as a conventional,
      // broadly compatible H.264/AAC MP4.
      await ffmpeg.deleteFile?.("output.mp4").catch?.(() => {});
      exitCode = await ffmpeg.exec(compatibleTrimCommand(normalized, range.crop, { input: source }));
    }
    if (exitCode !== 0) throw new Error("FFmpeg could not create this clip.");
    const output = await ffmpeg.readFile("output.mp4");
    onProgress(1);
    return new Blob([output], { type: "video/mp4" });
  } finally {
    ffmpeg.off?.("progress", progress);
    await ffmpeg.deleteFile?.("output.mp4").catch?.(() => {});
    if (mounted) await ffmpeg.unmount(mountPoint).catch?.(() => {});
    await ffmpeg.deleteDir(mountPoint).catch?.(() => {});
  }
}

function formatSeconds(seconds) {
  const whole = Math.max(1, Math.floor(seconds)), minutes = Math.floor(whole / 60), rest = whole % 60;
  if (!minutes) return `${whole} s`;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

function assertOk(response) {
  if (!response.ok) throw new Error(`Could not fetch the video (${response.status}).`);
  return response;
}

function normalizePixelCrop(crop) {
  const width = Math.max(2, evenFloor(Number(crop.width))), height = Math.max(2, evenFloor(Number(crop.height)));
  const x = Math.max(0, evenFloor(Number(crop.x))), y = Math.max(0, evenFloor(Number(crop.y)));
  return Number.isFinite(width + height + x + y) ? { width, height, x, y } : null;
}
function evenFloor(value) { return Math.floor(value / 2) * 2; }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(value, maximum)); }
