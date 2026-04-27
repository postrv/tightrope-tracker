/**
 * Safely embed a JSON value inside a `<script type="application/json">` tag.
 *
 * `JSON.stringify` alone is unsafe: a string anywhere in the value containing
 * the literal `</script>` (e.g. an operator-curated indicator note loaded
 * from D1) would terminate the script tag and inject the remainder of the
 * JSON as HTML/JS — classic JSON-in-script DOM-XSS.
 *
 * Escaping `<`, `>`, `&` and the JS-literal-breaker line/paragraph separators
 * to their `\uXXXX` JSON escapes is byte-for-byte equivalent under
 * `JSON.parse`, so the client-side bootstrap that does
 *   JSON.parse(scriptEl.textContent)
 * still receives the original value.
 *
 * Reference: https://owasp.org/www-community/xss-filter-evasion-cheatsheet
 */
const LS = " ";
const PS = " ";

export function safeJsonForScriptTag(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LS).join("\\u2028")
    .split(PS).join("\\u2029");
}
