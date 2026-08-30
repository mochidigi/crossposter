export const IMAGE_CROP_PRESETS = Object.freeze({
  free: null,
  square: 1,
  portrait: 4 / 5,
  landscape: 16 / 9
});

export function centeredCrop(width, height, aspect) {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 0));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 0));
  const ratio = Number(aspect);
  if (!Number.isFinite(ratio) || ratio <= 0) return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  let cropWidth = sourceWidth, cropHeight = Math.round(cropWidth / ratio);
  if (cropHeight > sourceHeight) { cropHeight = sourceHeight; cropWidth = Math.round(cropHeight * ratio); }
  return {
    x: Math.round((sourceWidth - cropWidth) / 2),
    y: Math.round((sourceHeight - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight
  };
}

export function canvasBlob(canvas, type = "image/jpeg", quality = 0.92) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The edited image could not be created.")), type, quality));
}
