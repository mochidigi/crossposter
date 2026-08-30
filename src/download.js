import { ext } from "./shared/browser.js";
import { muxHlsToMp4 } from "./shared/hls.js";

const status = document.querySelector("#status");
const bar = document.querySelector("#bar");
const setProgress = ratio => { bar.style.width = `${Math.round(ratio * 100)}%`; };

const { pendingDownload } = await ext.storage.local.get("pendingDownload");
await ext.storage.local.remove("pendingDownload");

if (!pendingDownload || pendingDownload.container !== "hls") {
  status.textContent = "Nothing to download.";
} else {
  try {
    status.textContent = "Converting the stream to MP4…";
    const blob = await muxHlsToMp4(pendingDownload.url, { onProgress: setProgress });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = pendingDownload.filename || "video.mp4";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = "Done. Your download should be starting.";
  } catch (error) {
    setProgress(0);
    status.textContent = error instanceof Error ? error.message : "The video could not be downloaded.";
    document.querySelector("#hint").textContent = "Stream conversion needs the ffmpeg add-on; run npm run build to fetch it.";
  }
}
