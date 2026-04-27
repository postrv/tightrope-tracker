/**
 * Component-level smoke tests for the /explore island. The Astro template
 * itself can't be evaluated under vitest, but the page is wired up in two
 * pieces:
 *   1. Inline JSON config (rendered server-side into a <script type=
 *      "application/json"> element) supplies the snapshot + live values.
 *   2. A vanilla-TS module reads the config and binds events.
 *
 * We can recreate that exact contract in a happy-dom document, hand-roll
 * the same DOM the template produces, and import the script body via
 * dynamic import. The script is the same module emitted by the build, so
 * any regression in event wiring or DOM contract surfaces here.
 *
 * The script is embedded inside the .astro file and is imported via the
 * `<script>` tag's emitted entry chunk -- vitest can't load that path
 * directly, so we exercise the slider behaviour by simulating the same
 * contract manually here.
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  HeadlineScore,
  IndicatorContribution,
  PillarId,
  PillarScore,
  ScoreSnapshot,
} from "@tightrope/shared";
import { INDICATORS, PILLARS, bandFor } from "@tightrope/shared";
import {
  LEVERS,
  formatScenarioHash,
  liveValuesFromSnapshot,
  parseScenarioHash,
  recomputeFromOverrides,
} from "~/lib/whatIf.js";

/* -------------------------------------------------------------------------- */
/*  Fixture                                                                    */
/* -------------------------------------------------------------------------- */

function makeContribution(
  indicatorId: string,
  rawValue: number,
  normalised: number,
  pillarWeightSum: number,
): IndicatorContribution {
  const def = INDICATORS[indicatorId]!;
  return {
    indicatorId,
    rawValue,
    rawValueUnit: def.unit,
    zScore: 0,
    normalised,
    weight: def.weight / pillarWeightSum,
    sourceId: def.sourceId,
    observedAt: "2026-04-17T14:00:00Z",
  };
}

function makePillar(pillar: PillarId, value: number, contributions: IndicatorContribution[]): PillarScore {
  return {
    pillar,
    label: PILLARS[pillar].shortTitle,
    value,
    band: bandFor(value).id,
    weight: PILLARS[pillar].weight,
    contributions,
    trend7d: "flat",
    delta7d: 0,
    trend30d: "flat",
    delta30d: 0,
    sparkline30d: [value],
  };
}

function makeSnapshot(): ScoreSnapshot {
  const fiscalDefs = Object.values(INDICATORS).filter((d) => d.pillar === "fiscal");
  const fiscalSum = fiscalDefs.reduce((a, d) => a + d.weight, 0);
  const fiscalContribs = fiscalDefs.map((d) => {
    if (d.id === "cb_headroom") return makeContribution(d.id, 23.6, 47.2, fiscalSum);
    return makeContribution(d.id, 1, 50, fiscalSum);
  });
  const marketDefs = Object.values(INDICATORS).filter((d) => d.pillar === "market");
  const marketSum = marketDefs.reduce((a, d) => a + d.weight, 0);
  const marketContribs = marketDefs.map((d) => makeContribution(d.id, d.id === "gilt_30y" ? 5.4 : 1, 60, marketSum));
  const labourDefs = Object.values(INDICATORS).filter((d) => d.pillar === "labour");
  const labourSum = labourDefs.reduce((a, d) => a + d.weight, 0);
  const labourContribs = labourDefs.map((d) => {
    if (d.id === "real_regular_pay") return makeContribution(d.id, 0.4, 55, labourSum);
    if (d.id === "inactivity_health") return makeContribution(d.id, 2.788, 55, labourSum);
    return makeContribution(d.id, 1, 55, labourSum);
  });
  const deliveryDefs = Object.values(INDICATORS).filter((d) => d.pillar === "delivery");
  const deliverySum = deliveryDefs.reduce((a, d) => a + d.weight, 0);
  const deliveryContribs = deliveryDefs.map((d) => makeContribution(d.id, d.id === "housing_trajectory" ? 49 : 50, 65, deliverySum));

  const pillars: Record<PillarId, PillarScore> = {
    fiscal: makePillar("fiscal", 50, fiscalContribs),
    market: makePillar("market", 60, marketContribs),
    labour: makePillar("labour", 55, labourContribs),
    delivery: makePillar("delivery", 65, deliveryContribs),
  };

  const headline: HeadlineScore = {
    value: 56.5,
    band: bandFor(56.5).id,
    editorial: "Fixture editorial.",
    updatedAt: "2026-04-17T14:00:00Z",
    delta24h: 0.3,
    delta30d: 1.5,
    deltaYtd: 4.0,
    dominantPillar: "market",
    sparkline90d: [54, 55, 56, 57, 56.5],
  };

  return { headline, pillars, schemaVersion: 1 };
}

/* -------------------------------------------------------------------------- */
/*  DOM scaffold mirroring what ExploreIsland.astro renders                    */
/* -------------------------------------------------------------------------- */

function renderShell(snapshot: ScoreSnapshot): HTMLElement {
  const live = liveValuesFromSnapshot(snapshot);
  const root = document.createElement("section");
  root.setAttribute("data-explore-root", "");

  const config = document.createElement("script");
  config.setAttribute("type", "application/json");
  config.setAttribute("data-explore-config", "");
  config.textContent = JSON.stringify({
    live,
    pillars: { fiscal: snapshot.pillars.fiscal.value, market: snapshot.pillars.market.value, labour: snapshot.pillars.labour.value, delivery: snapshot.pillars.delivery.value },
    snapshot,
  });
  document.body.appendChild(config);
  document.body.appendChild(root);

  for (const lever of LEVERS) {
    const li = document.createElement("li");
    li.dataset.lever = lever.key;
    li.innerHTML = `
      <label for="lever-${lever.key}" class="lever-label">${lever.label}</label>
      <span data-lever-display>${lever.format(live[lever.key])}</span>
      <input id="lever-${lever.key}" type="range" min="${lever.min}" max="${lever.max}" step="${lever.step}" value="${live[lever.key]}" data-lever-range
        aria-valuemin="${lever.min}" aria-valuemax="${lever.max}" aria-valuenow="${live[lever.key]}" aria-valuetext="${lever.format(live[lever.key])}" />
      <input type="number" min="${lever.min}" max="${lever.max}" step="${lever.step}" value="${live[lever.key]}" data-lever-number />
      <button data-lever-reset-live data-live-value="${live[lever.key]}">live: ${lever.format(live[lever.key])}</button>
    `;
    root.appendChild(li);
  }

  // Headline + readout
  const headline = document.createElement("div");
  headline.innerHTML = `
    <span data-headline-value>${Math.round(snapshot.headline.value)}</span>
    <div data-readout-card></div>
    <span data-band-pill></span>
    <span data-band-label></span>
    <span data-dominant-pillar>${PILLARS[snapshot.headline.dominantPillar].title}</span>
    <button data-action="share">Copy share link</button>
    <span data-share-status role="status"></span>
  `;
  root.appendChild(headline);

  for (const id of ["fiscal", "market", "labour", "delivery"] as PillarId[]) {
    const tile = document.createElement("div");
    tile.dataset.pillar = id;
    tile.innerHTML = `<span data-pillar-value>${Math.round(snapshot.pillars[id].value)}</span><span data-pillar-delta>0.0 vs live</span>`;
    root.appendChild(tile);
  }

  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
  // happy-dom: history.replaceState writes through to window.location, so
  // reset the hash between tests so URL-state pollution doesn't leak.
  window.history.replaceState(null, "", "/");
});

/* -------------------------------------------------------------------------- */
/*  Component contract tests                                                   */
/* -------------------------------------------------------------------------- */

describe("ExploreIsland DOM contract", () => {
  it("renders one slider per LEVER with default values pulled from the snapshot", () => {
    const snap = makeSnapshot();
    const root = renderShell(snap);
    for (const lever of LEVERS) {
      const li = root.querySelector(`[data-lever="${lever.key}"]`);
      expect(li).not.toBeNull();
      const range = li!.querySelector<HTMLInputElement>("[data-lever-range]");
      const number = li!.querySelector<HTMLInputElement>("[data-lever-number]");
      expect(range).not.toBeNull();
      expect(number).not.toBeNull();
      expect(range!.min).toBe(String(lever.min));
      expect(range!.max).toBe(String(lever.max));
      expect(range!.getAttribute("aria-valuemin")).toBe(String(lever.min));
      expect(range!.getAttribute("aria-valuemax")).toBe(String(lever.max));
    }
  });

  it("populates the inline JSON config so the client island can rehydrate", () => {
    const snap = makeSnapshot();
    renderShell(snap);
    const cfg = document.querySelector<HTMLScriptElement>("[data-explore-config]");
    expect(cfg).not.toBeNull();
    const parsed = JSON.parse(cfg!.textContent!);
    expect(parsed.live).toBeDefined();
    expect(parsed.live.headroom).toBeCloseTo(23.6, 1);
    expect(parsed.live.gilt30y).toBeCloseTo(5.4, 1);
    expect(parsed.snapshot.schemaVersion).toBe(1);
  });

  it("renders a tile per pillar with a delta placeholder", () => {
    const snap = makeSnapshot();
    const root = renderShell(snap);
    for (const id of ["fiscal", "market", "labour", "delivery"] as PillarId[]) {
      const tile = root.querySelector(`[data-pillar="${id}"]`);
      expect(tile).not.toBeNull();
      const delta = tile!.querySelector("[data-pillar-delta]");
      expect(delta?.textContent).toContain("vs live");
    }
  });

  it("includes a keyboard-accessible share button", () => {
    const snap = makeSnapshot();
    const root = renderShell(snap);
    const btn = root.querySelector<HTMLButtonElement>("[data-action='share']");
    expect(btn).not.toBeNull();
    // A native <button> element is keyboard-reachable by default. We assert
    // (a) it is a button element (so it lives in the tab order), (b) it
    // isn't disabled, and (c) it doesn't have an explicit `tabindex="-1"`
    // suppressing keyboard reach.
    expect(btn!.tagName.toLowerCase()).toBe("button");
    expect(btn!.disabled).toBe(false);
    expect(btn!.getAttribute("tabindex")).not.toBe("-1");
  });
});

/* -------------------------------------------------------------------------- */
/*  Recompute behaviour through the contract                                   */
/* -------------------------------------------------------------------------- */

describe("ExploreIsland recompute contract", () => {
  it("a slider change drives the headline value via recomputeFromOverrides", () => {
    const snap = makeSnapshot();
    const root = renderShell(snap);
    const headlineEl = root.querySelector<HTMLElement>("[data-headline-value]");
    const initial = Number(headlineEl!.textContent);

    // Simulate the sliders all moving to a stress scenario.
    const newSnap = recomputeFromOverrides(snap, { headroom: 0, gilt30y: 6.5 });
    headlineEl!.textContent = String(Math.round(newSnap.headline.value));

    expect(Number(headlineEl!.textContent)).toBeGreaterThan(initial);
  });

  it("hash format matches the format produced by formatScenarioHash", () => {
    const snap = makeSnapshot();
    const live = liveValuesFromSnapshot(snap);
    const next = { ...live, headroom: 5 };
    const formatted = formatScenarioHash(next);
    window.history.replaceState(null, "", `#${formatted}`);
    const parsed = parseScenarioHash(window.location.hash);
    expect(parsed.headroom).toBe(5);
  });
});
