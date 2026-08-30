const LINKEDIN_API_HOST = "www.linkedin.com";
const LINKEDIN_API_PREFIX = "/voyager/api/";
const DIRECT_PUBLISH_ENDPOINT = /(?:\/normshares(?:[/?]|$)|\/ugcposts(?:[/?]|$)|[?&]queryId=[^&]*(?:feeddashcreatepost|create(?:post|share)|publish(?:post|share)))/i;
const PUBLISH_PAYLOAD_SIGNAL = /(?:feeddashcreatepost|createpost|createshare|publishpost|publishshare)/i;
const COMMENT_ONLY_SIGNAL = /(?:createcomment|comments?\/|socialactions)/i;

export function linkedInRequestBodyText(requestBody = {}) {
  const parts = [];
  for (const [name, values] of Object.entries(requestBody.formData || {})) {
    for (const value of values || []) parts.push(`${name}=${value}`);
  }
  const decoder = new TextDecoder();
  for (const entry of requestBody.raw || []) {
    if (!entry?.bytes) continue;
    try { parts.push(decoder.decode(entry.bytes)); } catch {}
  }
  return parts.join("\n").slice(0, 256000);
}

export function linkedInPublishCandidate(details = {}) {
  if (String(details.method || "").toUpperCase() !== "POST" || Number(details.tabId) < 0) return null;
  let parsed;
  try { parsed = new URL(details.url); } catch { return null; }
  if (parsed.hostname !== LINKEDIN_API_HOST || !parsed.pathname.startsWith(LINKEDIN_API_PREFIX)) return null;
  const body = linkedInRequestBodyText(details.requestBody);
  const decodedBody = safelyDecode(body);
  const endpoint = `${parsed.pathname}${parsed.search}`;
  const combined = `${endpoint}\n${decodedBody}`;
  const directEndpoint = DIRECT_PUBLISH_ENDPOINT.test(endpoint);
  const graphqlPublish = parsed.pathname.endsWith("/graphql") && PUBLISH_PAYLOAD_SIGNAL.test(combined);
  if ((!directEndpoint && !graphqlPublish) || (COMMENT_ONLY_SIGNAL.test(combined) && !directEndpoint)) return null;
  return {
    requestId: String(details.requestId || ""),
    tabId: Number(details.tabId),
    detectedAt: Number(details.timeStamp) || Date.now(),
    endpoint: `${parsed.origin}${parsed.pathname}`,
    textHint: linkedInPostTextHint(decodedBody)
  };
}

export function linkedInPostTextHint(body = "") {
  const candidates = [];
  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (/(?:commentary|text|message|comment)/i.test(key) && isHumanText(value)) candidates.push(value);
      return;
    }
    if (Array.isArray(value)) { value.forEach(item => visit(item, key)); return; }
    if (value && typeof value === "object") for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  for (const candidate of jsonCandidates(body)) {
    try { visit(JSON.parse(candidate)); } catch {}
  }
  const quoted = [...String(body).matchAll(/"(?:commentary|text|message)"\s*:\s*"((?:\\.|[^"\\])*)"/gi)];
  for (const match of quoted) {
    try {
      const value = JSON.parse(`"${match[1]}"`);
      if (isHumanText(value)) candidates.push(value);
    } catch {}
  }
  return candidates.map(normalizeText).sort((left, right) => right.length - left.length)[0]?.slice(0, 3000) || "";
}

export function linkedInTextFingerprint(value = "") {
  return normalizeText(value).toLocaleLowerCase().slice(0, 280);
}

function jsonCandidates(body) {
  const value = String(body || "").trim();
  const candidates = value ? [value] : [];
  for (const part of value.split(/[&\n]/)) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    const decoded = safelyDecode(part.slice(equals + 1));
    if (decoded.startsWith("{") || decoded.startsWith("[")) candidates.push(decoded);
  }
  return candidates;
}

function isHumanText(value) {
  const text = normalizeText(value);
  return Boolean(text && text.length <= 3000 && !/^urn:li:/i.test(text) && !/^https?:\/\//i.test(text));
}

function normalizeText(value) { return String(value || "").replace(/\\n/g, "\n").replace(/\s+/g, " ").trim(); }
function safelyDecode(value) { try { return decodeURIComponent(String(value || "").replace(/\+/g, " ")); } catch { return String(value || ""); } }
