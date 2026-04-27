import { describe, expect, it } from "vitest";
import { safeJsonForScriptTag } from "./safeJson.js";

describe("safeJsonForScriptTag", () => {
  it("round-trips simple JSON values byte-for-byte equivalent under JSON.parse", () => {
    const cases: unknown[] = [
      { a: 1, b: "two", c: [3, 4, 5] },
      [{ id: "gilt_10y", value: 4.92 }],
      "plain string",
      42,
      true,
      null,
    ];
    for (const v of cases) {
      expect(JSON.parse(safeJsonForScriptTag(v))).toEqual(v);
    }
  });

  it("escapes < as \\u003c so '</script>' inside a string cannot terminate the script tag", () => {
    // The whole point of SEC-5: the previous implementation called
    // JSON.stringify directly into set:html. A string containing the
    // sequence '</script>' (e.g. an operator-curated indicator note from D1)
    // would close the <script type="application/json"> tag and the rest
    // of the JSON would be parsed as HTML/JS.
    const out = safeJsonForScriptTag({ note: "trouble </script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("</");
    expect(out).toContain("\\u003c");
    // And it must still parse back to the original.
    const parsed = JSON.parse(out);
    expect(parsed.note).toBe("trouble </script><script>alert(1)</script>");
  });

  it("escapes U+2028 / U+2029 (LINE SEPARATOR / PARAGRAPH SEPARATOR)", () => {
    // These code points are valid in JSON but break legacy ECMAScript string
    // literal parsing. Escaping them keeps the embedded JSON safe even if
    // a future toolchain naively pastes it into a JS literal.
    const out = safeJsonForScriptTag({ s: "a b c" });
    expect(out).not.toContain(" ");
    expect(out).not.toContain(" ");
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    expect(JSON.parse(out).s).toBe("a b c");
  });

  it("escapes & and > as a defence-in-depth against script-injection vectors via comments", () => {
    const out = safeJsonForScriptTag({ s: "<!-- & --> stuff" });
    expect(out).not.toMatch(/[<>&]/);
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u003e");
    expect(out).toContain("\\u0026");
    expect(JSON.parse(out).s).toBe("<!-- & --> stuff");
  });

  it("never emits the literal byte sequence '<!--' or '-->' (HTML comment delimiters)", () => {
    const out = safeJsonForScriptTag({ a: "<!--", b: "-->" });
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("-->");
    expect(JSON.parse(out)).toEqual({ a: "<!--", b: "-->" });
  });

  it("handles empty objects, arrays, and nested structures correctly", () => {
    expect(JSON.parse(safeJsonForScriptTag({}))).toEqual({});
    expect(JSON.parse(safeJsonForScriptTag([]))).toEqual([]);
    expect(JSON.parse(safeJsonForScriptTag({ a: { b: { c: ["</script>"] } } }))).toEqual({
      a: { b: { c: ["</script>"] } },
    });
  });
});
