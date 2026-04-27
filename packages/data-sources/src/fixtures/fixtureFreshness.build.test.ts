import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;

/**
 * Build-time manifest: every fixture that carries a live-observed value
 * must declare how old it may be before CI fails. This is the last line
 * of defence against a forgotten editorial refresh silently re-emitting
 * a stale reading on every cron tick — the runtime
 * `assertFixtureFresh` guard in a handful of adapters catches the same
 * class of problem at ingest time, but a CI-time guard stops the stale
 * fixture reaching prod at all.
 *
 * Max-ages are sized to the fixture's natural cadence plus a slack so
 * one late editorial refresh doesn't redline CI:
 *
 *   - daily / weekly fixtures: 14 days
 *   - monthly cadence (PMI, RTI, BoE MFS, EIA STEO): 60 days
 *   - quarterly cadence (ONS housing, delivery milestones): 120–180 days
 *   - semi-annual OBR Economic & Fiscal Outlook (Spring, Autumn): 210 days
 */
type FixtureSpec = {
  file: string;
  maxAgeDays: number;
  /** Explain why this fixture is exempt — only set when it's a historical dataset with no "observed_at". */
  skipReason?: string;
};

const MANIFEST: FixtureSpec[] = [
  { file: "brent.json", maxAgeDays: 60 },
  { file: "delivery-milestones.json", maxAgeDays: 120 },
  { file: "ftse-250.json", maxAgeDays: 14 },
  { file: "growth-sentiment.json", maxAgeDays: 60 },
  { file: "housebuilders.json", maxAgeDays: 14 },
  { file: "housing-history.json", maxAgeDays: Infinity, skipReason: "historical backfill dataset with no single observed_at" },
  { file: "housing.json", maxAgeDays: 180 },
  { file: "mortgage.json", maxAgeDays: 60 },
  { file: "obr-efo.json", maxAgeDays: 210 },
  { file: "ons-rti.json", maxAgeDays: 60 },
];

function loadFixture(file: string): Record<string, unknown> {
  const raw = readFileSync(join(HERE, file), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("fixture freshness (build-time guard)", () => {
  const now = Date.now();

  it("covers every fixture JSON file (no silent skips)", () => {
    const declared = new Set(MANIFEST.map((m) => m.file));
    // Import.meta.glob is vite-specific; use a static list to keep the
    // manifest the single source of truth. If a fixture is added, this
    // test will fail until someone adds it to MANIFEST explicitly.
    const known = [
      "brent.json",
      "delivery-milestones.json",
      "ftse-250.json",
      "growth-sentiment.json",
      "housebuilders.json",
      "housing-history.json",
      "housing.json",
      "mortgage.json",
      "obr-efo.json",
      "ons-rti.json",
    ];
    for (const file of known) {
      expect(declared, `MANIFEST missing entry for ${file}`).toContain(file);
    }
  });

  for (const spec of MANIFEST) {
    if (spec.skipReason) {
      it(`${spec.file} is intentionally exempt: ${spec.skipReason}`, () => {
        const data = loadFixture(spec.file);
        expect(data.observed_at).toBeUndefined();
      });
      continue;
    }

    it(`${spec.file} observed_at is within ${spec.maxAgeDays} days`, () => {
      const data = loadFixture(spec.file);
      // Two supported shapes:
      //   - flat: top-level `observed_at` (e.g. brent.json, mortgage.json)
      //   - vintages: `vintages[0].observed_at` (obr-efo.json carries one
      //     entry per OBR publication; the head is the newest vintage and
      //     drives the live `fetch()` path, so freshness applies to it).
      const vintages = data.vintages as Array<{ observed_at?: string }> | undefined;
      const observedAt = Array.isArray(vintages) && vintages.length > 0
        ? vintages[0]!.observed_at
        : (data.observed_at as string | undefined);
      expect(observedAt, `${spec.file} missing observed_at`).toBeTypeOf("string");
      const ts = Date.parse(observedAt as string);
      expect(Number.isFinite(ts), `${spec.file} observed_at not ISO-8601`).toBe(true);
      const ageDays = (now - ts) / DAY_MS;
      // Fail loud. If this fires, the editorial refresh for this
      // fixture is overdue — see docs/RUNBOOK.md §7 for the playbook.
      expect(
        ageDays,
        `${spec.file} is ${ageDays.toFixed(1)} days old (threshold ${spec.maxAgeDays}). Refresh the fixture and update observed_at.`,
      ).toBeLessThanOrEqual(spec.maxAgeDays);
    });
  }
});
