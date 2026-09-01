const pageVideoHintResolvers = new Map();

export function registerPageVideoHintResolver(platformId, resolver) {
  if (!platformId || typeof resolver !== "function") throw new Error("Invalid page video-hint resolver registration.");
  pageVideoHintResolvers.set(platformId, resolver);
}

export async function resolvePageVideoHint(platformId, context) {
  const resolver = pageVideoHintResolvers.get(platformId);
  return resolver ? resolver(context) : null;
}
