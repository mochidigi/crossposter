const MP4 = "video/mp4";
const HLS_TYPES = ["application/x-mpegurl", "application/vnd.apple.mpegurl"];

export function bestByBitrate(variants) {
  const mp4 = variants.filter(variant => (variant.contentType || "").toLowerCase() === MP4 && variant.url);
  if (mp4.length) {
    return { container: "mp4", url: mp4.reduce((best, variant) => (variant.bitrate || 0) >= (best.bitrate || 0) ? variant : best).url };
  }
  const hls = variants.find(variant => HLS_TYPES.includes((variant.contentType || "").toLowerCase()) && variant.url);
  return hls ? { container: "hls", url: hls.url } : null;
}
