// Feedback and problem reports. The background builds a report (versions,
// the failed step, a masked page outline) and keeps it in storage.session;
// feedback.html shows every detail and sends it to FEEDBACK_ENDPOINT only
// when the user presses Send. Nothing is sent in the background.

export const FEEDBACK_ENDPOINT = "https://crossposter.mochi.is/api/feedback";
export const FEEDBACK_REPORTS_KEY = "crossposterFeedbackReports";
export const MAX_STORED_REPORTS = 5;
export const MAX_SNAPSHOT_CHARS = 250_000;
// postMessage type between feedback.html and the overlay framing it
// (shared/feedback-overlay.js).
export const FEEDBACK_FRAME_MESSAGE = "crossposter-feedback";

// Failures the user resolves on the site (signing in, adding media) are not
// bugs, so they get no "Report this problem" prompt.
const USER_ACTION_REASONS = new Set(["signed-out", "needs-media"]);

// Firefox's built-in data consent. Each part of a submission maps to one
// optional data type in the Firefox manifest; Chrome has no such permission.
// A message the user types and sends needs none.
export function feedbackConsentTypes(manifest, { details = false, outline = false } = {}) {
  const optional = manifest?.browser_specific_settings?.gecko?.data_collection_permissions?.optional;
  if (!Array.isArray(optional)) return [];
  return [
    ...(details ? ["technicalAndInteraction"] : []),
    ...(details && outline ? ["websiteContent"] : [])
  ].filter(type => optional.includes(type));
}

// Call synchronously from the Send click: Firefox only shows its consent
// prompt while a user action is being handled. Resolves false if declined.
export function requestFeedbackConsent(ext, types) {
  if (!types?.length || typeof ext.permissions?.request !== "function") return Promise.resolve(true);
  try { return Promise.resolve(ext.permissions.request({ data_collection: types })).then(Boolean, () => false); }
  catch { return Promise.resolve(false); }
}

// Reports wait in storage.session (cleared with the browser) until the form
// sends or the user closes it; only the newest few are kept.
export async function storeFeedbackReport(storage, report, { id = crypto.randomUUID(), now = Date.now() } = {}) {
  const stored = (await storage.get(FEEDBACK_REPORTS_KEY))?.[FEEDBACK_REPORTS_KEY] || {};
  const entries = Object.entries(stored).filter(([, entry]) => entry && typeof entry === "object")
    .sort(([, a], [, b]) => (b.storedAt || 0) - (a.storedAt || 0)).slice(0, MAX_STORED_REPORTS - 1);
  await storage.set({ [FEEDBACK_REPORTS_KEY]: Object.fromEntries([[id, { storedAt: now, report }], ...entries]) });
  return id;
}

export async function readFeedbackReport(storage, id) {
  return (await storage.get(FEEDBACK_REPORTS_KEY))?.[FEEDBACK_REPORTS_KEY]?.[id]?.report || null;
}

export async function removeFeedbackReport(storage, id) {
  const stored = (await storage.get(FEEDBACK_REPORTS_KEY))?.[FEEDBACK_REPORTS_KEY];
  if (!stored?.[id]) return;
  delete stored[id];
  await storage.set({ [FEEDBACK_REPORTS_KEY]: stored });
}

// The request body functions/api/feedback.js accepts. The page outline rides
// inside the report as `snapshot`.
export function feedbackSubmission({ category = "problem", message = "", report = null, includeDetails = true } = {}) {
  return {
    category,
    message: String(message).trim(),
    report: report && includeDetails ? report : null
  };
}

export async function sendFeedback(submission, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(FEEDBACK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission),
      credentials: "omit",
      cache: "no-store"
    });
  } catch {
    throw new Error("Crossposter could not reach its feedback server. Check your connection and try again.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "The feedback could not be sent.");
  return result;
}

export function isReportableFailure(item) {
  return Boolean(item && (item.error || item.result?.error) && !USER_ACTION_REASONS.has(item.result?.reason));
}

export function reportableFailures(handoff) {
  if (!handoff || ["idle", "preparing", "filling"].includes(handoff.state)) return [];
  return (handoff.results || []).filter(isReportableFailure);
}

// A crosspost-level problem not tied to one destination: the handoff itself
// failed, or media could not be prepared.
export function hasReportableHandoffError(handoff) {
  if (!handoff || ["idle", "preparing", "filling"].includes(handoff.state)) return false;
  return handoff.state === "error" || Boolean(handoff.mediaErrors?.length);
}

// Sign-in, sign-up, and account-checkpoint routes of the supported sites. A
// destination tab that lands on one of these after a handoff is signed out.
// Signed out, X sends its post intent to /i/jf/onboarding/web (2026-10-12).
export const SIGN_IN_PATH = /^\/(?:login|signin|sign-in|signup|sign-up|i\/flow\/(?:login|signup)|i\/jf\/onboarding|accounts\/(?:login|emailsignup|signup)|uas\/login|authwall|checkpoint|recover)(?:[/?#.]|$)/i;

export function isSignInUrl(url) {
  try { return SIGN_IN_PATH.test(new URL(url).pathname); }
  catch { return false; }
}

export function signedOutMessage(label) {
  return `You are not signed in to ${label} in this browser. Sign in to ${label}, then use the Crossposter sidebar.`;
}

export function browserSummary(userAgent = "") {
  const ua = String(userAgent);
  const browsers = [["Edge", /Edg(?:A|iOS)?\/(\d+)/], ["Opera", /OPR\/(\d+)/], ["Vivaldi", /Vivaldi\/(\d+)/], ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/], ["Chrome", /(?:Chrome|CriOS)\/(\d+)/], ["Safari", /Version\/(\d+).*Safari/]];
  const [name = "", pattern] = browsers.find(([, expression]) => expression.test(ua)) || [];
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS"
    : /CrOS/.test(ua) ? "ChromeOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return { name, version: pattern ? ua.match(pattern)[1] : "", os };
}

// Error messages are mostly Crossposter's own, but some carry a platform or
// network error. Keep URLs to their site and drop anything that looks like an
// address, an id, or a token.
export function redactText(value, max = 400) {
  const text = String(value ?? "")
    .replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, match => {
      try { const url = new URL(match); return `${url.protocol}//${url.hostname}${url.pathname.length > 1 || url.search ? "/…" : ""}`; }
      catch { return "{url}"; }
    })
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi, "{email}")
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, match => /\d/.test(match) && /[A-Za-z]/.test(match) ? "{token}" : match)
    .replace(/\d{6,}/g, "{n}")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== "" && value !== null));
}

export function summarizeHandoffResult(entry = {}) {
  const result = entry.result || {};
  const error = entry.error || result.error;
  return compact({
    network: typeof entry.network === "string" ? entry.network : undefined,
    ok: !error,
    stage: typeof result.stage === "string" ? result.stage : undefined,
    reason: typeof result.reason === "string" ? result.reason : undefined,
    composerOpened: typeof result.composerOpened === "boolean" ? result.composerOpened : undefined,
    textInserted: typeof result.textInserted === "boolean" ? result.textInserted : undefined,
    mediaInserted: Number.isFinite(result.mediaInserted) ? result.mediaInserted : undefined,
    retryable: typeof result.retryable === "boolean" ? result.retryable : undefined,
    discoveryMs: Number.isFinite(result.discoveryMs) ? Math.round(result.discoveryMs) : undefined,
    stages: Array.isArray(result.stages) ? result.stages.slice(0, 30).map(step => compact({
      stage: typeof step?.stage === "string" ? step.stage : String(step ?? ""),
      elapsedMs: Number.isFinite(step?.elapsedMs) ? Math.round(step.elapsedMs) : undefined
    })) : undefined,
    error: error ? redactText(error) : undefined
  });
}

// Never the post's text, links, or media — only their shape.
export function summarizeCrosspost(session) {
  const handoff = session?.handoff || {};
  return compact({
    state: handoff.state,
    sourceNetwork: session?.draft?.sourceNetwork || undefined,
    destinations: Array.isArray(handoff.networks) ? [...handoff.networks] : undefined,
    textLength: typeof handoff.text === "string" ? handoff.text.length : undefined,
    linkCount: Array.isArray(session?.draft?.links) ? session.draft.links.length : undefined,
    media: Array.isArray(handoff.media) ? handoff.media.map(item => compact({
      kind: typeof item?.kind === "string" ? item.kind : undefined,
      type: typeof item?.type === "string" ? item.type.slice(0, 60) : undefined,
      sizeKB: Number.isFinite(item?.size) ? Math.round(item.size / 1024) : undefined
    })) : undefined,
    results: Array.isArray(handoff.results) ? handoff.results.map(summarizeHandoffResult) : undefined,
    mediaErrors: handoff.mediaErrors?.length ? handoff.mediaErrors.map(error => redactText(error)) : undefined,
    error: handoff.error ? redactText(handoff.error) : undefined,
    groupError: handoff.groupError ? redactText(handoff.groupError) : undefined
  });
}

const SURFACES = new Set(["tray", "compose", "popup"]);

export function buildFeedbackReport({ kind = "manual", surface = "", error = "", manifest, userAgent = "", language = "", enabledPlatforms, session, network = "", diagnostics = null, diagnosticsError = "", now = new Date() } = {}) {
  const handoff = session?.handoff;
  const report = {
    v: 1,
    kind: kind === "error" ? "error" : "manual",
    // Minute precision is enough to line a report up with a site change.
    createdAt: new Date(Math.floor(now.getTime() / 60000) * 60000).toISOString(),
    extension: { version: String(manifest?.version || ""), build: manifest?.browser_specific_settings?.gecko ? "firefox" : "chrome" },
    browser: { ...browserSummary(userAgent), language: String(language || "") }
  };
  if (SURFACES.has(surface)) report.surface = surface;
  if (error) report.error = redactText(error);
  if (Array.isArray(enabledPlatforms)) report.platforms = enabledPlatforms.filter(id => typeof id === "string");
  if (handoff && handoff.state !== "idle") report.crosspost = summarizeCrosspost(session);
  if (network) report.handoff = summarizeHandoffResult(handoff?.results?.find(item => item.network === network) || { network });
  if (diagnostics?.page) report.page = { ...diagnostics.page, passwordField: diagnostics.passwordField === true, signInLink: diagnostics.signInLink === true };
  if (typeof diagnostics?.snapshot === "string" && diagnostics.snapshot) {
    report.snapshot = diagnostics.snapshot.slice(0, MAX_SNAPSHOT_CHARS);
    if (diagnostics.snapshotStats) report.snapshotStats = diagnostics.snapshotStats;
  } else if (diagnosticsError) report.diagnosticsError = redactText(diagnosticsError, 300);
  return report;
}
