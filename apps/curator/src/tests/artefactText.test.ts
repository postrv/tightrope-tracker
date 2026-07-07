import { describe, expect, it } from "vitest";
import { isSchemaModeFailure, MODEL_TEXT_BUDGET, precheckArtefact, truncateForModel } from "../lib/artefactText";

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
