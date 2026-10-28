import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveHousingTrajectory, derivePlanningConsents, PLANNING_CONSENTS_QUARTERLY_BASELINE_2019 } from "@tightrope/shared";
import history from "./housing-history.json" with { type: "json" };
import evidence from "../../../../data/exports/mhclg-leading-2019-2022-evidence-2026-10-28.json" with { type: "json" };
import { mhclgHousingAdapter } from "../adapters/mhclgHousing.js";

type Indicator = "housing_trajectory" | "planning_consents";
const points = history.points as Array<{
  observed_at: string;
  housing_trajectory?: Record<string, unknown>;
  planning_consents?: Record<string, unknown>;
}>;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const firstExisting = { housing_trajectory: evidence.existing_preservation.housing_first, planning_consents: evidence.existing_preservation.planning_first };

describe("MHCLG leading history from primary ODS evidence", () => {
  it("preserves the archived source bytes and identifies the count tables and columns", () => {
    for (const source of evidence.sources) {
      const bytes = readFileSync(new URL(`../../../../${source.archive}`, import.meta.url));
      expect(sha(bytes)).toBe(source.sha256);
      expect(source.source_vintage).toBe("2026-09-24");
    }
    expect(evidence.sources[0]).toMatchObject({ sheet: "LT_222a", indicator_id: "housing_trajectory" });
    expect(evidence.sources[0]!.leading_rows[0]).toMatchObject({ period: "2019 Q1", raw: 43280, sourceRow: 82, sourceColumns: ["I"] });
    expect(evidence.sources[1]).toMatchObject({ sheet: "LT_P120A", indicator_id: "planning_consents" });
    expect(evidence.sources[1]!.leading_rows[0]).toMatchObject({ period: "2019 Q1", majorGranted: 1586, minorGranted: 9615, raw: 11201, sourceRow: 50, sourceColumns: ["D", "L"] });
  });

  it("adds exactly 13 housing and 15 planning quarters with raw-count derivations and revision provenance", () => {
    expect(points).toHaveLength(30);
    for (const source of evidence.sources) {
      const id = source.indicator_id as Indicator;
      const leading = points.filter(p => p.observed_at < firstExisting[id] && p[id]);
      expect(leading).toHaveLength(id === "housing_trajectory" ? 13 : 15);
      expect(source.leading_rows).toHaveLength(leading.length);
      for (const raw of source.leading_rows) {
        const component = points.find(p => p.observed_at === raw.observedAt)?.[id];
        expect(component).toBeDefined();
        const derived = id === "housing_trajectory" ? deriveHousingTrajectory(raw.raw) : derivePlanningConsents(raw.raw);
        expect(component!.value).toBe(Math.round(derived * 10) / 10);
        expect(component!.published).toBe("2026-09-24");
        expect(component!.url).toBe(source.url);
        expect(component!.publication_note).toContain("not the original quarter release date");
        expect(component!.provenance).toMatchObject({ source_sha256: source.sha256, sheet: source.sheet, row: raw.sourceRow, columns: raw.sourceColumns });
      }
    }
    expect(PLANNING_CONSENTS_QUARTERLY_BASELINE_2019).toBe(11500);
    expect(evidence.planning_benchmark.exact_calendar_2019_grants.reduce((a, b) => a + b, 0) / 4).toBe(11174.5);
  });

  it("keeps every existing later component and the current 47.7 / 60 readings unchanged", () => {
    const retained = points.flatMap(p => (["housing_trajectory", "planning_consents"] as const)
      .filter(id => p[id] && p.observed_at >= firstExisting[id] && p.observed_at <= evidence.existing_preservation.last)
      .map(id => {
        const c = p[id]!;
        return [id, p.observed_at, c.value, c.raw_completions_sa ?? c.raw_decisions_granted, c.published, c.url];
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(retained).toHaveLength(32);
    expect(sha(JSON.stringify(retained))).toBe(evidence.existing_preservation.sha256);
    const latest = points.find(p => p.observed_at === "2026-06-30T00:00:00Z")!;
    expect(latest.housing_trajectory!.value).toBe(47.7);
    expect(latest.planning_consents!.value).toBe(60);
  });

  it("emits the 28 new observations once, using current-vintage publication metadata", async () => {
    const result = await mhclgHousingAdapter.fetchHistorical!(globalThis.fetch, { from: new Date("2019-01-01"), to: new Date("2022-09-30") });
    const leading = result.observations.filter(o => o.observedAt < firstExisting[o.indicatorId as Indicator]);
    expect(leading).toHaveLength(28);
    expect(new Set(leading.map(o => `${o.indicatorId}|${o.observedAt}`)).size).toBe(28);
    for (const o of leading) {
      expect(o.sourceId).toBe("mhclg");
      expect(o.payloadHash).toMatch(/^hist:[0-9a-f]{64}$/);
      expect(o.releasedAt).toBe("2026-09-24T00:00:00Z");
    }
  });
});
