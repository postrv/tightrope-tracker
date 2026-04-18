import { describe, expect, it } from "vitest";
import { mhclgHousingAdapter } from "./mhclgHousing.js";
import type { HistoricalFetchResult } from "../types.js";

describe("mhclgHousingAdapter", () => {
  describe("fetch (live quarterly fixture)", () => {
    it("emits both housing_trajectory and planning_consents observations", async () => {
      const res = await mhclgHousingAdapter.fetch(globalThis.fetch);
      const ids = res.observations.map((o) => o.indicatorId).sort();
      expect(ids).toEqual(["housing_trajectory", "planning_consents"]);
      for (const o of res.observations) {
        expect(Number.isFinite(o.value)).toBe(true);
        expect(o.sourceId).toBe("mhclg");
        expect(o.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00(\.\d{3})?Z$/);
        // Live observations use raw sha256 (no hist: prefix — that's reserved
        // for the historical path).
        expect(o.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });

  describe("fetchHistorical (curated quarterly history)", () => {
    it("is present on the adapter (not undefined)", () => {
      expect(typeof mhclgHousingAdapter.fetchHistorical).toBe("function");
    });

    it("emits hist:-prefixed observations for every quarter in range", async () => {
      const res = (await mhclgHousingAdapter.fetchHistorical!(
        globalThis.fetch,
        { from: new Date("2022-01-01T00:00:00Z"), to: new Date("2025-12-31T23:59:59Z") },
      )) as HistoricalFetchResult;

      expect(res.observations.length).toBeGreaterThan(0);
      for (const o of res.observations) {
        expect(o.sourceId).toBe("mhclg");
        expect(["housing_trajectory", "planning_consents"]).toContain(o.indicatorId);
        expect(Number.isFinite(o.value)).toBe(true);
        expect(o.payloadHash).toMatch(/^hist:[0-9a-f]{64}$/);
      }
      // At least one observation for each indicator.
      const housing = res.observations.filter((o) => o.indicatorId === "housing_trajectory");
      const planning = res.observations.filter((o) => o.indicatorId === "planning_consents");
      expect(housing.length).toBeGreaterThanOrEqual(12);
      expect(planning.length).toBeGreaterThanOrEqual(10);
    });

    it("clips to the requested [from, to] range", async () => {
      const from = new Date("2024-01-01T00:00:00Z");
      const to = new Date("2024-12-31T23:59:59Z");
      const res = (await mhclgHousingAdapter.fetchHistorical!(
        globalThis.fetch,
        { from, to },
      )) as HistoricalFetchResult;
      for (const o of res.observations) {
        const ms = Date.parse(o.observedAt);
        expect(ms).toBeGreaterThanOrEqual(from.getTime());
        expect(ms).toBeLessThanOrEqual(to.getTime());
      }
      // 2024 has 4 quarters → up to 8 observations (2 indicators x 4 quarters).
      expect(res.observations.length).toBeGreaterThan(0);
      expect(res.observations.length).toBeLessThanOrEqual(8);
    });

    it("filters out null values (e.g. quarters where a series was not extracted)", async () => {
      // Q1 2025 planning_consents is null in the fixture (HTML release was not
      // extractable at curation time). fetchHistorical must skip it rather
      // than emit a NaN/null-valued observation which writeHistoricalObservations
      // would reject as non-finite.
      const res = (await mhclgHousingAdapter.fetchHistorical!(
        globalThis.fetch,
        { from: new Date("2025-01-01T00:00:00Z"), to: new Date("2025-06-30T23:59:59Z") },
      )) as HistoricalFetchResult;
      const q1Planning = res.observations.filter(
        (o) => o.indicatorId === "planning_consents" && o.observedAt.startsWith("2025-03-31"),
      );
      expect(q1Planning).toHaveLength(0);
    });

    it("sorts observations ascending by observedAt", async () => {
      const res = (await mhclgHousingAdapter.fetchHistorical!(
        globalThis.fetch,
        { from: new Date("2022-01-01T00:00:00Z"), to: new Date("2025-12-31T23:59:59Z") },
      )) as HistoricalFetchResult;
      for (let i = 1; i < res.observations.length; i++) {
        expect(
          res.observations[i - 1]!.observedAt <= res.observations[i]!.observedAt,
          `observation ${i - 1} (${res.observations[i - 1]!.observedAt}) should precede observation ${i} (${res.observations[i]!.observedAt})`,
        ).toBe(true);
      }
    });

    it("reports earliestObservedAt and latestObservedAt", async () => {
      const res = (await mhclgHousingAdapter.fetchHistorical!(
        globalThis.fetch,
        { from: new Date("2022-01-01T00:00:00Z"), to: new Date("2025-12-31T23:59:59Z") },
      )) as HistoricalFetchResult;
      expect(res.earliestObservedAt).not.toBeNull();
      expect(res.latestObservedAt).not.toBeNull();
      expect(res.earliestObservedAt! <= res.latestObservedAt!).toBe(true);
    });

    it("produces deterministic hashes — same input yields identical hash per observation", async () => {
      const opts = { from: new Date("2024-01-01T00:00:00Z"), to: new Date("2024-12-31T23:59:59Z") };
      const r1 = await mhclgHousingAdapter.fetchHistorical!(globalThis.fetch, opts);
      const r2 = await mhclgHousingAdapter.fetchHistorical!(globalThis.fetch, opts);
      expect(r1.observations.length).toBe(r2.observations.length);
      for (let i = 0; i < r1.observations.length; i++) {
        expect(r1.observations[i]!.payloadHash).toBe(r2.observations[i]!.payloadHash);
        expect(r1.observations[i]!.value).toBe(r2.observations[i]!.value);
      }
    });
  });
});
