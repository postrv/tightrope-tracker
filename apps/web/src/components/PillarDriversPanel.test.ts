/**
 * Tests for PillarDriversPanel.
 *
 * Asserts:
 *   - one card per pillar (4)
 *   - each card shows the pillar value and the correct band label
 *   - 7d and 30d deltas render with the expected sign / arrow class
 *   - the dominant indicator (highest weight × |zScore|) names the driver
 *   - the D1-fallback path (zero zScores) still picks the highest-weighted
 *     indicator instead of returning "no driver"
 */
import { describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { parseHTML } from "linkedom";
import type { PillarId, ScoreSnapshot, IndicatorContribution } from "@tightrope/shared";
import { PILLARS, PILLAR_ORDER } from "@tightrope/shared";
import PillarDriversPanel from "./PillarDriversPanel.astro";

function contribution(indicatorId: string, opts: Partial<IndicatorContribution> = {}): IndicatorContribution {
  return {
    indicatorId,
    rawValue: opts.rawValue ?? 100,
    rawValueUnit: opts.rawValueUnit ?? "",
    zScore: opts.zScore ?? 0,
    normalised: opts.normalised ?? 0,
    weight: opts.weight ?? 0.5,
    sourceId: opts.sourceId ?? "src-x",
    observedAt: opts.observedAt ?? "2026-04-20T12:00:00Z",
  };
}

interface PillarOverride {
  value: number;
  contributions: IndicatorContribution[];
  delta7d?: number;
  delta30d?: number;
}

function makeSnapshot(overrides: Partial<Record<PillarId, PillarOverride>> = {}): ScoreSnapshot {
  // Use real INDICATOR ids per pillar so formatIndicator finds a definition.
  const defaults: Record<PillarId, PillarOverride> = {
    market: { value: 65, contributions: [contribution("gilt_10y", { rawValue: 4.32, weight: 0.6, zScore: 1.2 })] },
    fiscal: { value: 55, contributions: [contribution("fiscal_headroom", { rawValue: 9.4, weight: 0.5 })] },
    labour: { value: 40, contributions: [contribution("inactivity_rate", { rawValue: 21.5, weight: 0.4 })] },
    delivery: { value: 30, contributions: [contribution("housing_starts", { rawValue: 50000, weight: 0.4 })] },
  };
  const pillars = {} as Record<PillarId, ScoreSnapshot["pillars"][PillarId]>;
  for (const id of PILLAR_ORDER) {
    const o = overrides[id] ?? defaults[id];
    pillars[id] = {
      pillar: id,
      label: PILLARS[id].shortTitle,
      value: o.value,
      band: "strained",
      weight: PILLARS[id].weight,
      contributions: o.contributions,
      trend7d: "up",
      delta7d: o.delta7d ?? 1.5,
      trend30d: "up",
      delta30d: o.delta30d ?? 3.2,
      sparkline30d: [],
    };
  }
  return {
    headline: {
      value: 50,
      band: "strained",
      editorial: "",
      updatedAt: "2026-04-20T12:00:00Z",
      delta24h: 0,
      delta30d: 0,
      deltaYtd: 0,
      dominantPillar: "market",
      sparkline90d: [],
    },
    pillars,
    scoreDirection: "higher_is_better",
    schemaVersion: 2,
  };
}

async function render(snapshot: ScoreSnapshot): Promise<Document> {
  const container = await AstroContainer.create();
  const html = await container.renderToString(PillarDriversPanel, { props: { snapshot } });
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return document;
}

describe("PillarDriversPanel", () => {
  it("renders one card per pillar in canonical order", async () => {
    const doc = await render(makeSnapshot());
    const cards = doc.querySelectorAll("article.driver-card");
    expect(cards.length).toBe(4);
    const order = Array.from(cards).map((c) => c.getAttribute("data-pillar"));
    expect(order).toEqual(["market", "fiscal", "labour", "delivery"]);
  });

  it("shows the pillar value, weight and band label on each card", async () => {
    const doc = await render(makeSnapshot());
    const market = doc.querySelector('article.driver-card[data-pillar="market"]');
    expect(market).not.toBeNull();
    const text = market!.textContent ?? "";
    expect(text).toMatch(/40%/); // market weight
    expect(text).toMatch(/65/);  // value
    expect(text).toMatch(/Strained/i);
  });

  it("emits 7d and 30d delta rows with arrow classes matching the sign", async () => {
    const snapshot = makeSnapshot({
      market: { value: 65, contributions: [contribution("gilt_10y", { weight: 1, zScore: 1 })], delta7d: -1.2, delta30d: 4.0 },
    });
    const doc = await render(snapshot);
    const market = doc.querySelector('article.driver-card[data-pillar="market"]')!;
    const deltas = market.querySelectorAll("li .delta");
    expect(deltas.length).toBe(2);
    // 7d is negative → "dn"; 30d positive → "up".
    expect(deltas[0]?.className).toMatch(/\bdn\b/);
    expect(deltas[1]?.className).toMatch(/\bup\b/);
  });

  it("names the dominant indicator (highest weight × |zScore|) as the driver", async () => {
    const snapshot = makeSnapshot({
      market: {
        value: 65,
        contributions: [
          // gilt_10y label = "10-year gilt yield"; weight×|z| = 0.15
          contribution("gilt_10y", { rawValue: 4.32, weight: 0.3, zScore: 0.5 }),
          // gbp_usd label contains "GBP"; weight×|z| = 0.60 — should win
          contribution("gbp_usd", { rawValue: 1.27, weight: 0.4, zScore: 1.5 }),
          // brent_gbp label contains "Brent"; weight×|z| = 0.06
          contribution("brent_gbp", { rawValue: 70, weight: 0.3, zScore: 0.2 }),
        ],
      },
    });
    const doc = await render(snapshot);
    const market = doc.querySelector('article.driver-card[data-pillar="market"]')!;
    const driverLine = market.querySelector(".driver-line");
    expect(driverLine).not.toBeNull();
    expect(driverLine!.textContent ?? "").toMatch(/GBP|sterling/i);
  });

  it("falls back to the highest-weighted indicator when every zScore is zero (D1 fallback path)", async () => {
    const snapshot = makeSnapshot({
      market: {
        value: 65,
        contributions: [
          contribution("gilt_10y", { weight: 0.2, zScore: 0 }),
          // Highest weight; should win the fallback tie-break.
          contribution("gbp_usd", { rawValue: 1.27, weight: 0.5, zScore: 0 }),
          contribution("brent_gbp", { weight: 0.3, zScore: 0 }),
        ],
      },
    });
    const doc = await render(snapshot);
    const market = doc.querySelector('article.driver-card[data-pillar="market"]')!;
    const driverLine = market.querySelector(".driver-line")?.textContent ?? "";
    expect(driverLine).toMatch(/GBP|sterling/i);
  });

  it("renders an empty-state line when a pillar has no contributions yet", async () => {
    const snapshot = makeSnapshot({
      delivery: { value: 0, contributions: [] },
    });
    const doc = await render(snapshot);
    const delivery = doc.querySelector('article.driver-card[data-pillar="delivery"]')!;
    const line = delivery.querySelector(".driver-line");
    expect(line?.classList.contains("subtle")).toBe(true);
    expect(line?.textContent ?? "").toMatch(/No live indicator readings/);
  });

  it("renders a stale chip when a pillar is flagged stale", async () => {
    const snapshot = makeSnapshot();
    snapshot.pillars.fiscal = { ...snapshot.pillars.fiscal, stale: true };
    const doc = await render(snapshot);
    const fiscal = doc.querySelector('article.driver-card[data-pillar="fiscal"]')!;
    expect(fiscal.querySelector(".stale-chip")).not.toBeNull();
  });
});
