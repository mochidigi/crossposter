export const IMAGE_CROP_PRESETS = Object.freeze({
  free: null,
  square: 1,
  portrait: 4 / 5,
  landscape: 16 / 9,
  story: 9 / 16
});

// Annotation color presets; any other color comes from the custom picker.
export const MARKUP_COLORS = Object.freeze([
  { color: "#ff2d55", label: "Red" },
  { color: "#ffcc00", label: "Yellow" },
  { color: "#30d158", label: "Green" },
  { color: "#0a84ff", label: "Blue" },
  { color: "#ffffff", label: "White" },
  { color: "#111111", label: "Black" }
]);

// Single-letter tool shortcuts. The typed letter wins; layouts without Latin
// letters fall back to the physical key.
export const IMAGE_EDITOR_SHORTCUTS = Object.freeze({ v: "select", c: "crop", h: "highlight", r: "rectangle", a: "arrow", t: "text" });
export function imageEditorShortcut(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return "";
  const letter = /^[a-z]$/i.test(event.key || "") ? event.key.toLowerCase() : (/^Key([A-Z])$/.exec(event.code || "")?.[1] || "").toLowerCase();
  return IMAGE_EDITOR_SHORTCUTS[letter] || "";
}

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
