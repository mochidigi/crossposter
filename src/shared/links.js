import { detectNetwork, normalizeCapturedLinks } from "./draft.js";
import { expandTweetLinks } from "../platforms/x/links.js";

// Per-network resolvers that turn a capture's shortened or wrapped link URLs
// (X's t.co, and later other platforms' redirectors) into their real targets
// before the draft is created. Each resolver must leave the capture untouched
// when it cannot resolve. Resolvers see the adapter's raw links, so hints
// such as X's `expandedUrl` reach them; normalizing afterwards drops those
// and merges short links that resolved to the same URL.
const LINK_EXPANDERS = Object.freeze({
  x: expandTweetLinks
});

export async function expandCapturedLinks(captured = {}, fetcher = fetch) {
  const network = captured.sourceNetwork || detectNetwork(captured.sourceUrl || "");
  const expand = LINK_EXPANDERS[network];
  let expanded = captured;
  if (expand) {
    try {
      expanded = await expand(captured, fetcher);
    } catch {}
  }
  return { ...expanded, links: normalizeCapturedLinks(expanded.links) };
}
