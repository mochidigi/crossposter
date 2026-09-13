import { detectNetwork, normalizeCapturedLinks } from "./draft.js";
import { expandTweetLinks } from "../platforms/x/links.js";

// Per-network resolvers that turn a capture's shortened or wrapped link URLs
// (X's t.co, and later other platforms' redirectors) into their real targets
// before the draft is created. Each resolver must leave the capture untouched
// when it cannot resolve.
const LINK_EXPANDERS = Object.freeze({
  x: expandTweetLinks
});

export async function expandCapturedLinks(captured = {}, fetcher = fetch) {
  const links = normalizeCapturedLinks(captured.links);
  const network = captured.sourceNetwork || detectNetwork(captured.sourceUrl || "");
  const expand = LINK_EXPANDERS[network];
  if (!expand) return { ...captured, links };
  try {
    return await expand({ ...captured, links }, fetcher);
  } catch {
    return { ...captured, links };
  }
}
