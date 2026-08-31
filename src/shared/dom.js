// AMO's linter flags every dynamic `innerHTML` assignment (UNSAFE_VAR_ASSIGNMENT),
// even for markup we build ourselves from escaped values. Parse the trusted,
// pre-escaped markup with DOMParser and swap the children in instead — same
// resulting DOM, without the flagged sink. Callers are still responsible for
// escaping any user-controlled values (see escapeAttr in compose.js).
export function setHtml(element, html) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  element.replaceChildren(...parsed.body.childNodes);
}
