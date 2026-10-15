export const NETWORKS = Object.freeze([
  { id: "upscrolled", label: "UpScrolled", color: "#111111" },
  { id: "linkedin", label: "LinkedIn", color: "#111111" },
  { id: "x", label: "X", color: "#111111" },
  { id: "bluesky", label: "Bluesky", color: "#111111" },
  { id: "threads", label: "Threads", color: "#111111" }
]);

const PLATFORM_LABELS = Object.freeze({
  x: "X",
  linkedin: "LinkedIn",
  bluesky: "Bluesky",
  upscrolled: "UpScrolled",
  instagram: "Instagram",
  threads: "Threads",
  facebook: "Facebook",
  substack: "Substack",
  web: "the web"
});

const sourceNetworks = [];

export function registerSourceNetwork(network) {
  if (!network?.id || !network?.label || typeof network.matches !== "function") throw new Error("Invalid source-network registration.");
  const index = sourceNetworks.findIndex(item => item.id === network.id);
  if (index >= 0) sourceNetworks[index] = network;
  else sourceNetworks.push(network);
}

const MAX_TEXT_LENGTH = 3000;

function creditParts(sourceAuthor, sourceNetwork) {
  const author = String(sourceAuthor || "").replace(/\s+/g, " ").trim();
  if (!author) return null;
  const platform = PLATFORM_LABELS[sourceNetwork] || sourceNetworks.find(network => network.id === sourceNetwork)?.label || PLATFORM_LABELS.web;
  return { author, platform, prefix: `${author} on ${platform}: `, legacySuffix: `(via ${author} on ${platform})` };
}

// The credit leads the post on every destination ("Name on X: text") so it is
// visible before any truncation or "see more" fold. It is not part of the
// draft's editable text: Compose shows it beside the field with a toggle
// (`draft.credit`), and postText adds it at handoff. Empty for an own post or
// a post without a known author.
export function creditPrefix(draft = {}) {
  if (draft.sourceIsOwn === true) return "";
  return creditParts(draft.sourceAuthor, draft.sourceNetwork)?.prefix || "";
}

// The same credit as a text image's byline: the name, and what follows it
// ({ author: "Ada", detail: "on X" }); null when the post would carry none.
export function creditByline(draft = {}) {
  if (!creditPrefix(draft)) return null;
  const { author, platform } = creditParts(draft.sourceAuthor, draft.sourceNetwork);
  return { author, detail: `on ${platform}` };
}

// The text each destination receives; a post without text gets no credit.
export function postText(draft = {}) {
  const body = String(draft.text || "").trim();
  return draft.credit === false || !body ? body : `${creditPrefix(draft)}${body}`;
}

// Drafts saved by earlier builds carry the credit inside their text, leading
// or as a trailing "(via Name on X)"; take it out so it is never added twice.
export function stripAttribution(text, sourceAuthor, sourceNetwork) {
  const body = String(text || "").trim();
  const parts = creditParts(sourceAuthor, sourceNetwork);
  if (!parts) return body;
  if (body.startsWith(parts.prefix)) return body.slice(parts.prefix.length).trimStart();
  if (body.endsWith(parts.legacySuffix)) return body.slice(0, -parts.legacySuffix.length).trimEnd();
  return body;
}

// Links a capture found on the post: inline links already sit in the text
// (`inText`), while link cards and previews sit beside it and would be lost
// unless their URL is written into the draft. Each URL is placed at most once;
// after that the link is marked `inText` so a later re-creation of the same
// draft (reload, history, session restore) never re-adds a URL the user removed.
export function normalizeCapturedLinks(links) {
  if (!Array.isArray(links)) return [];
  const seen = new Set();
  const result = [];
  for (const item of links) {
    const url = String(item?.url || "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    result.push({
      url,
      display: String(item?.display || "").replace(/\s+/g, " ").trim(),
      title: String(item?.title || "").replace(/\s+/g, " ").trim(),
      inText: item?.inText === true
    });
  }
  return result.slice(0, 8);
}

export function placeLinksInText(text, links) {
  let body = String(text || "").trim();
  const placed = links.map(link => {
    if (link.inText) return link;
    if (!body.includes(link.url)) body = `${body}\n\n${link.url}`.trim();
    return { ...link, inText: true };
  });
  return { text: body, links: placed };
}

export function createDraft(input = {}) {
  const sourceUrl = String(input.sourceUrl || "");
  const sourceNetwork = input.sourceNetwork || detectNetwork(sourceUrl);
  const sourceAuthor = String(input.sourceAuthor || "").replace(/\s+/g, " ").trim();
  const sourceIsOwn = input.sourceIsOwn === true;
  const { text, links } = placeLinksInText(stripAttribution(input.text, sourceAuthor, sourceNetwork), normalizeCapturedLinks(input.links));
  return {
    id: input.id || crypto.randomUUID(),
    text: text.slice(0, MAX_TEXT_LENGTH),
    credit: input.credit !== false,
    sourceUrl,
    sourceNetwork,
    sourceAuthor,
    sourceIsOwn,
    links,
    media: Array.isArray(input.media) ? input.media.map(({ alt: _legacyAlt, ...item }) => item) : [],
    destinations: Array.isArray(input.destinations) ? input.destinations : [],
    createdAt: input.createdAt || Date.now()
  };
}

export function detectNetwork(url = "") {
  const host = safeHost(url);
  if (host.endsWith("linkedin.com")) return "linkedin";
  if (host === "x.com" || host.endsWith("twitter.com")) return "x";
  if (host === "bsky.app") return "bluesky";
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
  if (host === "threads.com" || host.endsWith(".threads.com")) return "threads";
  if (host === "facebook.com" || host.endsWith(".facebook.com")) return "facebook";
  if (host.endsWith("upscrolled.com")) return "upscrolled";
  if (host === "substack.com" || host.endsWith(".substack.com")) return "substack";
  const registered = sourceNetworks.find(network => network.matches(host));
  if (registered) return registered.id;
  return "web";
}

export function safeHost(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

export function validateDraft(draft) {
  const errors = [];
  if (!draft.text && !draft.media.length) errors.push("Add text or media before posting.");
  if (!draft.destinations.length) errors.push("Choose at least one destination.");
  const text = postText(draft), credited = text !== String(draft.text || "").trim();
  if (text.length > MAX_TEXT_LENGTH) errors.push(credited ? "Text and credit must be 3,000 characters or fewer." : "Text must be 3,000 characters or fewer.");
  if (draft.media.length > 4) errors.push("A maximum of four media items is supported.");
  return errors;
}
