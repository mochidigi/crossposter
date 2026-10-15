// Text to image: turns the post's text into one or more shareable cards.
// Everything here is pure (no DOM): the themes and sizes, how text breaks
// into units that can move between slides, how slides are packed given a
// measurement of how full one is, and the XHTML/SVG each slide is drawn
// from. The DOM side (measuring, fonts, canvas) is text-card-renderer.js.
import { FONT_FACES } from "../vendor/fonts/faces.js";

export const TEXT_CARD_STYLE_KEY = "textCardStyle";
// The draft's own cap (validateDraft), which X and Bluesky share.
export const TEXT_CARD_MAX_SLIDES = 4;

const INTER = '"Crossposter Inter", system-ui, sans-serif';
// Below the card, an SVG carries one probe cell per font file: the file's
// probe character, black on white. An SVG image loads its fonts only after it
// first draws and shows no text meanwhile, so a cell turns dark once its font
// is in; the renderer waits for that and crops the strip off.
export const PROBE_CELL = 64;

// Card sizes, all 1080 px wide so the type scale holds across them. Story
// padding keeps text out of the bands Instagram and others cover with their
// own controls.
export const TEXT_CARD_SIZES = Object.freeze([
  { id: "portrait", label: "4:5", title: "Portrait, for feeds", width: 1080, height: 1350, padX: 96, padY: 112 },
  { id: "square", label: "1:1", title: "Square", width: 1080, height: 1080, padX: 96, padY: 96 },
  { id: "story", label: "9:16", title: "Vertical, for stories", width: 1080, height: 1920, padX: 96, padY: 250 }
].map(Object.freeze));

// size: the text's px range. The fit search starts at max; a slide below
// `comfort` makes it try one more slide, and `min` is the smallest size that
// still reads on a phone (a 1080 px image shows at roughly a third of that).
// leading/tracking go from their value at `min` to their value at `max`.
// byline: where the credit sits — after the text, in the footer, or as the
// header of a post-like panel.
export const TEXT_CARD_THEMES = Object.freeze([
  { id: "paper", label: "Paper", font: '"Crossposter Literata", Georgia, serif', family: "Crossposter Literata", weight: 400, byline: "after", size: { min: 38, comfort: 44, max: 116 }, leading: [1.42, 1.16], tracking: [0, -0.012], swatch: { background: "#f4f4f1", ink: "#1b1b19" } },
  { id: "forest", label: "Forest", font: '"Crossposter Instrument Serif", Georgia, serif', family: "Crossposter Instrument Serif", weight: 400, byline: "after", quoteMark: true, size: { min: 46, comfort: 52, max: 124 }, leading: [1.2, 1.02], tracking: [0.004, -0.01], swatch: { background: "#174b34", ink: "#f3efe3" } },
  { id: "signal", label: "Signal", font: '"Crossposter Bricolage", system-ui, sans-serif', family: "Crossposter Bricolage", weight: 720, byline: "foot", size: { min: 40, comfort: 46, max: 156 }, leading: [1.18, 0.98], tracking: [-0.01, -0.035], swatch: { background: "#ef3f78", ink: "#260512" } },
  { id: "note", label: "Note", font: INTER, family: "Crossposter Inter", weight: 400, byline: "head", size: { min: 36, comfort: 42, max: 92 }, leading: [1.42, 1.18], tracking: [-0.004, -0.022], swatch: { background: "#dde3ec", ink: "#0f1419" } },
  { id: "note-dark", label: "Note dark", font: INTER, family: "Crossposter Inter", weight: 400, byline: "head", size: { min: 36, comfort: 42, max: 92 }, leading: [1.42, 1.18], tracking: [-0.004, -0.022], swatch: { background: "#121816", ink: "#eef1ec" } }
].map(Object.freeze));

export function textCardTheme(id) { return TEXT_CARD_THEMES.find(theme => theme.id === id) || TEXT_CARD_THEMES[0]; }
export function textCardSize(id) { return TEXT_CARD_SIZES.find(size => size.id === id) || TEXT_CARD_SIZES[0]; }
export function normalizeTextCardStyle(value) {
  return { theme: textCardTheme(value?.theme).id, size: textCardSize(value?.size).id };
}

// Line height and letter spacing follow the font size: big type sets tighter.
export function textCardMetrics(theme, fontSize) {
  const { min, max } = theme.size;
  const t = Math.min(1, Math.max(0, (fontSize - min) / (max - min)));
  const mix = ([from, to]) => from + (to - from) * t;
  return { lineHeight: Number(mix(theme.leading).toFixed(3)), letterSpacing: Number(mix(theme.tracking).toFixed(4)) };
}

// Characters XML 1.0 rejects (an SVG image holding one fails to load) and
// unpaired surrogates go; line endings become \n.
export function cleanCardText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .trim();
}

// The text as units that can move between slides: one per sentence, tagged
// with its paragraph (blank lines separate paragraphs; single line breaks
// stay inside one). A sentence too long for a slide of its own is split into
// words later (splitCardUnit).
export function textCardUnits(text) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  return cleanCardText(text).split(/\n[ \t]*\n\s*/).map(paragraph => paragraph.trim()).filter(Boolean)
    .flatMap((paragraph, index) => [...segmenter.segment(paragraph)].map(({ segment }) => ({ paragraph: index, text: segment, level: "sentence" })));
}

// A word and the spaces or punctuation after it; works for scripts without
// spaces too (the word segmenter knows their words).
export function splitCardUnit(unit) {
  if (unit.level === "word") return [unit];
  const pieces = [];
  for (const { segment, isWordLike } of new Intl.Segmenter(undefined, { granularity: "word" }).segment(unit.text)) {
    if (isWordLike || !pieces.length) pieces.push({ paragraph: unit.paragraph, text: segment, level: "word" });
    else pieces[pieces.length - 1].text += segment;
  }
  return pieces.length > 1 ? pieces : [{ ...unit, level: "word" }];
}

// The paragraphs a slide shows, in order.
export function cardParagraphs(units) {
  const paragraphs = [];
  let current = null;
  for (const unit of units) {
    if (unit.paragraph !== current) { paragraphs.push(""); current = unit.paragraph; }
    paragraphs[paragraphs.length - 1] += unit.text;
  }
  return paragraphs.map(paragraph => paragraph.trim()).filter(Boolean);
}

// How full a slide may be left before its next sentence is split across
// slides: ending on a sentence reads better, but not at any cost in room.
const SENTENCE_BREAK_FILL = 0.8;

// Largest whole number in [low, high] that passes, for a test that passes
// up to some threshold and fails above it; 0 when even `low` fails. A guess
// that turns out right (it passes, the next one up fails) takes two tests.
function largestPassing(low, high, test, guess = 0) {
  if (!test(low)) return 0;
  if (guess > low && guess <= high) {
    if (!test(guess)) high = guess - 1;
    else if (guess === high || !test(guess + 1)) return guess;
    else low = guess + 1;
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (test(middle)) low = middle; else high = middle - 1;
  }
  return low;
}

// Greedy slides at one font size. measure(units) is how much of a slide's
// text area those units fill (1 = exactly full). Each slide takes as many
// sentences as fit; when that leaves it under SENTENCE_BREAK_FILL, the next
// sentence is split by words and continues on the following slide.
export function packCardUnits(units, measure) {
  const fits = slice => measure(slice) <= 1;
  const pages = [];
  const queue = [...units];
  while (queue.length) {
    if (!fits(queue.slice(0, 1))) {
      const pieces = splitCardUnit(queue[0]);
      if (pieces.length > 1) { queue.splice(0, 1, ...pieces); continue; }
      pages.push(queue.splice(0, 1));
      continue;
    }
    const count = largestPassing(1, queue.length, size => fits(queue.slice(0, size)));
    if (count < queue.length && queue[count].level !== "word" && measure(queue.slice(0, count)) < SENTENCE_BREAK_FILL) {
      const pieces = splitCardUnit(queue[count]);
      const taken = pieces.length > 1 ? largestPassing(1, pieces.length - 1, size => fits([...queue.slice(0, count), ...pieces.slice(0, size)])) : 0;
      if (taken) {
        // This slide: the sentences that fit and the split one's first words;
        // its other words lead the queue for the next slide.
        const sentences = queue.splice(0, count + 1, ...pieces.slice(taken)).slice(0, count);
        pages.push([...sentences, ...pieces.slice(0, taken)]);
        continue;
      }
    }
    pages.push(queue.splice(0, count));
  }
  return pages;
}

// Slides and one shared font size for the text. One slide when the text fits
// at a comfortable size; otherwise the fewest slides (up to maxSlides) that
// reach it, each at the largest size that keeps that count. If no count gets
// there, the fewest slides that fit at all win. `overflow` means even
// maxSlides at the minimum size can't hold the text; `pages` then holds what
// it would take. measure(units, { fontSize, multi }) is how full one slide
// is (see packCardUnits); multi is true when it carries a "1 / 3" counter.
// guess: the font size of the previous layout, which a keystroke rarely
// changes; the result is the same with or without it.
export function layoutTextCards(units, measure, { theme, maxSlides = TEXT_CARD_MAX_SLIDES, guess = 0 }) {
  const { min, comfort, max } = theme.size;
  if (!units.length) return { pages: [], fontSize: max, overflow: false };
  const single = largestPassing(min, max, fontSize => measure(units, { fontSize, multi: false }) <= 1, guess);
  if (single >= comfort || (single && maxSlides <= 1)) return { pages: [units], fontSize: single, overflow: false };
  const packed = new Map();
  const pack = fontSize => {
    if (!packed.has(fontSize)) packed.set(fontSize, packCardUnits(units, slice => measure(slice, { fontSize, multi: true })));
    return packed.get(fontSize);
  };
  let fewest = single ? { pages: [units], fontSize: single, overflow: false } : null;
  for (let count = 2; count <= maxSlides; count++) {
    const fontSize = largestPassing(min, max, size => pack(size).length <= count, guess);
    if (!fontSize) continue;
    if (fontSize >= comfort) return { pages: pack(fontSize), fontSize, overflow: false };
    fewest ||= { pages: pack(fontSize), fontSize, overflow: false };
  }
  return fewest || { pages: pack(min), fontSize: min, overflow: true };
}

export function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// Links, #hashtags and @mentions take the theme's tag color.
const TAG_PATTERN = /https?:\/\/[^\s<>"]+|(?<![\p{L}\p{N}\p{M}_])[#＃@][\p{L}\p{N}\p{M}_]+/gu;
// A typewriter apostrophe inside a word is set as ’ (don't → don’t), which
// holds in every language; quotation marks differ by language and stay.
function typeset(text) { return escapeXml(text.replace(/(?<=\p{L})'(?=\p{L})/gu, "’")); }
export function cardInlineMarkup(text) {
  let markup = "", last = 0;
  for (const match of text.matchAll(TAG_PATTERN)) {
    // A link may wrap after any single slash rather than mid-word.
    const tag = escapeXml(match[0]).replace(/(?<![:/])\/(?!\/)/g, "/<wbr/>");
    markup += `${typeset(text.slice(last, match.index))}<span class="cp-tag">${tag}</span>`;
    last = match.index + match[0].length;
  }
  return markup + typeset(text.slice(last));
}

export function cardBodyMarkup(paragraphs) {
  // A short single paragraph reads as a quote: balance its lines.
  const short = paragraphs.length === 1 && paragraphs[0].length <= 160;
  return { className: short ? "cp-body cp-short" : "cp-body", html: paragraphs.map(paragraph => `<p dir="auto">${cardInlineMarkup(paragraph)}</p>`).join("") };
}

function firstGrapheme(text) {
  const [first] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
  return first?.segment.toLocaleUpperCase() || "";
}

// The credit as shown: { author, detail } on one line each, where detail is
// what follows the name ("on X", "@ada"); null without a name.
export function cardByline(byline) {
  const line = value => cleanCardText(value).replace(/\s+/g, " ");
  const author = line(byline?.author);
  return author ? { author, detail: line(byline?.detail) } : null;
}

function bylineMarkup(byline) {
  const credit = cardByline(byline);
  if (!credit) return "";
  const detail = credit.detail ? ` <span class="cp-detail" dir="auto">${escapeXml(credit.detail)}</span>` : "";
  return `<div class="cp-byline"><span class="cp-avatar">${escapeXml(firstGrapheme(credit.author))}</span><span class="cp-names"><span class="cp-author" dir="auto">${escapeXml(credit.author)}</span>${detail}</span></div>`;
}

// One slide as XHTML (valid inside an SVG foreignObject and as HTML).
// paragraphs: the slide's text; byline: { author, detail } or null.
// measuring: the text area takes all the room it can, so how full it is can
// be read off (text-card-renderer.js).
export function textCardMarkup({ theme, size, paragraphs = [], fontSize, byline = null, page = 1, pages = 1, measuring = false }) {
  const { lineHeight, letterSpacing } = textCardMetrics(theme, fontSize);
  const credit = bylineMarkup(byline);
  const body = cardBodyMarkup(paragraphs);
  const mark = theme.quoteMark && credit ? '<div class="cp-mark" aria-hidden="true">“</div>' : "";
  const text = `<div class="cp-text"><div class="${body.className}">${body.html}</div></div>`;
  const main = theme.byline === "head"
    ? `<div class="cp-frame">${credit}${text}</div>`
    : `${mark}${text}${theme.byline === "after" ? credit : ""}`;
  // The counter shares the footer with a footer credit; otherwise it sits in
  // the bottom margin and takes no room from the text.
  const count = pages > 1 ? `<span class="cp-count">${page} / ${pages}</span>` : "";
  const foot = theme.byline === "foot" && credit ? `<div class="cp-foot">${credit}${count}</div>` : count;
  const style = `width:${size.width}px;height:${size.height}px;--pad-x:${size.padX}px;--pad-y:${size.padY}px;--fs:${fontSize}px;--lh:${lineHeight};--ls:${letterSpacing}em`;
  return `<div class="cp-card${measuring ? " cp-measure" : ""}" data-theme="${theme.id}" data-pages="${pages > 1 ? "multi" : "single"}" style="${style}"><div class="cp-main">${main}</div>${foot}</div>`;
}

// Kept free of "<" and "&" so it can sit in the SVG's XHTML <style> as is.
export const TEXT_CARD_CSS = `
.cp-card { box-sizing: border-box; position: relative; display: flex; flex-direction: column; overflow: hidden; padding: var(--pad-y) var(--pad-x); background: var(--bg); color: var(--ink); font-family: var(--font); font-weight: var(--weight); font-kerning: normal; font-optical-sizing: auto; font-synthesis: none; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }
.cp-card * { box-sizing: border-box; margin: 0; padding: 0; }
.cp-main { display: flex; flex: 1 1 auto; flex-direction: column; justify-content: center; min-height: 0; }
.cp-card[data-pages=multi] .cp-main { justify-content: flex-start; }
/* Not clipped: glyphs may overhang the line boxes (descenders under the last line). */
.cp-text { flex: 0 1 auto; min-height: 0; }
.cp-measure .cp-text, .cp-measure .cp-frame { flex-grow: 1; }
.cp-body { font-size: var(--fs); line-height: var(--lh); letter-spacing: var(--ls); overflow-wrap: anywhere; text-wrap: pretty; }
.cp-body.cp-short { text-wrap: balance; }
.cp-body p { text-align: start; white-space: pre-line; }
.cp-body p + p { margin-top: calc(var(--fs) * .6); }
.cp-tag { color: var(--tag); }
.cp-byline { display: flex; flex: none; align-items: center; gap: 22px; margin-top: 60px; color: var(--muted); font: 500 34px/1.3 ${INTER}; letter-spacing: -.006em; }
.cp-author { color: var(--ink); font-weight: 600; }
.cp-avatar { display: none; }
.cp-foot { display: flex; flex: none; align-items: flex-end; justify-content: space-between; gap: 32px; margin-top: 48px; }
.cp-foot .cp-byline { margin-top: 0; }
.cp-count { margin-inline-start: auto; color: var(--muted); font: 500 28px/1.3 ${INTER}; font-variant-numeric: tabular-nums; letter-spacing: .02em; white-space: nowrap; }
.cp-card > .cp-count { position: absolute; right: var(--pad-x); bottom: calc(var(--pad-y) / 2); transform: translateY(50%); }

.cp-card[data-theme=paper] { --bg: #f4f4f1; --ink: #1b1b19; --muted: #6d6d67; --tag: #c91f5b; }
.cp-card[data-theme=paper] .cp-text { padding-inline-start: 52px; border-inline-start: 8px solid #ef3f78; }
.cp-card[data-theme=paper] .cp-main > .cp-byline { padding-inline-start: 60px; }

.cp-card[data-theme=forest] { --bg: #174b34; --ink: #f3efe3; --muted: #a9c9b6; --tag: #b9e9cb; }
/* The glyph sits high in its em box; the short box pulls the text up under it. */
.cp-mark { flex: none; height: .36em; margin-bottom: 12px; color: #6dbb91; font: 400 280px/1 "Crossposter Instrument Serif", Georgia, serif; }

.cp-card[data-theme=signal] { --bg: #ef3f78; --ink: #260512; --muted: #5c1430; --tag: #ffffff; }
.cp-card[data-theme=signal] .cp-main { justify-content: flex-start; }
.cp-card[data-theme=signal] .cp-byline { color: var(--ink); }

.cp-card[data-theme=note] { --bg: #dde3ec; --panel: #ffffff; --ink: #0f1419; --muted: #5b6670; --tag: #1d63d8; --avatar: #174b34; --shadow: 0 32px 80px rgb(20 32 48 / 16%); }
.cp-card[data-theme=note-dark] { --bg: #121816; --panel: #1e2622; --ink: #eef1ec; --muted: #94a39b; --tag: #8fd4ae; --avatar: #ef3f78; --shadow: 0 32px 80px rgb(0 0 0 / 40%); }
/* The panel is the frame here, so the card keeps a narrower margin. */
.cp-card[data-theme^=note] { padding-inline: 64px; }
.cp-frame { display: flex; flex: 0 1 auto; flex-direction: column; min-height: 0; padding: 60px; border-radius: 44px; background: var(--panel); box-shadow: var(--shadow); }
.cp-frame .cp-byline { margin: 0 0 44px; }
.cp-frame .cp-avatar { display: grid; flex: none; width: 88px; height: 88px; place-items: center; border-radius: 50%; background: var(--avatar); color: #ffffff; font: 600 40px/1 ${INTER}; }
.cp-frame .cp-names { display: flex; flex-direction: column; }
.cp-frame .cp-author { font-size: 36px; }

.cp-probes { position: absolute; left: 0; display: flex; height: ${PROBE_CELL}px; background: #ffffff; color: #000000; font-size: 40px; line-height: ${PROBE_CELL}px; }
.cp-probes span { width: ${PROBE_CELL}px; overflow: hidden; text-align: center; }
`;

// The CSS every slide needs: the shared rules plus each theme's font.
export const TEXT_CARD_STYLESHEET = TEXT_CARD_CSS + TEXT_CARD_THEMES.map(theme => `.cp-card[data-theme=${theme.id}] { --font: ${theme.font}; --weight: ${theme.weight}; }`).join("\n");

// "U+0000-00FF,U+0131" → [[0, 255], [305, 305]]
export function parseUnicodeRange(range) {
  return String(range || "").split(",").map(part => part.trim().replace(/^U\+/i, "")).filter(Boolean).map(part => {
    const [from, to = from] = part.split("-");
    return [Number.parseInt(from, 16), Number.parseInt(to, 16)];
  });
}

// The vendored font files a slide uses. uses: [{ family, weight, text }],
// e.g. the theme's family for the text and Inter for the byline. Only the
// subsets covering a character of that text count, and each comes with a
// probe: a visible character it draws, at a weight it is used at. Subsets
// can overlap (ă is in latin-ext and vietnamese) and the browser then draws
// with one of them, so a probe prefers a character no other subset covers.
export function cardFontFaces(uses, faces = FONT_FACES) {
  const covers = (face, character) => parseUnicodeRange(face.unicodeRange).some(([from, to]) => character.codePointAt(0) >= from && character.codePointAt(0) <= to);
  const picked = [];
  for (const use of uses) {
    const characters = [...new Set(String(use.text || ""))].filter(character => /[\p{L}\p{N}\p{P}\p{S}]/u.test(character));
    for (const face of faces) {
      if (face.family !== use.family || picked.some(item => item.face.file === face.file)) continue;
      const candidates = characters.filter(character => covers(face, character));
      if (candidates.length) picked.push({ face, candidates, weight: use.weight });
    }
  }
  return picked.map(({ face, candidates, weight }) => {
    const shared = character => picked.some(other => other.face !== face && other.face.family === face.family && covers(other.face, character));
    return { ...face, probe: { character: candidates.find(character => !shared(character)) || candidates[0], weight } };
  });
}

// fontCss: @font-face rules with data: URLs (an SVG image loads nothing).
// probes: cardFontFaces' probe of each embedded file.
export function textCardSvg({ size, markup, fontCss = "", probes = [] }) {
  const { width } = size;
  const height = size.height + (probes.length ? PROBE_CELL : 0);
  const cells = probes.map(probe => `<span style="font-family:'${probe.family}';font-weight:${probe.weight}">${escapeXml(probe.character)}</span>`).join("");
  const strip = probes.length ? `<div class="cp-probes" style="top:${size.height}px">${cells}</div>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="${width}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative"><style>${fontCss}${TEXT_CARD_STYLESHEET}</style>${markup}${strip}</div></foreignObject></svg>`;
}
