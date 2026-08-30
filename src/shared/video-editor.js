import { loadFfmpeg } from "./hls.js";

export const MIN_CLIP_SECONDS = 0.5;
export const MAX_CLIP_INPUT_BYTES = 250 * 1024 * 1024;

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

export function trimCommand(range, crop = null) {
  const command = [
    "-ss", range.start.toFixed(3),
    "-i", "input.mp4",
    "-t", range.duration.toFixed(3),
    "-map", "0:v?",
    "-map", "0:a?"
  ];
  if (crop) command.push("-vf", crop.x == null ? cropFilter(crop.width, crop.height, crop.aspect) : cropFilter(crop), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "copy");
  else command.push("-c", "copy");
  command.push(
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    "output.mp4"
  );
  return command;
}

export function compatibleTrimCommand(range, crop = null) {
  const command = [
    "-i", "input.mp4",
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
  if (blob.size > MAX_CLIP_INPUT_BYTES) throw new Error("This video is too large to clip in the browser (250 MB maximum).");
  const normalized = normalizeTrimRange(range.start, range.end, range.total || range.end);
  const ffmpeg = await getFfmpeg();
  const progress = ({ progress: ratio }) => onProgress(0.15 + Math.max(0, Math.min(Number(ratio) || 0, 1)) * 0.75);
  ffmpeg.on?.("progress", progress);
  try {
    onProgress(0.1);
    await ffmpeg.writeFile("input.mp4", new Uint8Array(await blob.arrayBuffer()));
    onProgress(0.15);
    let exitCode = await ffmpeg.exec(trimCommand(normalized, range.crop));
    if (exitCode !== 0) {
      // Facebook commonly supplies AV1 video and HE-AAC audio as separate DASH
      // tracks. They mux cleanly for sharing, but stream-copy seeking or copied
      // audio timestamps can fail during edits. Retry as a conventional,
      // broadly compatible H.264/AAC MP4.
      await ffmpeg.deleteFile?.("output.mp4").catch?.(() => {});
      exitCode = await ffmpeg.exec(compatibleTrimCommand(normalized, range.crop));
    }
    if (exitCode !== 0) throw new Error("FFmpeg could not create this clip.");
    const output = await ffmpeg.readFile("output.mp4");
    onProgress(1);
    return new Blob([output], { type: "video/mp4" });
  } finally {
    ffmpeg.off?.("progress", progress);
    await Promise.allSettled([ffmpeg.deleteFile?.("input.mp4"), ffmpeg.deleteFile?.("output.mp4")].filter(Boolean));
  }
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
