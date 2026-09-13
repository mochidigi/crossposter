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

// Resolves the t.co links of a captured tweet through X's own syndication
// endpoint (the same one the video downloader uses) so the draft carries the
// real destination URLs. Any failure leaves the t.co links in place; they
// still redirect when posted elsewhere.
export async function expandTweetLinks(captured = {}, fetcher = fetch, { timeoutMs = 4000 } = {}) {
  const links = Array.isArray(captured.links) ? captured.links : [];
  const text = String(captured.text || "");
  if (!links.some(link => isShortLink(link?.url)) && !isShortLink(text.match(/https?:\/\/t\.co\/\S+/)?.[0])) return captured;
  const tweetId = tweetIdFromUrl(captured.sourceUrl);
  if (!tweetId) return captured;
  let map;
  try {
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=${syndicationToken(tweetId)}`;
    const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    const response = await fetcher(url, { credentials: "omit", signal });
    if (!response?.ok) return captured;
    map = parseTweetLinks(await response.json());
  } catch {
    return captured;
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
