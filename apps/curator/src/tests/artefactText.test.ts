import { describe, expect, it } from "vitest";
import { biasForFormat, isSchemaModeFailure, MODEL_TEXT_BUDGET, precheckArtefact, truncateForModel } from "../lib/artefactText";

describe("truncateForModel", () => {
  it("returns text unchanged when within budget", () => {
    const t = "The UK Services PMI registered 48.8 in June 2026.";
    expect(truncateForModel(t)).toBe(t);
  });

  it("keeps the number-bearing lines and drops boilerplate when over budget", () => {
    const boilerplate = Array.from({ length: 5000 }, () => "Cookie preferences and navigation menu links here").join("\n");
    const signal = "The UK Services PMI registered 48.8 in June 2026.";
    const out = truncateForModel(`${boilerplate}\n${signal}`, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain(signal); // the relevance heuristic preserved the digit/month line
    // Almost all boilerplate is dropped — at most one line survives as the
    // 1-line context window around the (last) signal line.
    const cookieLines = out.split("\n").filter((l) => l.includes("Cookie preferences")).length;
    expect(cookieLines).toBeLessThanOrEqual(1);
  });

  it("falls back to a head slice when no line looks relevant", () => {
    const junk = "x".repeat(MODEL_TEXT_BUDGET * 2);
    const out = truncateForModel(junk);
    expect(out.length).toBe(MODEL_TEXT_BUDGET);
  });

  it("tail bias keeps the NEWEST rows of an all-relevant table, in document order", () => {
    // A spreadsheet projection: every line carries digits, so the relevance
    // heuristic keeps everything and the bias decides which end survives.
    const rows = Array.from({ length: 300 }, (_, i) => `2022-01-01 plus ${i} months, rate ${(i % 30) / 10}`);
    const out = truncateForModel(rows.join("\n"), 1_000, "tail");
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out).toContain("plus 299 months"); // newest row survived
    expect(out).not.toContain("plus 0 months,"); // oldest was dropped
    // Document order preserved after the reverse-fill.
    expect(out.indexOf("plus 298 months")).toBeLessThan(out.indexOf("plus 299 months"));
  });

  it("tail bias falls back to a tail slice when no line looks relevant", () => {
    const junk = `${"x".repeat(500)}\n${"y".repeat(500)}`;
    const out = truncateForModel(junk, 100, "tail");
    expect(out).toBe(junk.slice(-100));
  });

  it("anchor terms keep the figure's line even when digit-dense front matter would flood the budget", () => {
    // The EFO shape: a long digit-dense contents page, the headroom sentence
    // buried mid-document. Positional head-fill would spend the whole budget
    // on the contents; the anchor tier must keep the headroom line first.
    const contents = Array.from({ length: 400 }, (_, i) => `Chart 1.${i} Public finances outlook ....... page ${i + 4}`);
    const signal = "The Chancellor's headroom against the fiscal mandate is 9.9 billion in 2030-31.";
    const text = [...contents.slice(0, 200), signal, ...contents.slice(200)].join("\n");
    const out = truncateForModel(text, 2_000, "head", ["headroom"]);
    expect(out.length).toBeLessThanOrEqual(2_000);
    expect(out).toContain(signal);
    // Without anchors the same call drops the signal — the regression this guards.
    expect(truncateForModel(text, 2_000, "head")).not.toContain(signal);
  });

  it("anchor matching is case-insensitive and keeps one line of context", () => {
    const filler = Array.from({ length: 300 }, (_, i) => `row ${i} value ${i} in 2026`);
    const text = [...filler, "Table 2b", "HEADROOM (billions)", "9.9 in 2030"].join("\n");
    const out = truncateForModel(text, 200, "head", ["headroom"]);
    expect(out).toContain("HEADROOM (billions)");
    expect(out).toContain("Table 2b"); // context line above
    expect(out).toContain("9.9 in 2030"); // context line below
  });
});

describe("biasForFormat", () => {
  it("is tail only for xlsx (newest-last time series)", () => {
    expect(biasForFormat("xlsx")).toBe("tail");
    expect(biasForFormat("html")).toBe("head");
    expect(biasForFormat("pdf")).toBe("head");
    expect(biasForFormat("atom")).toBe("head");
  });
});

describe("precheckArtefact", () => {
  it("passes text carrying digits and a period token", () => {
    expect(precheckArtefact("Consumer confidence was -23 in June 2026.")).toEqual({ ok: true });
  });

  it("fails empty / trivially short artefacts", () => {
    const r = precheckArtefact("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("PRECHECK_EMPTY");
  });

  it("fails a numberless bot-challenge stub (distinct from a model failure)", () => {
    const r = precheckArtefact("Please enable JavaScript and cookies to continue to this website.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("PRECHECK_NO_DIGITS");
  });

  it("fails text with digits but no anchoring period", () => {
    const r = precheckArtefact("Item code 4471 quantity 88 unit 3 pallet 9");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("PRECHECK_NO_PERIOD");
  });
});

describe("isSchemaModeFailure", () => {
  it("detects the 5024 give-up in its several phrasings", () => {
    expect(isSchemaModeFailure("model call failed: 5024: JSON Model couldn't be met")).toBe(true);
    expect(isSchemaModeFailure("JSON mode couldn't be met")).toBe(true);
    expect(isSchemaModeFailure("some other error")).toBe(false);
  });
});
