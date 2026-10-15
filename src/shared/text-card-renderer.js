// The DOM side of Text to image (text-cards.js holds the pure parts). Slides
// are laid out by the browser itself: a hidden card measures how much text
// fits at a font size. The preview shows the slides as live cards (fast
// enough to follow typing), and each exported slide is drawn as an SVG whose
// foreignObject holds the same markup and CSS, with the fonts inlined as
// data: URLs. That keeps the browser's own line breaking, bidi, emoji and
// font fallback in both.
import { FONT_FACES } from "../vendor/fonts/faces.js";
import { setHtml } from "./dom.js";
import { cardBodyMarkup, cardByline, cardFontFaces, cardParagraphs, cleanCardText, layoutTextCards, PROBE_CELL, TEXT_CARD_MAX_SLIDES, TEXT_CARD_STYLESHEET, textCardMarkup, textCardMetrics, textCardSize, textCardSvg, textCardTheme, textCardUnits } from "./text-cards.js";

const FONT_BASE = new URL("../vendor/fonts/", import.meta.url);
// Characters every slide may show besides its text: the "2 / 4" counter.
const COUNTER_TEXT = "0123456789 /";
// How long an export waits for an SVG image's fonts. Chrome and Firefox show
// text in a font that is still loading only after 3 s, in a fallback font.
const FONT_WAIT_MS = 4000;
let fontsRegistered = false;
let stylesheet = null;
const fontDataUrls = new Map();

function registerFonts() {
  if (fontsRegistered) return;
  fontsRegistered = true;
  for (const face of FONT_FACES) {
    document.fonts.add(new FontFace(face.family, `url("${new URL(face.file, FONT_BASE).href}") format("woff2")`, { weight: face.weight, unicodeRange: face.unicodeRange, display: "block" }));
  }
}

// Loads the subsets this text needs before anything is measured.
async function loadFonts(theme, text) {
  registerFonts();
  await Promise.all([
    document.fonts.load(`${theme.weight} 48px "${theme.family}"`, text),
    document.fonts.load('500 32px "Crossposter Inter"', text),
    document.fonts.load('600 32px "Crossposter Inter"', text)
  ]);
}

function fontDataUrl(file) {
  if (!fontDataUrls.has(file)) {
    const task = fetch(new URL(file, FONT_BASE)).then(async response => {
      if (!response.ok) throw new Error(`The font ${file} could not be loaded.`);
      return `data:font/woff2;base64,${(await response.bytes()).toBase64()}`;
    });
    task.catch(() => fontDataUrls.delete(file));
    fontDataUrls.set(file, task);
  }
  return fontDataUrls.get(file);
}

// One constructed stylesheet serves the measuring card and every preview.
function cardStylesheet() {
  if (!stylesheet) { stylesheet = new CSSStyleSheet(); stylesheet.replaceSync(TEXT_CARD_STYLESHEET); }
  return stylesheet;
}

function bylineText(byline) {
  const credit = cardByline(byline);
  return credit ? `${credit.author} ${credit.detail}` : "";
}

export function svgDataUrl(svg) { return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; }

export class TextCardRenderer {
  constructor(parent = document.body) {
    // Lays out like a visible element but is never seen; the shadow root
    // keeps the page's own styles off the card.
    this.host = document.createElement("div");
    this.host.style.cssText = "position:fixed;left:-30000px;top:0;width:1080px;height:1920px;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict";
    this.host.setAttribute("aria-hidden", "true");
    const root = this.host.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [cardStylesheet()];
    this.stage = document.createElement("div");
    root.append(this.stage);
    parent.append(this.host);
  }

  // The slides for this text, theme and size. byline: { author, detail } or
  // null. Resolves to { theme, size, fontSize, overflow, slides }, where each
  // slide has its markup and text; overflow means maxSlides can't hold it.
  // guess: the previous layout's font size, to start the search from.
  async layout({ text, byline = null, theme: themeId, size: sizeId, maxSlides = TEXT_CARD_MAX_SLIDES, guess = 0 }) {
    const theme = textCardTheme(themeId), size = textCardSize(sizeId);
    await loadFonts(theme, `${cleanCardText(text)}${bylineText(byline)}${COUNTER_TEXT}`);
    let built = null;
    const measure = (units, { fontSize, multi }) => {
      if (built?.multi !== multi) {
        setHtml(this.stage, textCardMarkup({ theme, size, fontSize, byline, page: 1, pages: multi ? 2 : 1, measuring: true }));
        const card = this.stage.firstElementChild;
        built = { multi, card, box: card.querySelector(".cp-text"), body: card.querySelector(".cp-body") };
      }
      const { lineHeight, letterSpacing } = textCardMetrics(theme, fontSize);
      built.card.style.setProperty("--fs", `${fontSize}px`);
      built.card.style.setProperty("--lh", String(lineHeight));
      built.card.style.setProperty("--ls", `${letterSpacing}em`);
      const body = cardBodyMarkup(cardParagraphs(units));
      built.body.className = body.className;
      setHtml(built.body, body.html);
      // The text block's own height (its line boxes) against all the room the
      // layout leaves it; scrollHeight would also count glyph overhang.
      const room = built.box.getBoundingClientRect().height;
      return room > 0 ? (built.body.getBoundingClientRect().height - 0.5) / room : Infinity;
    };
    const result = layoutTextCards(textCardUnits(text), measure, { theme, maxSlides, guess });
    this.stage.replaceChildren();
    const pages = result.pages.length;
    const slides = result.pages.map((units, index) => {
      const paragraphs = cardParagraphs(units);
      return { text: paragraphs.join("\n"), markup: textCardMarkup({ theme, size, paragraphs, fontSize: result.fontSize, byline, page: index + 1, pages }) };
    });
    return { theme, size, byline, fontSize: result.fontSize, overflow: result.overflow, slides };
  }

  // A slide as a live card for previews, at full size in its own shadow root
  // with the fonts and CSS the export uses; scale it with a transform, which
  // leaves its line breaks alone.
  slideElement(slide) {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [cardStylesheet()];
    setHtml(root.appendChild(document.createElement("div")), slide.markup);
    return host;
  }

  // The slide as a self-contained SVG with only the font subsets it uses,
  // and the probe strip that shows when they have loaded.
  async svg(layout, slide) {
    const { theme, byline } = layout;
    const mark = theme.quoteMark && cardByline(byline) ? "“" : "";
    const inter = `${bylineText(byline)}${layout.slides.length > 1 ? COUNTER_TEXT : ""}`;
    const faces = cardFontFaces([
      { family: theme.family, weight: theme.weight, text: `${slide.text}${mark}${theme.family === "Crossposter Inter" ? inter : ""}` },
      { family: "Crossposter Inter", weight: 500, text: inter }
    ]);
    const rules = await Promise.all(faces.map(async face => `@font-face { font-family: "${face.family}"; src: url(${await fontDataUrl(face.file)}) format("woff2"); font-weight: ${face.weight}; unicode-range: ${face.unicodeRange}; }`));
    return { svg: textCardSvg({ size: layout.size, markup: slide.markup, fontCss: rules.join("\n"), probes: faces.map(face => ({ family: face.family, ...face.probe })) }), probes: faces.length };
  }

  async png(layout, slide) {
    const { svg, probes } = await this.svg(layout, slide);
    const image = new Image();
    image.src = svgDataUrl(svg);
    await image.decode();
    await fontsDrawn(image, layout.size, probes);
    const canvas = document.createElement("canvas");
    canvas.width = layout.size.width; canvas.height = layout.size.height;
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The text image could not be created.")), "image/png"));
  }

  dispose() { this.host.remove(); }
}

// Resolves once every probe cell under the card has ink, i.e. every font the
// slide uses has loaded inside the SVG image (see textCardSvg).
async function fontsDrawn(image, size, probes) {
  if (!probes) return;
  const canvas = document.createElement("canvas");
  canvas.width = probes * PROBE_CELL; canvas.height = PROBE_CELL;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const started = performance.now();
  for (;;) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, size.height, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const inked = Array.from({ length: probes }, () => false);
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 0 && data[index] < 128) inked[Math.floor((index / 4) % canvas.width / PROBE_CELL)] = true;
    }
    if (inked.every(Boolean)) return;
    if (performance.now() - started > FONT_WAIT_MS) throw new Error("The fonts for the text image did not load.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
