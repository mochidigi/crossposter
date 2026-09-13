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
  web: "the web"
});

const sourceNetworks = [];

export function registerSourceNetwork(network) {
  if (!network?.id || !network?.label || typeof network.matches !== "function") throw new Error("Invalid source-network registration.");
  const index = sourceNetworks.findIndex(item => item.id === network.id);
  if (index >= 0) sourceNetworks[index] = network;
  else sourceNetworks.push(network);
}

// Leads with the original poster ("Name on X: text") so the credit is
// visible before any truncation or "see more" fold. Drafts written by the
// earlier build carried the credit as a trailing "(via Name on X)"; those are
// still recognized so a reloaded draft is never credited twice.
export function addAttribution(text, sourceAuthor, sourceNetwork, maxLength = 3000, sourceIsOwn = false) {
  const body = String(text || "").trim();
  const author = String(sourceAuthor || "").replace(/\s+/g, " ").trim();
  if (!body || !author) return body.slice(0, maxLength);
  const platform = PLATFORM_LABELS[sourceNetwork] || sourceNetworks.find(network => network.id === sourceNetwork)?.label || PLATFORM_LABELS.web;
  const prefix = `${author} on ${platform}: `;
  const legacySuffix = `(via ${author} on ${platform})`;
  const bare = body.startsWith(prefix) ? body.slice(prefix.length).trimStart()
    : body.endsWith(legacySuffix) ? body.slice(0, -legacySuffix.length).trimEnd()
    : body;
  if (sourceIsOwn) return bare.slice(0, maxLength);
  if (body.startsWith(prefix) || body.endsWith(legacySuffix)) return body.slice(0, maxLength);
  const available = Math.max(0, maxLength - prefix.length);
  return `${prefix}${bare.slice(0, available).trimEnd()}`.trim();
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
  const { text, links } = placeLinksInText(input.text, normalizeCapturedLinks(input.links));
  return {
    id: input.id || crypto.randomUUID(),
    text: addAttribution(text, sourceAuthor, sourceNetwork, 3000, sourceIsOwn),
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
  if (draft.text.length > 3000) errors.push("Text must be 3,000 characters or fewer.");
  if (draft.media.length > 4) errors.push("A maximum of four media items is supported.");
  return errors;
}
