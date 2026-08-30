export function freshComposerUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set("mode", "fresh");
  return url.href;
}

export function isFreshComposerUrl(value) {
  try { return new URL(value).searchParams.get("mode") === "fresh"; }
  catch { return false; }
}
