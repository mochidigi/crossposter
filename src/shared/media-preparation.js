import { muxHlsToMp4, muxMp4Tracks } from "./hls.js";

export function isStreamMedia(item = {}) {
  return item?.kind === "video" && (["hls", "dash"].includes(item.streamType) || /\.m3u8(?:[?#]|$)/i.test(item.url || ""));
}

export function prepareStreamMedia(item, { muxHls = muxHlsToMp4, muxDash = muxMp4Tracks } = {}) {
  if (!isStreamMedia(item)) throw new Error("This media item is not a downloadable stream.");
  return item.streamType === "dash"
    ? muxDash(item.url, item.audioUrl)
    : muxHls(item.url);
}
