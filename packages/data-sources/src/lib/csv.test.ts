import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";

/**
 * The original parseCsv padded missing cells with "" and silently
 * truncated extra cells. Both modes are dangerous for regulatory data:
 *
 *   - Missing cells → an adapter reads `""`, parseNum returns null,
 *     row is dropped, and the row-count audit chip goes green.
 *   - Extra cells → a BoE footnote row that contains an embedded comma
 *     ("Note, see page 2") splits into too many fields; the parser
 *     truncates to header length, producing a syntactically valid row
 *     with the wrong numeric shifted into the wrong column. That's a
 *     silent data-corruption vector.
 *
 * parseCsv now throws on any row whose cell count differs from the
 * header. Callers that need to tolerate ragged CSVs must opt in
 * explicitly via `parseCsv(body, { tolerateRaggedRows: true })`.
 */
describe("parseCsv — strict column-count enforcement", () => {
  it("parses a well-formed 2-column CSV", () => {
    const rows = parseCsv("a,b\n1,2\n3,4");
    expect(rows).toEqual([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
  });

  it("throws on a row with fewer cells than the header", () => {
    expect(() => parseCsv("a,b\n1")).toThrow(/column count|cells|mismatch/i);
  });

  it("throws on a row with more cells than the header (the embedded-comma landmine)", () => {
    expect(() => parseCsv("a,b\n1,2,3")).toThrow(/column count|cells|mismatch/i);
  });

  it("names the offending row index and counts in the error message", () => {
    try {
      parseCsv("a,b,c\n1,2,3\n4,5");
      expect.fail("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      // Header has 3 columns; row 2 has 2 cells.
      expect(msg).toMatch(/row/i);
      expect(msg).toContain("3");
      expect(msg).toContain("2");
    }
  });

  it("trims whitespace and does not count trailing blank lines as rows", () => {
    const rows = parseCsv("a,b\n1,2\n\n3,4\n");
    expect(rows).toEqual([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
  });

  it("opt-in tolerateRaggedRows restores the permissive behaviour", () => {
    const rows = parseCsv("a,b,c\n1,2\n3,4,5,6", { tolerateRaggedRows: true });
    // Missing cells padded with ""; extra cells silently truncated. Only
    // adapters that genuinely need this (none currently) should opt in.
    expect(rows).toEqual([
      { a: "1", b: "2", c: "" },
      { a: "3", b: "4", c: "5" },
    ]);
  });

  it("returns [] on input with fewer than two non-blank lines", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("a,b")).toEqual([]);
    expect(parseCsv("a,b\n")).toEqual([]);
  });
});
