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
    endpoint: `${parsed.origin}${parsed.pathname}`
  };
}

function safelyDecode(value) { try { return decodeURIComponent(String(value || "").replace(/\+/g, " ")); } catch { return String(value || ""); } }
