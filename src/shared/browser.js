// Chrome (since 148) and Firefox both expose the promise-based WebExtension
// APIs as `browser`; the manifests require those versions.
export const ext = globalThis.browser;
