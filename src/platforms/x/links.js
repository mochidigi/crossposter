import { syndicationToken } from "./download.js";

const SHORTENER = /^https?:\/\/t\.co\/([A-Za-z0-9]+)/;

// t.co links carry click-tracking query strings in the DOM
// (https://t.co/abc?twclid=…); the syndication payload lists the bare form.
export function shortLinkKey(url = "") {
  const match = String(url).match(SHORTENER);
  return match ? `https://t.co/${match[1]}` : "";
}

export function isShortLink(url = "") {
  return SHORTENER.test(String(url));
}

// Maps each t.co URL in a tweet-result payload to its expanded target.
export function parseTweetLinks(payload) {
  const map = new Map();
  const collect = entity => {
    const key = shortLinkKey(entity?.url);
    const expanded = String(entity?.expanded_url || "").trim();
    if (key && /^https?:\/\//i.test(expanded)) map.set(key, expanded);
  };
  for (const entity of payload?.entities?.urls || []) collect(entity);
  for (const entity of payload?.quoted_tweet?.entities?.urls || []) collect(entity);
  const cardUrl = payload?.card?.binding_values?.card_url?.string_value;
  const cardKey = shortLinkKey(payload?.card?.url);
  if (cardKey && !map.has(cardKey) && /^https?:\/\//i.test(String(cardUrl || "")) && !isShortLink(cardUrl)) map.set(cardKey, String(cardUrl));
  return map;
}

export function replaceShortLinks(text, map) {
  return String(text || "").replace(/https?:\/\/t\.co\/[A-Za-z0-9]+(?:\?[^\s)\]]*)?/g, match => map.get(shortLinkKey(match)) || match);
}

export function tweetIdFromUrl(url = "") {
  return String(url).match(/\/status\/(\d+)/)?.[1] || "";
}

async function fetchTweetLinks(tweetId, fetcher, timeoutMs) {
  if (!tweetId) return new Map();
  try {
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=${syndicationToken(tweetId)}`;
    const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    const response = await fetcher(url, { credentials: "omit", signal });
    return response?.ok ? parseTweetLinks(await response.json()) : new Map();
  } catch {
    return new Map();
  }
}

const withoutWww = url => url.replace(/^(https?:\/\/)www\./i, "$1");

// Resolves the t.co links of a captured tweet through X's own syndication
// endpoint (the same one the video downloader uses) so the draft carries the
// real destination URLs. A link it does not list falls back to the URL the
// page showed for it (`expandedUrl`, inline links only), which lacks "www.";
// that is restored when the payload holds the same URL under another t.co
// code (a long post's opening links). Anything left keeps its t.co URL,
// which still redirects when posted elsewhere.
export async function expandTweetLinks(captured = {}, fetcher = fetch, { timeoutMs = 4000 } = {}) {
  const links = Array.isArray(captured.links) ? captured.links : [];
  const text = String(captured.text || "");
  if (!links.some(link => isShortLink(link?.url)) && !isShortLink(text.match(/https?:\/\/t\.co\/\S+/)?.[0])) return captured;
  const map = await fetchTweetLinks(tweetIdFromUrl(captured.sourceUrl), fetcher, timeoutMs);
  const listed = new Map([...map.values()].map(url => [withoutWww(url), url]));
  for (const link of links) {
    const key = shortLinkKey(link?.url);
    const shown = String(link?.expandedUrl || "").trim();
    if (key && !map.has(key) && /^https?:\/\/\S+$/i.test(shown)) map.set(key, listed.get(withoutWww(shown)) || shown);
  }
  if (!map.size) return captured;
  return {
    ...captured,
    text: replaceShortLinks(text, map),
    links: links.map(link => {
      const expanded = map.get(shortLinkKey(link?.url));
      return expanded ? { ...link, url: expanded } : link;
    })
  };
}
