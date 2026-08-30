import { Canvas, FabricImage, Group, IText, Line, Rect, Triangle } from "../vendor/fabric/fabric.mjs";
import { IMAGE_CROP_PRESETS } from "./image-editor.js";

const PREVIEW_MAX_WIDTH = 860;
const PREVIEW_MAX_HEIGHT = 480;
export const DEFAULT_MARKUP_COLOR = "#ff2d55";
const MARKUP_SIZE = 7;
export const FABRIC_TOP_LEFT = Object.freeze({ originX: "left", originY: "top" });
export const IMAGE_EDITOR_TOOLS = Object.freeze(["select", "highlight", "rectangle", "arrow", "text", "crop"]);
export const IMAGE_EDITOR_COLOR_TOOLS = Object.freeze(["text", "highlight", "arrow", "rectangle"]);
export function isImageEditorDeleteKey(event) {
  return event?.key === "Delete" || event?.key === "Backspace";
}

export class FabricImageEditor {
  constructor(element, { onHistory = () => {}, onToolChange = () => {} } = {}) {
    this.canvas = new Canvas(element, { preserveObjectStacking: true, selection: true });
    this.onHistory = onHistory; this.onToolChange = onToolChange;
    this.textareaContainer = element.closest("dialog") || element.ownerDocument.body;
    this.tool = "select"; this.color = DEFAULT_MARKUP_COLOR; this.history = []; this.historyIndex = -1; this.restoring = false;
    this.draftObject = null; this.start = null; this.cropObject = null; this.outputScale = 1;
    this.handleKeyDown = event => this.keyDown(event);
    element.ownerDocument.addEventListener("keydown", this.handleKeyDown);
    this.canvas.on("mouse:down", event => this.pointerDown(event));
    this.canvas.on("mouse:move", event => this.pointerMove(event));
    this.canvas.on("mouse:up", () => this.pointerUp());
    this.canvas.on("object:modified", () => this.commitHistory());
    this.canvas.on("text:editing:exited", () => this.commitHistory());
  }

  async load(image) {
    this.canvas.clear();
    const scale = Math.min(1, PREVIEW_MAX_WIDTH / image.naturalWidth, PREVIEW_MAX_HEIGHT / image.naturalHeight);
    const width = Math.max(1, Math.round(image.naturalWidth * scale)), height = Math.max(1, Math.round(image.naturalHeight * scale));
    this.outputScale = 1 / scale;
    this.canvas.setDimensions({ width, height });
    this.background = new FabricImage(image, {
      ...FABRIC_TOP_LEFT,
      left: 0, top: 0, scaleX: width / image.naturalWidth, scaleY: height / image.naturalHeight,
      selectable: false, evented: false, editorType: "background"
    });
    this.canvas.add(this.background); this.canvas.sendObjectToBack(this.background);
    this.history = []; this.historyIndex = -1; this.commitHistory(); this.setTool("select");
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
    const aspect = IMAGE_CROP_PRESETS[preset], width = this.canvas.width * 0.76;
    let height = aspect ? width / aspect : this.canvas.height * 0.76;
    let cropWidth = width;
    if (height > this.canvas.height * 0.9) { height = this.canvas.height * 0.9; cropWidth = aspect ? height * aspect : width; }
    this.cropObject = new Rect({
      ...FABRIC_TOP_LEFT,
      left: (this.canvas.width - cropWidth) / 2, top: (this.canvas.height - height) / 2,
      width: cropWidth, height, fill: "rgba(255,255,255,.08)", stroke: "#fff", strokeWidth: 2,
      strokeDashArray: [8, 5], cornerColor: "#fff", cornerStrokeColor: "#111", transparentCorners: false,
      lockRotation: true, editorType: "crop-guide"
    });
    if (aspect) {
      this.cropObject.set({ lockUniScaling: true });
      this.cropObject.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false, mtr: false });
    }
    this.canvas.skipTargetFind = false; this.canvas.add(this.cropObject); this.canvas.setActiveObject(this.cropObject); this.canvas.requestRenderAll();
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
      const text = new IText("Type here", { ...FABRIC_TOP_LEFT, left: point.x, top: point.y, fill: this.color, fontSize: MARKUP_SIZE * 3, hiddenTextareaContainer: this.textareaContainer, editorType: "text" });
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
  }

  keyDown(event) {
    if (!isImageEditorDeleteKey(event) || event.defaultPrevented) return;
    if (event.target?.matches?.("input, textarea, select, [contenteditable='true']")) return;
    const activeObjects = this.canvas.getActiveObjects();
    if (!activeObjects.length || activeObjects.some(object => object.isEditing)) return;
    const removableObjects = activeObjects.filter(object => !["background", "crop-guide"].includes(object.editorType));
    if (!removableObjects.length) return;
    this.canvas.discardActiveObject();
    this.canvas.remove(...removableObjects);
    this.canvas.requestRenderAll();
    this.commitHistory();
    event.preventDefault();
    event.stopPropagation();
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

function createArrow(x1, y1, x2, y2, color, width) {
  const dx = x2 - x1, dy = y2 - y1, length = Math.max(1, Math.hypot(dx, dy)), angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const line = new Line([0, 0, length, 0], { stroke: color, strokeWidth: width, originX: "left", originY: "center" });
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
function withAlpha(color, alpha) {
  const hex = color.replace("#", "");
  const value = hex.length === 3 ? hex.split("").map(character => character + character).join("") : hex;
  return `rgba(${parseInt(value.slice(0, 2), 16)},${parseInt(value.slice(2, 4), 16)},${parseInt(value.slice(4, 6), 16)},${alpha})`;
}
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(value, maximum)); }
