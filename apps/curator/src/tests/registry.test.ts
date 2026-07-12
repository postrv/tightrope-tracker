import { describe, expect, it } from "vitest";
import { PLAUSIBILITY } from "@tightrope/shared";
import { CAPTURE_SPECS, effectivePlausibility } from "../sources/registry";
import { CAPTURE_STATUSES, EDITORIAL_KINDS, isEditorialKind } from "../types";

describe("F9 — spec plausibility bounds are DERIVED from the shared table", () => {
  it("every observation spec's effective G3 range === the shared PLAUSIBILITY entry", () => {
    for (const spec of CAPTURE_SPECS) {
      if (spec.kind !== "observation") continue;
      for (const indicatorId of Object.keys(spec.plausibility)) {
        const shared = PLAUSIBILITY[indicatorId];
        expect(shared, `${indicatorId} must have a shared PLAUSIBILITY entry`).toBeDefined();
        const eff = effectivePlausibility(spec, indicatorId);
        expect(eff, `${spec.sourceId}/${indicatorId} must resolve an effective bound`).toBeDefined();
        expect(eff!.min, `${spec.sourceId}/${indicatorId} min`).toBe(shared!.min);
        expect(eff!.max, `${spec.sourceId}/${indicatorId} max`).toBe(shared!.max);
        // maxDelta stays the spec's local value.
        expect(eff!.maxDelta).toBe(spec.plausibility[indicatorId]!.maxDelta);
      }
    }
  });

  it("no spec declares a min/max override today (divergence is structurally impossible)", () => {
    for (const spec of CAPTURE_SPECS) {
      for (const [indicatorId, bound] of Object.entries(spec.plausibility)) {
        expect(bound.min, `${spec.sourceId}/${indicatorId} should not override min`).toBeUndefined();
        expect(bound.max, `${spec.sourceId}/${indicatorId} should not override max`).toBeUndefined();
      }
    }
  });

  it("effectivePlausibility is undefined for an indicator the spec does not gate", () => {
    const spec = CAPTURE_SPECS.find((s) => s.sourceId === "sp_global_pmi")!;
    expect(effectivePlausibility(spec, "gilt_10y")).toBeUndefined();
  });
});

describe("derived-indicator spec invariants", () => {
  it("every derive key is a declared indicator with a registry entry", async () => {
    const { INDICATORS } = await import("@tightrope/shared");
    for (const spec of CAPTURE_SPECS) {
      for (const derivedId of Object.keys(spec.derive ?? {})) {
        expect(spec.indicatorIds, `${spec.sourceId}: derive key ${derivedId} must be declared`).toContain(derivedId);
        expect(INDICATORS[derivedId], `${spec.sourceId}: derive key ${derivedId} must exist in INDICATORS (its unit is taken from there)`).toBeDefined();
      }
    }
  });

  it("component keys are unique and collide with neither indicator ids nor declared ids", async () => {
    const { INDICATORS } = await import("@tightrope/shared");
    for (const spec of CAPTURE_SPECS) {
      const seen = new Set<string>();
      for (const d of Object.values(spec.derive ?? {})) {
        expect(d.components.length, `${spec.sourceId}: derived indicator needs ≥1 component`).toBeGreaterThan(0);
        for (const c of d.components) {
          expect(seen.has(c.key), `${spec.sourceId}: component key ${c.key} duplicated across the spec`).toBe(false);
          seen.add(c.key);
          expect(INDICATORS[c.key], `${spec.sourceId}: component key ${c.key} shadows a registry indicator`).toBeUndefined();
          expect(spec.indicatorIds.includes(c.key), `${spec.sourceId}: component key ${c.key} shadows a declared indicator`).toBe(false);
        }
      }
    }
  });

  it("component bounds are sane and compute() is finite over bound midpoints", () => {
    for (const spec of CAPTURE_SPECS) {
      for (const [derivedId, d] of Object.entries(spec.derive ?? {})) {
        const mid: Record<string, number> = {};
        for (const c of d.components) {
          if (c.min !== undefined && c.max !== undefined) {
            expect(c.min, `${spec.sourceId}: ${derivedId}.${c.key} min<max`).toBeLessThan(c.max);
            mid[c.key] = (c.min + c.max) / 2;
          } else {
            mid[c.key] = 1;
          }
        }
        expect(Number.isFinite(d.compute(mid)), `${spec.sourceId}: ${derivedId}.compute must be finite over midpoints`).toBe(true);
      }
    }
  });
});

describe("F10 / C5 — single source of truth for kinds and statuses", () => {
  it("isEditorialKind matches EDITORIAL_KINDS and excludes observations", () => {
    expect(isEditorialKind("delivery_milestone")).toBe(true);
    expect(isEditorialKind("delivery_commitment")).toBe(true);
    expect(isEditorialKind("timeline_event")).toBe(true);
    expect(isEditorialKind("observation")).toBe(false);
    expect([...EDITORIAL_KINDS].sort()).toEqual(["delivery_commitment", "delivery_milestone", "timeline_event"]);
  });

  it("CAPTURE_STATUSES lists every migration-0011 status exactly once", () => {
    expect(new Set(CAPTURE_STATUSES).size).toBe(CAPTURE_STATUSES.length);
    expect([...CAPTURE_STATUSES].sort()).toEqual(
      ["approved", "auto_published", "pending", "quarantined", "rejected", "shadow", "superseded", "unchanged"],
    );
  });
});
