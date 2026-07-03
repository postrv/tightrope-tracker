import { describe, expect, it } from "vitest";
import {
  CADENCE_PERIOD_DAYS,
  computeSourceCadence,
  evaluateCadenceState,
  type ExpectedCadence,
} from "./cadence.js";
import { SOURCES } from "./indicators.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-03T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

describe("evaluateCadenceState", () => {
  it("trading-daily: fresh within a day is green, a weekend gap is amber, past grace is red", () => {
    const base = { cadence: "trading-daily" as ExpectedCadence, graceDays: 5, now: NOW };
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(0.5) })).toBe("green");
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(1) })).toBe("green"); // == period
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(3) })).toBe("amber"); // long weekend
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(5) })).toBe("amber"); // == grace
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(6) })).toBe("red"); // past grace
  });

  it("monthly: green inside the month, amber once a release is overdue, red past grace", () => {
    const base = { cadence: "monthly" as ExpectedCadence, graceDays: 45, now: NOW };
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(20) })).toBe("green");
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(31) })).toBe("green"); // == period
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(38) })).toBe("amber");
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(45) })).toBe("amber"); // == grace
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(46) })).toBe("red");
  });

  it("quarterly: boundary at period (92) and grace (110)", () => {
    const base = { cadence: "quarterly" as ExpectedCadence, graceDays: 110, now: NOW };
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(92) })).toBe("green");
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(93) })).toBe("amber");
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(110) })).toBe("amber");
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(111) })).toBe("red");
  });

  it("event: no amber band — green until grace, red after (OBR EFO between fiscal events)", () => {
    const base = { cadence: "event" as ExpectedCadence, graceDays: 230, now: NOW };
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(120) })).toBe("green"); // ~4mo since EFO
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(230) })).toBe("green"); // == grace
    expect(evaluateCadenceState({ ...base, latestObservedAt: daysAgo(231) })).toBe("red");
  });

  it("prefers the publication instant (releasedAt) over the reference period", () => {
    // A monthly ONS series: reference month is 60 days old (would be red on
    // observedAt alone) but it was published 10 days ago — green.
    expect(
      evaluateCadenceState({
        latestObservedAt: daysAgo(60),
        latestReleasedAt: daysAgo(10),
        cadence: "monthly",
        graceDays: 50,
        now: NOW,
      }),
    ).toBe("green");
  });

  it("treats a future-dated anchor as green (clock skew / fixture stamped ahead)", () => {
    expect(
      evaluateCadenceState({ latestObservedAt: daysAgo(-2), cadence: "trading-daily", graceDays: 5, now: NOW }),
    ).toBe("green");
  });

  it("treats an unparseable anchor as red", () => {
    expect(
      evaluateCadenceState({ latestObservedAt: "not-a-date", cadence: "monthly", graceDays: 45, now: NOW }),
    ).toBe("red");
  });

  it("period table matches the documented publication rhythms", () => {
    expect(CADENCE_PERIOD_DAYS["trading-daily"]).toBe(1);
    expect(CADENCE_PERIOD_DAYS.monthly).toBe(31);
    expect(CADENCE_PERIOD_DAYS.quarterly).toBe(92);
    expect(CADENCE_PERIOD_DAYS.biannual).toBe(183);
    expect(CADENCE_PERIOD_DAYS.event).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("computeSourceCadence", () => {
  it("rolls indicators up to one entry per source and evaluates state", () => {
    const out = computeSourceCadence(
      [
        { sourceId: "boe_yields", observedAt: daysAgo(1) }, // green
        { sourceId: "boe_yields", observedAt: daysAgo(1) },
        { sourceId: "ons_psf", observedAt: daysAgo(60), releasedAt: daysAgo(48) }, // amber via releasedAt
        { sourceId: "mhclg", observedAt: daysAgo(120) }, // red (quarterly, grace 110)
      ],
      NOW,
    );
    const byId = new Map(out.map((c) => [c.sourceId, c]));
    expect(byId.get("boe_yields")!.state).toBe("green");
    expect(byId.get("ons_psf")!.state).toBe("amber");
    expect(byId.get("ons_psf")!.latestReleasedAt).toBe(daysAgo(48));
    expect(byId.get("mhclg")!.state).toBe("red");
    // Sorted by sourceId for stable UI order.
    expect(out.map((c) => c.sourceId)).toEqual([...out.map((c) => c.sourceId)].sort());
  });

  it("anchors a source on its freshest reading across indicators", () => {
    const out = computeSourceCadence(
      [
        { sourceId: "boe_yields", observedAt: daysAgo(9) }, // stale gilt
        { sourceId: "boe_yields", observedAt: daysAgo(1) }, // fresh breakeven — this should win
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.state).toBe("green");
    expect(out[0]!.latestObservedAt).toBe(daysAgo(1));
  });

  it("skips observations whose source_id has no SOURCES entry", () => {
    const out = computeSourceCadence([{ sourceId: "delivery_milestones", observedAt: daysAgo(1) }], NOW);
    expect(out).toEqual([]);
  });
});

describe("SOURCES cadence registry completeness", () => {
  it("every source declares a valid cadence and a positive graceDays", () => {
    const valid: ExpectedCadence[] = ["trading-daily", "monthly", "quarterly", "biannual", "event"];
    for (const [id, src] of Object.entries(SOURCES)) {
      expect(valid, `${id} has an invalid expectedCadence`).toContain(src.expectedCadence);
      expect(src.graceDays, `${id} graceDays must be > 0`).toBeGreaterThan(0);
      // For non-event cadences the amber band only exists when grace exceeds
      // the publication period — otherwise the source flips green→red with no
      // predictive warning, which defeats the point of the registry.
      if (src.expectedCadence !== "event") {
        expect(src.graceDays, `${id} graceDays must exceed its cadence period`).toBeGreaterThan(
          CADENCE_PERIOD_DAYS[src.expectedCadence],
        );
      }
    }
  });
});
