import { Canvas, FabricImage, Group, IText, Line, Rect, Shadow, Triangle } from "../vendor/fabric/fabric.mjs";
import { IMAGE_CROP_PRESETS } from "./image-editor.js";

const PREVIEW_MAX_WIDTH = 860;
const PREVIEW_MAX_HEIGHT = 480;
export const DEFAULT_MARKUP_COLOR = "#ff2d55";
const MARKUP_SIZE = 7;
const MARKUP_FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
export const FABRIC_TOP_LEFT = Object.freeze({ originX: "left", originY: "top" });
export const IMAGE_EDITOR_TOOLS = Object.freeze(["select", "highlight", "rectangle", "arrow", "text", "crop"]);
export const IMAGE_EDITOR_COLOR_TOOLS = Object.freeze(["text", "highlight", "arrow", "rectangle"]);
export function isImageEditorDeleteKey(event) {
  return event?.key === "Delete" || event?.key === "Backspace";
}

// Draws the crop mask above the objects and below the selection controls.
class EditorCanvas extends Canvas {
  _renderOverlay(ctx) {
    super._renderOverlay(ctx);
    this.renderEditorOverlay?.(ctx);
  }
}

export class FabricImageEditor {
  constructor(element, { onHistory = () => {}, onToolChange = () => {}, onSelection = () => {} } = {}) {
    this.canvas = new EditorCanvas(element, { preserveObjectStacking: true, selection: true, controlsAboveOverlay: true });
    this.canvas.renderEditorOverlay = ctx => this.renderCropMask(ctx);
    this.onHistory = onHistory; this.onToolChange = onToolChange; this.onSelection = onSelection;
    this.textareaContainer = element.closest("dialog") || element.ownerDocument.body;
    this.tool = "select"; this.color = DEFAULT_MARKUP_COLOR; this.history = []; this.historyIndex = -1; this.restoring = false;
    this.draftObject = null; this.start = null; this.cropObject = null; this.outputScale = 1;
    this.handleKeyDown = event => this.keyDown(event);
    element.ownerDocument.addEventListener("keydown", this.handleKeyDown);
    this.canvas.on("mouse:down", event => this.pointerDown(event));
    this.canvas.on("mouse:move", event => this.pointerMove(event));
    this.canvas.on("mouse:up", () => this.pointerUp());
    this.canvas.on("object:modified", () => this.commitHistory());
    this.canvas.on("object:moving", ({ target }) => { if (target === this.cropObject) this.keepCropInside(); });
    this.canvas.on("text:editing:exited", () => this.commitHistory());
    for (const event of ["selection:created", "selection:updated", "selection:cleared"]) this.canvas.on(event, () => this.onSelection(this.selectedMarkup()));
  }

  async load(image, { maxWidth = PREVIEW_MAX_WIDTH, maxHeight = PREVIEW_MAX_HEIGHT } = {}) {
    this.canvas.clear();
    const scale = Math.min(1, Math.max(1, maxWidth) / image.naturalWidth, Math.max(1, maxHeight) / image.naturalHeight);
    const width = Math.max(1, Math.round(image.naturalWidth * scale)), height = Math.max(1, Math.round(image.naturalHeight * scale));
    // Measured from the rounded preview width, so an unedited export keeps the
    // source's exact width (and its height to within a pixel).
    this.outputScale = image.naturalWidth / width;
    this.loadedSize = { width, height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
    this.canvas.setDimensions({ width, height });
    this.background = new FabricImage(image, {
      ...FABRIC_TOP_LEFT,
      left: 0, top: 0, scaleX: width / image.naturalWidth, scaleY: height / image.naturalHeight,
      selectable: false, evented: false, editorType: "background"
    });
    this.canvas.add(this.background); this.canvas.sendObjectToBack(this.background);
    this.history = []; this.historyIndex = -1; this.commitHistory(); this.setTool("select");
  }

  // Size of the exported image, in source pixels.
  outputSize() {
    const loaded = this.loadedSize, { width, height } = this.canvas;
    // Uncropped (or only rotated): report the source's own size, not the
    // preview's rounding.
    if (loaded && width === loaded.width && height === loaded.height) return { width: loaded.naturalWidth, height: loaded.naturalHeight };
    if (loaded && width === loaded.height && height === loaded.width) return { width: loaded.naturalHeight, height: loaded.naturalWidth };
    return { width: Math.round(width * this.outputScale), height: Math.round(height * this.outputScale) };
  }

  setTool(tool) {
    if (!IMAGE_EDITOR_TOOLS.includes(tool)) throw new Error(`Unknown image editor tool: ${tool}`);
    this.cancelCrop(); this.tool = tool;
    this.canvas.isDrawingMode = false;
    this.canvas.selection = tool === "select";
    this.canvas.skipTargetFind = tool !== "select";
    this.canvas.defaultCursor = tool === "select" ? "default" : "crosshair";
    this.canvas.discardActiveObject(); this.canvas.requestRenderAll(); this.onToolChange(tool);
  }

  setColor(color) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return false;
    this.color = color.toLowerCase();
    let changed = false;
    for (const object of this.canvas.getActiveObjects()) changed = applyMarkupColor(object, this.color) || changed;
    if (changed) { this.canvas.requestRenderAll(); this.commitHistory(); }
    return true;
  }

  beginCrop(preset = "free") {
    this.setTool("crop");
    const aspect = IMAGE_CROP_PRESETS[preset], width = this.canvas.width * 0.8;
    let height = aspect ? width / aspect : this.canvas.height * 0.8;
    let cropWidth = width;
    if (height > this.canvas.height * 0.9) { height = this.canvas.height * 0.9; cropWidth = aspect ? height * aspect : width; }
    this.cropObject = new Rect({
      ...FABRIC_TOP_LEFT,
      left: (this.canvas.width - cropWidth) / 2, top: (this.canvas.height - height) / 2,
      width: cropWidth, height, fill: "transparent", stroke: "#fff", strokeWidth: 2, strokeUniform: true,
      hasBorders: false, cornerSize: 26, touchCornerSize: 34,
      lockRotation: true, lockScalingFlip: true, editorType: "crop-guide"
    });
    this.cropObject.setControlsVisibility({ mtr: false });
    for (const [key, control] of Object.entries(this.cropObject.controls)) {
      if (["tl", "tr", "bl", "br"].includes(key)) control.render = renderCropCorner;
      if (["mt", "mb", "ml", "mr"].includes(key)) control.render = renderCropEdge;
    }
    if (aspect) {
      this.cropObject.set({ lockUniScaling: true });
      this.cropObject.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
    }
    this.canvas.skipTargetFind = false; this.canvas.add(this.cropObject); this.canvas.setActiveObject(this.cropObject); this.canvas.requestRenderAll();
  }

  keepCropInside() {
    const crop = this.cropObject, bounds = crop.getBoundingRect();
    const dx = clamp(bounds.left, 0, Math.max(0, this.canvas.width - bounds.width)) - bounds.left;
    const dy = clamp(bounds.top, 0, Math.max(0, this.canvas.height - bounds.height)) - bounds.top;
    if (dx || dy) { crop.set({ left: crop.left + dx, top: crop.top + dy }); crop.setCoords(); }
  }

  renderCropMask(ctx) {
    if (!this.cropObject) return;
    const { left, top, width, height } = this.cropObject.getBoundingRect();
    ctx.save();
    ctx.fillStyle = "rgba(12, 12, 12, .62)";
    ctx.beginPath(); ctx.rect(0, 0, this.canvas.width, this.canvas.height); ctx.rect(left, top, width, height); ctx.fill("evenodd");
    ctx.strokeStyle = "rgba(255, 255, 255, .5)"; ctx.lineWidth = 1; ctx.beginPath();
    for (const fraction of [1 / 3, 2 / 3]) {
      ctx.moveTo(left + width * fraction, top); ctx.lineTo(left + width * fraction, top + height);
      ctx.moveTo(left, top + height * fraction); ctx.lineTo(left + width, top + height * fraction);
    }
    ctx.stroke(); ctx.restore();
  }

  applyCrop() {
    if (!this.cropObject) return false;
    const bounds = this.cropObject.getBoundingRect();
    const left = clamp(bounds.left, 0, this.canvas.width - 1), top = clamp(bounds.top, 0, this.canvas.height - 1);
    const right = clamp(bounds.left + bounds.width, left + 1, this.canvas.width), bottom = clamp(bounds.top + bounds.height, top + 1, this.canvas.height);
    this.canvas.remove(this.cropObject); this.cropObject = null;
    for (const object of this.canvas.getObjects()) object.set({ left: object.left - left, top: object.top - top });
    this.canvas.setDimensions({ width: Math.round(right - left), height: Math.round(bottom - top) });
    this.canvas.requestRenderAll(); this.commitHistory(); this.setTool("select"); return true;
  }

  cancelCrop() {
    if (!this.cropObject) return;
    this.canvas.remove(this.cropObject); this.cropObject = null; this.canvas.requestRenderAll();
  }

  rotate() {
    this.cancelCrop();
    const oldWidth = this.canvas.width, oldHeight = this.canvas.height;
    for (const object of this.canvas.getObjects()) {
      const center = object.getCenterPoint();
      object.set({ left: oldHeight - center.y, top: center.x, originX: "center", originY: "center", angle: (object.angle + 90) % 360 });
      object.setCoords();
    }
    this.canvas.setDimensions({ width: oldHeight, height: oldWidth }); this.canvas.requestRenderAll(); this.commitHistory(); this.setTool("select");
  }

  async undo() { if (this.historyIndex > 0) await this.restoreHistory(this.historyIndex - 1); }
  async redo() { if (this.historyIndex < this.history.length - 1) await this.restoreHistory(this.historyIndex + 1); }

  commitHistory() {
    if (this.restoring || this.cropObject) return;
    const snapshot = JSON.stringify({ width: this.canvas.width, height: this.canvas.height, json: this.canvas.toJSON(["editorType"]) });
    if (snapshot === this.history[this.historyIndex]) return;
    this.history.splice(this.historyIndex + 1); this.history.push(snapshot); this.historyIndex = this.history.length - 1; this.onHistory(this.historyIndex, this.history.length);
  }

  async restoreHistory(index) {
    this.restoring = true; this.cancelCrop();
    const snapshot = JSON.parse(this.history[index]);
    this.canvas.setDimensions({ width: snapshot.width, height: snapshot.height });
    await this.canvas.loadFromJSON(snapshot.json);
    this.background = this.canvas.getObjects().find(object => object.editorType === "background");
    this.historyIndex = index; this.restoring = false; this.canvas.requestRenderAll(); this.onHistory(index, this.history.length); this.setTool("select");
  }

  pointerDown(event) {
    if (["select", "crop"].includes(this.tool)) return;
    const point = this.canvas.getScenePoint(event.e); this.start = point;
    if (this.tool === "text") {
      const text = new IText("Type here", {
        ...FABRIC_TOP_LEFT, left: point.x, top: point.y, fill: this.color, fontFamily: MARKUP_FONT, fontWeight: 700,
        fontSize: MARKUP_SIZE * 3.4, shadow: new Shadow({ color: "rgba(0,0,0,.35)", blur: 6, offsetY: 1 }),
        hiddenTextareaContainer: this.textareaContainer, editorType: "text"
      });
      this.canvas.add(text); this.tool = "select"; this.canvas.isDrawingMode = false; this.canvas.selection = true; this.canvas.skipTargetFind = false; this.canvas.defaultCursor = "default";
      this.canvas.setActiveObject(text); this.canvas.requestRenderAll(); this.onToolChange("select");
      setTimeout(() => { this.canvas.setActiveObject(text); text.enterEditing(); text.selectAll(); text.hiddenTextarea?.focus(); this.canvas.requestRenderAll(); }, 0);
      return;
    }
    const common = { ...FABRIC_TOP_LEFT, left: point.x, top: point.y, width: 1, height: 1, selectable: false, evented: false, editorType: this.tool };
    if (this.tool === "highlight") this.draftObject = new Rect({ ...common, fill: withAlpha(this.color, 0.32), strokeWidth: 0 });
    if (this.tool === "rectangle") this.draftObject = new Rect({ ...common, fill: "transparent", stroke: this.color, strokeWidth: MARKUP_SIZE });
    if (this.tool === "arrow") this.draftObject = createArrow(point.x, point.y, point.x + 1, point.y + 1, this.color, MARKUP_SIZE);
    if (this.draftObject) this.canvas.add(this.draftObject);
  }

  pointerMove(event) {
    if (!this.draftObject || !this.start) return;
    const point = this.canvas.getScenePoint(event.e);
    if (this.tool === "arrow") {
      this.canvas.remove(this.draftObject); this.draftObject = createArrow(this.start.x, this.start.y, point.x, point.y, this.color, MARKUP_SIZE); this.canvas.add(this.draftObject);
    } else {
      this.draftObject.set({ left: Math.min(this.start.x, point.x), top: Math.min(this.start.y, point.y), width: Math.abs(point.x - this.start.x), height: Math.abs(point.y - this.start.y) });
    }
    this.canvas.requestRenderAll();
  }

  pointerUp() {
    if (!this.draftObject) return;
    const completedObject = this.draftObject;
    completedObject.set({ selectable: true, evented: true }); completedObject.setCoords();
    this.draftObject = null; this.start = null; this.commitHistory();
    this.setTool("select"); this.canvas.setActiveObject(completedObject); this.canvas.requestRenderAll();
    this.onSelection(this.selectedMarkup());
  }

  // The selected annotations (never the photo itself or the crop frame).
  selectedMarkup() {
    return this.canvas.getActiveObjects().filter(object => !["background", "crop-guide"].includes(object.editorType));
  }

  deleteSelection() {
    const activeObjects = this.canvas.getActiveObjects();
    if (!activeObjects.length || activeObjects.some(object => object.isEditing)) return false;
    const removableObjects = this.selectedMarkup();
    if (!removableObjects.length) return false;
    this.canvas.discardActiveObject();
    this.canvas.remove(...removableObjects);
    this.canvas.requestRenderAll();
    this.commitHistory();
    this.onSelection([]);
    return true;
  }

  keyDown(event) {
    if (!isImageEditorDeleteKey(event) || event.defaultPrevented) return;
    if (event.target?.matches?.("input, textarea, select, [contenteditable='true']")) return;
    if (!this.deleteSelection()) return;
    event.preventDefault();
    event.stopPropagation();
  }

  isEditingText() {
    return this.canvas.getActiveObjects().some(object => object.isEditing);
  }

  exportCanvas() {
    this.cancelCrop(); this.canvas.discardActiveObject(); this.canvas.requestRenderAll();
    return this.canvas.toCanvasElement(this.outputScale, { withoutTransform: false });
  }

  dispose() {
    this.canvas.lowerCanvasEl.ownerDocument.removeEventListener("keydown", this.handleKeyDown);
    this.canvas.dispose();
  }
}

// Crop frame controls: white corner brackets and edge bars instead of
// Fabric's default squares. `this` is the control; x/y say which corner.
function renderCropCorner(ctx, left, top) {
  const length = 20, inset = 1.5, dx = this.x < 0 ? 1 : -1, dy = this.y < 0 ? 1 : -1;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(left + dx * inset, top + dy * (inset + length)); ctx.lineTo(left + dx * inset, top + dy * inset); ctx.lineTo(left + dx * (inset + length), top + dy * inset);
  // A dark outline keeps the white bracket visible on bright pictures.
  ctx.lineCap = "square"; ctx.lineJoin = "miter";
  ctx.strokeStyle = "rgba(17,17,17,.7)"; ctx.lineWidth = 7; ctx.stroke();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 4; ctx.stroke();
  ctx.restore();
}
function renderCropEdge(ctx, left, top) {
  const horizontal = this.x === 0, [width, height] = horizontal ? [24, 4] : [4, 24];
  ctx.save();
  ctx.fillStyle = "rgba(17,17,17,.7)"; ctx.fillRect(left - width / 2 - 1.5, top - height / 2 - 1.5, width + 3, height + 3);
  ctx.fillStyle = "#fff"; ctx.fillRect(left - width / 2, top - height / 2, width, height);
  ctx.restore();
}

function createArrow(x1, y1, x2, y2, color, width) {
  const dx = x2 - x1, dy = y2 - y1, length = Math.max(1, Math.hypot(dx, dy)), angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const line = new Line([0, 0, length, 0], { stroke: color, strokeWidth: width, strokeLineCap: "round", originX: "left", originY: "center" });
  const head = new Triangle({ left: length, top: 0, width: Math.max(12, width * 3), height: Math.max(16, width * 4), fill: color, angle: 90, originX: "center", originY: "center" });
  return new Group([line, head], { left: x1, top: y1, angle, originX: "left", originY: "center", editorType: "arrow", selectable: false, evented: false });
}
export function applyMarkupColor(object, color) {
  if (!IMAGE_EDITOR_COLOR_TOOLS.includes(object.editorType)) return false;
  if (object.editorType === "highlight") object.set({ fill: withAlpha(color, 0.32) });
  if (object.editorType === "rectangle") object.set({ stroke: color });
  if (object.editorType === "text") object.set({ fill: color });
  if (object.editorType === "arrow") {
    object.getObjects().forEach((part, index) => part.set(index === 0 ? { stroke: color } : { fill: color }));
  }
  return true;
}
// The color an annotation was drawn with, as #rrggbb, or "" for other objects.
export function markupColor(object) {
  const type = object?.editorType;
  const value = type === "highlight" || type === "text" ? object.fill
    : type === "rectangle" ? object.stroke
    : type === "arrow" ? object.getObjects?.()[0]?.stroke
    : "";
  return toHex(value);
}
function toHex(value) {
  const text = String(value || "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const rgb = text.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return rgb ? `#${rgb.slice(1, 4).map(part => Number(part).toString(16).padStart(2, "0")).join("")}` : "";
}
function withAlpha(color, alpha) {
  const hex = color.replace("#", "");
  const value = hex.length === 3 ? hex.split("").map(character => character + character).join("") : hex;
  return `rgba(${parseInt(value.slice(0, 2), 16)},${parseInt(value.slice(2, 4), 16)},${parseInt(value.slice(4, 6), 16)},${alpha})`;
}
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(value, maximum)); }
