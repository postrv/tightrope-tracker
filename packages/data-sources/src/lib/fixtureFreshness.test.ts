import { describe, expect, it } from "vitest";
import { assertFixtureFresh } from "./fixtureFreshness.js";
import { AdapterError } from "./errors.js";

const DAY_MS = 86_400_000;

describe("assertFixtureFresh", () => {
  it("does not throw when the fixture is within the freshness window", () => {
    const now = Date.parse("2026-04-19T00:00:00Z");
    expect(() =>
      assertFixtureFresh(
        "2026-04-17T00:00:00Z",
        14 * DAY_MS,
        "src",
        "local:fixtures/x.json",
        now,
      ),
    ).not.toThrow();
  });

  it("throws AdapterError when the fixture is stale", () => {
    const now = Date.parse("2026-04-19T00:00:00Z");
    expect(() =>
      assertFixtureFresh(
        "2026-03-01T00:00:00Z", // 49 days old
        14 * DAY_MS,
        "src",
        "local:fixtures/x.json",
        now,
      ),
    ).toThrow(AdapterError);
  });

  it("mentions the observed age and threshold in the error message", () => {
    const now = Date.parse("2026-04-19T00:00:00Z");
    try {
      assertFixtureFresh(
        "2026-03-01T00:00:00Z",
        14 * DAY_MS,
        "src",
        "local:fixtures/x.json",
        now,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).message).toContain("49.0");
      expect((err as AdapterError).message).toContain("14.0");
      expect((err as AdapterError).message).toContain("stale");
    }
  });

  it("throws AdapterError when observed_at is not a valid ISO timestamp", () => {
    expect(() =>
      assertFixtureFresh("not a date", 14 * DAY_MS, "src", "local:fixtures/x.json"),
    ).toThrow(AdapterError);
  });

  it("allows fixture exactly at the freshness boundary (≤ maxAgeMs)", () => {
    const now = Date.parse("2026-04-19T00:00:00Z");
    const observedAt = new Date(now - 14 * DAY_MS).toISOString();
    expect(() =>
      assertFixtureFresh(observedAt, 14 * DAY_MS, "src", "local:fixtures/x.json", now),
    ).not.toThrow();
  });
});
