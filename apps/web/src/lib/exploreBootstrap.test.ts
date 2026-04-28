/**
 * @vitest-environment happy-dom
 *
 * Integration coverage for the /explore client bootstrap.
 *
 * The Astro inline script is a thin shim; this test mounts a DOM that
 * mirrors what the SSR pass would emit, hands it to `bootstrapExplore`,
 * and exercises the real recompute pipeline through user-facing events
 * (slider input, scenario click, hash change). We assert against the
 * DOM the same way a screen reader / browser would observe it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  HeadlineScore,
  IndicatorContribution,
  PillarId,
  PillarScore,
  ScoreSnapshot,
} from "@tightrope/shared";
import { INDICATORS, PILLARS, PILLAR_ORDER, bandFor } from "@tightrope/shared";
import {
  summariseBaseline,
  computeHeadlineScore,
  type BaselineSummary,
} from "@tightrope/methodology";
import {
  bootstrapExplore,
  SCENARIOS,
  type ExploreConfig,
} from "./exploreBootstrap.js";
import { LEVERS, type LeverKey, liveValuesFromSnapshot } from "./whatIf.js";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
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
    sparkline30d: [value, value, value],
  };
}

function makeSnapshot(): ScoreSnapshot {
  // Compact fixture: every indicator gets a plausible raw value.
  const RAW: Record<string, number> = {
    gilt_10y: 4.5, gilt_30y: 5.4, breakeven_5y: 3.4, brent_gbp: 70, services_pmi: 50,
    gbp_usd: 1.27, gbp_twi: 80, ftse_250: 19500, housebuilder_idx: 100,
    consumer_confidence: -20, rics_price_balance: 5,
    cb_headroom: 23.6, psnfl_trajectory: 0.05, borrowing_outturn: 11.0,
    debt_interest: 8.0, ilg_share: 26.0, issuance_long_share: 30.0,
    inactivity_rate: 21.5, inactivity_health: 2.788, unemployment: 4.2,
    vacancies_per_unemployed: 0.7, payroll_mom: 122, real_regular_pay: 0.4,
    mortgage_2y_fix: 4.85, dd_failure_rate: 1.2,
    housing_trajectory: 49, planning_consents: 70, new_towns_milestones: 50,
    bics_rollout: 50, industrial_strategy: 50, smr_programme: 50,
  };

  function buildPillar(pillar: PillarId, defaultNormalised: number, value: number): PillarScore {
    const defs = Object.values(INDICATORS).filter((d) => d.pillar === pillar);
    const sum = defs.reduce((a, d) => a + d.weight, 0);
    const contribs = defs.map((d) =>
      makeContribution(d.id, RAW[d.id] ?? 1, defaultNormalised, sum),
    );
    return makePillar(pillar, value, contribs);
  }

  const pillars: Record<PillarId, PillarScore> = {
    market: buildPillar("market", 60, 60),
    fiscal: buildPillar("fiscal", 50, 50),
    labour: buildPillar("labour", 55, 55),
    delivery: buildPillar("delivery", 65, 65),
  };

  // Derive the headline from the pillars so the fixture is self-consistent.
  // recomputeFromOverrides({}) runs computeHeadlineScore(pillars), so the
  // headline value here must match what that call would produce; otherwise
  // the "Matches live" identity assertion would see a non-zero delta.
  const computed = computeHeadlineScore({
    pillars,
    sparkline90d: [54, 55, 55, 56, 55],
    updatedAt: "2026-04-17T14:00:00Z",
  });
  const headline: HeadlineScore = {
    ...computed,
    editorial: "Live editorial.",
    delta24h: 0.3,
    delta30d: 1.5,
    deltaYtd: 4.0,
  };
  return { headline, pillars, scoreDirection: "higher_is_better", schemaVersion: 2 };
}

function makeBaselines(): Record<string, BaselineSummary> {
  // Synthetic uniform baselines spanning each lever's domain.
  const out: Record<string, BaselineSummary> = {};
  for (const lever of LEVERS) {
    const samples: number[] = [];
    const span = lever.max - lever.min;
    for (let i = 0; i < 200; i++) {
      samples.push(lever.min + (span * i) / 199);
    }
    out[lever.indicatorId] = summariseBaseline(samples);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  DOM scaffolding                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build a DOM that mirrors what ExploreIsland.astro renders server-side.
 * Just enough markup to exercise the bootstrap; the visual styling is
 * not under test here.
 */
function mountFixture(config: ExploreConfig): HTMLElement {
  document.body.innerHTML = "";
  const root = document.createElement("section");
  root.setAttribute("data-explore-root", "");
  root.innerHTML = `
    <div class="scenario-row">
      <button type="button" data-scenario="live" aria-pressed="true">Live now</button>
      <button type="button" data-scenario="spring2025">Spring 2025 crunch</button>
      <button type="button" data-scenario="conflict">Conflict shock</button>
      <button type="button" data-scenario="recovery">Recovery</button>
      <button type="button" data-scenario="crisis">2008-style crisis</button>
      <button type="button" data-action="reset">Reset to live</button>
    </div>
    <p data-scenario-blurb>${SCENARIOS.live.blurb}</p>
    <ul class="lever-list">${LEVERS.map((l) => `
      <li data-lever="${l.key}">
        <span data-lever-display>${l.format(config.live[l.key])}</span>
        <input type="range" data-lever-range min="${l.min}" max="${l.max}" step="${l.step}" value="${config.live[l.key]}" />
        <input type="number" data-lever-number min="${l.min}" max="${l.max}" step="${l.step}" value="${config.live[l.key]}" />
        <button type="button" data-lever-reset-live data-live-value="${config.live[l.key]}">live</button>
        <div data-lever-effect>&nbsp;</div>
      </li>
    `).join("")}</ul>
    <div data-readout-card>
      <span class="score-value" data-headline-value>${Math.round(config.snapshot.headline.value)}</span>
      <span data-band-pill></span>
      <span data-band-label></span>
      <div data-vs-live><span class="vs-live-arrow">·</span><span class="vs-live-text">Matches live</span></div>
    </div>
    <ul class="pillar-tiles">${PILLAR_ORDER.map((id) => `
      <li data-pillar="${id}" data-live-value="${config.snapshot.pillars[id].value.toFixed(1)}">
        <span data-pillar-value>${Math.round(config.snapshot.pillars[id].value)}</span>
        <div class="pillar-tile-bar">
          <span data-pillar-bar-live style="width: ${config.snapshot.pillars[id].value}%"></span>
          <span data-pillar-bar-scenario style="width: ${config.snapshot.pillars[id].value}%"></span>
        </div>
        <span data-pillar-delta>matches live</span>
      </li>
    `).join("")}</ul>
    <span data-dominant-pillar>${PILLARS[config.snapshot.headline.dominantPillar].title}</span>
    <button type="button" data-action="share">Copy share link</button>
    <span data-share-status></span>
  `;
  document.body.appendChild(root);
  return root;
}

function buildConfig(): ExploreConfig {
  const snapshot = makeSnapshot();
  return {
    live: liveValuesFromSnapshot(snapshot),
    pillars: Object.fromEntries(PILLAR_ORDER.map((id) => [id, snapshot.pillars[id].value])) as Record<PillarId, number>,
    snapshot,
    baselines: makeBaselines(),
  };
}

beforeEach(() => {
  // Reset the URL between tests so hash/query state doesn't leak.
  window.history.replaceState(null, "", "/explore");
});

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("bootstrapExplore — initial render", () => {
  it("paints the live headline value and 'Matches live' indicator", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);
    ctrl.recompute();

    const headline = root.querySelector<HTMLElement>("[data-headline-value]")!;
    expect(headline.textContent).toBe(String(Math.round(config.snapshot.headline.value)));

    const vs = root.querySelector<HTMLElement>("[data-vs-live] .vs-live-text")!;
    expect(vs.textContent).toBe("Matches live");
  });

  it("paints 'matches live' on every pillar tile when no override is set", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    bootstrapExplore(root, config, window as unknown as Window & typeof globalThis).recompute();
    for (const id of PILLAR_ORDER) {
      const delta = root.querySelector<HTMLElement>(`[data-pillar="${id}"] [data-pillar-delta]`)!;
      expect(delta.textContent).toBe("matches live");
    }
  });
});

describe("bootstrapExplore — slider interaction", () => {
  it("updates the headline + pillar values when a slider moves", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    // Push gilt_30y to the top of its range -> market score should fall.
    const slider = root.querySelector<HTMLInputElement>('[data-lever="gilt30y"] [data-lever-range]')!;
    slider.value = "7.0";
    slider.dispatchEvent(new Event("input"));
    ctrl.recompute();

    const marketDelta = root.querySelector<HTMLElement>('[data-pillar="market"] [data-pillar-delta]')!;
    expect(marketDelta.textContent).toMatch(/^-/);
    expect(marketDelta.classList.contains("dn")).toBe(true);

    // Headline should move with it.
    const vs = root.querySelector<HTMLElement>("[data-vs-live] .vs-live-text")!;
    expect(vs.textContent).toMatch(/vs live/);
  });

  it("updates the URL hash with the override (slider deviation)", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    const slider = root.querySelector<HTMLInputElement>('[data-lever="headroom"] [data-lever-range]')!;
    slider.value = "5";
    slider.dispatchEvent(new Event("input"));
    ctrl.recompute();

    expect(window.location.hash).toContain("headroom=5");
  });

  it("clears the URL hash when sliders return to live", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    const slider = root.querySelector<HTMLInputElement>('[data-lever="headroom"] [data-lever-range]')!;
    slider.value = "5";
    slider.dispatchEvent(new Event("input"));
    ctrl.recompute();
    expect(window.location.hash).not.toBe("");

    // Reset to live raw value.
    slider.value = String(config.live.headroom);
    slider.dispatchEvent(new Event("input"));
    ctrl.recompute();
    expect(window.location.hash).toBe("");
  });

  it("paints the per-lever effect badge when an override is active", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    const slider = root.querySelector<HTMLInputElement>('[data-lever="headroom"] [data-lever-range]')!;
    slider.value = "0";
    slider.dispatchEvent(new Event("input"));
    ctrl.recompute();

    const effect = root.querySelector<HTMLElement>('[data-lever="headroom"] [data-lever-effect]')!;
    expect(effect.textContent).toMatch(/pt to/);
    expect(effect.classList.contains("up") || effect.classList.contains("dn")).toBe(true);
  });
});

describe("bootstrapExplore — scenario buttons", () => {
  it("applies a scenario's overrides + paints its blurb", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    const conflictBtn = root.querySelector<HTMLButtonElement>('[data-scenario="conflict"]')!;
    conflictBtn.click();
    ctrl.recompute();

    expect(conflictBtn.getAttribute("aria-pressed")).toBe("true");
    const blurb = root.querySelector<HTMLElement>("[data-scenario-blurb]")!;
    expect(blurb.textContent).toBe(SCENARIOS.conflict.blurb);

    // Conflict pushes brent up: the brent slider should now be at 110.
    const brentSlider = root.querySelector<HTMLInputElement>('[data-lever="brent"] [data-lever-range]')!;
    expect(parseFloat(brentSlider.value)).toBe(110);
  });

  it("reset returns every slider to its live raw value", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    // Move a few sliders.
    const headroom = root.querySelector<HTMLInputElement>('[data-lever="headroom"] [data-lever-range]')!;
    headroom.value = "5";
    headroom.dispatchEvent(new Event("input"));

    const reset = root.querySelector<HTMLButtonElement>('[data-action="reset"]')!;
    reset.click();
    ctrl.recompute();

    expect(parseFloat(headroom.value)).toBeCloseTo(config.live.headroom, 5);
    const blurb = root.querySelector<HTMLElement>("[data-scenario-blurb]")!;
    expect(blurb.textContent).toBe(SCENARIOS.live.blurb);
  });

  it("clears the active scenario indicator when a slider is moved manually", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    const conflictBtn = root.querySelector<HTMLButtonElement>('[data-scenario="conflict"]')!;
    conflictBtn.click();
    expect(conflictBtn.getAttribute("aria-pressed")).toBe("true");

    const slider = root.querySelector<HTMLInputElement>('[data-lever="headroom"] [data-lever-range]')!;
    slider.value = "12.3";
    slider.dispatchEvent(new Event("input"));
    ctrl.recompute();

    expect(conflictBtn.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("bootstrapExplore — query and hash sources", () => {
  it("applies a ?scenario= query at startup", () => {
    window.history.replaceState(null, "", "/explore?scenario=recovery");
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);
    ctrl.recompute();

    const recoveryBtn = root.querySelector<HTMLButtonElement>('[data-scenario="recovery"]')!;
    expect(recoveryBtn.getAttribute("aria-pressed")).toBe("true");
    const headroom = root.querySelector<HTMLInputElement>('[data-lever="headroom"] [data-lever-range]')!;
    expect(parseFloat(headroom.value)).toBe(28);
  });

  it("applies hash overrides at startup", () => {
    window.history.replaceState(null, "", "/explore#headroom=12.3&gilt30y=5.7");
    const config = buildConfig();
    const root = mountFixture(config);
    bootstrapExplore(root, config, window as unknown as Window & typeof globalThis).recompute();

    const headroom = root.querySelector<HTMLInputElement>('[data-lever="headroom"] [data-lever-range]')!;
    expect(parseFloat(headroom.value)).toBe(12.3);
    const gilt = root.querySelector<HTMLInputElement>('[data-lever="gilt30y"] [data-lever-range]')!;
    expect(parseFloat(gilt.value)).toBe(5.7);
  });

  it("re-applies values on a hashchange event", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    window.history.replaceState(null, "", "/explore#headroom=4");
    window.dispatchEvent(new Event("hashchange"));
    ctrl.recompute();

    const headroom = root.querySelector<HTMLInputElement>('[data-lever="headroom"] [data-lever-range]')!;
    expect(parseFloat(headroom.value)).toBe(4);
  });
});

describe("bootstrapExplore — override state lights up reset controls", () => {
  it("paints data-has-overrides='false' and unlit reset on initial live render", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    bootstrapExplore(root, config, window as unknown as Window & typeof globalThis).recompute();

    expect(root.getAttribute("data-has-overrides")).toBe("false");
    const resetBtn = root.querySelector<HTMLButtonElement>('[data-action="reset"]')!;
    expect(resetBtn.classList.contains("is-active")).toBe(false);
  });

  it("lights the global reset button when any slider moves and clears it on return to live", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    const slider = root.querySelector<HTMLInputElement>('[data-lever="headroom"] [data-lever-range]')!;
    slider.value = "5";
    slider.dispatchEvent(new Event("input"));
    ctrl.recompute();

    expect(root.getAttribute("data-has-overrides")).toBe("true");
    const resetBtn = root.querySelector<HTMLButtonElement>('[data-action="reset"]')!;
    expect(resetBtn.classList.contains("is-active")).toBe(true);

    // Return the slider to live -> the override clears, the button dims.
    slider.value = String(config.live.headroom);
    slider.dispatchEvent(new Event("input"));
    ctrl.recompute();
    expect(root.getAttribute("data-has-overrides")).toBe("false");
    expect(resetBtn.classList.contains("is-active")).toBe(false);
  });

  it("lights only the per-lever reset button for sliders the user has actually moved", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    const headroom = root.querySelector<HTMLInputElement>('[data-lever="headroom"] [data-lever-range]')!;
    headroom.value = "5";
    headroom.dispatchEvent(new Event("input"));
    ctrl.recompute();

    const headroomReset = root.querySelector<HTMLButtonElement>('[data-lever="headroom"] [data-lever-reset-live]')!;
    const giltReset = root.querySelector<HTMLButtonElement>('[data-lever="gilt30y"] [data-lever-reset-live]')!;
    expect(headroomReset.classList.contains("is-active")).toBe(true);
    expect(giltReset.classList.contains("is-active")).toBe(false);
  });

  it("auto-recomputes the headline value on slider input (rAF flushed)", () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    const headlineEl = root.querySelector<HTMLElement>("[data-headline-value]")!;
    const initial = headlineEl.textContent;

    // Push a high-weight market lever to its top -> headline must move.
    const slider = root.querySelector<HTMLInputElement>('[data-lever="gilt30y"] [data-lever-range]')!;
    slider.value = "7.0";
    slider.dispatchEvent(new Event("input"));
    ctrl.recompute();

    const after = headlineEl.textContent;
    expect(after).not.toBe(initial);
    // And the "vs live" pill reflects a non-zero delta.
    const vs = root.querySelector<HTMLElement>("[data-vs-live]")!;
    expect(vs.classList.contains("up") || vs.classList.contains("dn")).toBe(true);
  });
});

/**
 * Reproduces the user-reported bug: scenario clicks and slider input did not
 * move the displayed headline / pillar scores when the snapshot's pillar
 * `contributions` arrays were empty. This was the case for stale-cache
 * snapshots (and for local dev with seed-only data) -- the recompute path
 * silently returned the original pillar value because there were no
 * contributions to update. After the delta-from-live fallback in `whatIf.ts`,
 * the simulator must react regardless.
 */
describe("bootstrapExplore — empty contributions reactivity", () => {
  function emptyConfig(): ExploreConfig {
    const snap = makeSnapshot();
    // Wipe contributions on every pillar but keep the headline + pillar values.
    const pillars: Record<PillarId, PillarScore> = {
      market: { ...snap.pillars.market, contributions: [] },
      fiscal: { ...snap.pillars.fiscal, contributions: [] },
      labour: { ...snap.pillars.labour, contributions: [] },
      delivery: { ...snap.pillars.delivery, contributions: [] },
    };
    const stripped: ScoreSnapshot = { ...snap, pillars };
    return {
      live: {
        // Without contributions liveValuesFromSnapshot would fall back to
        // slider midpoints; we pass a realistic live map so the test
        // exercises real lever movement and not a midpoint-jumps artefact.
        gilt10y: 4.5, gilt30y: 5.4, breakeven5y: 3.4, brent: 70, servicesPmi: 50,
        headroom: 23.6, psnflDev: 0.05, borrowing: 11.0,
        pay: 0.4, inactivity: 2.788, unemployment: 4.2, mortgage2y: 4.85,
        housing: 49, consents: 70,
      },
      pillars: { market: pillars.market.value, fiscal: pillars.fiscal.value, labour: pillars.labour.value, delivery: pillars.delivery.value },
      snapshot: stripped,
      baselines: makeBaselines(),
    };
  }

  it("auto-recomputes the headline when a slider moves with empty contributions", () => {
    const config = emptyConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);
    const headlineEl = root.querySelector<HTMLElement>("[data-headline-value]")!;
    const initial = headlineEl.textContent;

    const slider = root.querySelector<HTMLInputElement>('[data-lever="gilt30y"] [data-lever-range]')!;
    slider.value = "7.0";
    slider.dispatchEvent(new Event("input"));
    ctrl.recompute();

    expect(headlineEl.textContent).not.toBe(initial);
    const vs = root.querySelector<HTMLElement>("[data-vs-live]")!;
    expect(vs.classList.contains("up") || vs.classList.contains("dn")).toBe(true);
  });

  it("changes scenario→scenario with empty contributions (conflict ≠ recovery)", () => {
    const config = emptyConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);
    const headlineEl = root.querySelector<HTMLElement>("[data-headline-value]")!;

    root.querySelector<HTMLButtonElement>('[data-scenario="conflict"]')!.click();
    ctrl.recompute();
    const conflict = headlineEl.textContent;
    const conflictMarket = root.querySelector<HTMLElement>('[data-pillar="market"] [data-pillar-value]')!.textContent;

    root.querySelector<HTMLButtonElement>('[data-scenario="recovery"]')!.click();
    ctrl.recompute();
    const recovery = headlineEl.textContent;
    const recoveryMarket = root.querySelector<HTMLElement>('[data-pillar="market"] [data-pillar-value]')!.textContent;

    expect(conflict).not.toBe(recovery);
    expect(conflictMarket).not.toBe(recoveryMarket);
  });

  it("paints pillar values with one decimal when overrides are active", () => {
    const config = emptyConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    const slider = root.querySelector<HTMLInputElement>('[data-lever="gilt30y"] [data-lever-range]')!;
    slider.value = "5.5";
    slider.dispatchEvent(new Event("input"));
    ctrl.recompute();

    // Move was small but visible: pillar value should now contain a decimal point.
    const marketValue = root.querySelector<HTMLElement>('[data-pillar="market"] [data-pillar-value]')!.textContent ?? "";
    expect(marketValue).toMatch(/\./);
  });

  it("toggles a pulse-dn class on the pillar value when the score worsens", () => {
    const config = emptyConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    // Re-paint baseline first so pulse logic sees a stable previous value.
    ctrl.recompute();

    const slider = root.querySelector<HTMLInputElement>('[data-lever="gilt30y"] [data-lever-range]')!;
    // Push gilt30y up sharply — market pillar should worsen meaningfully.
    slider.value = "6.5";
    slider.dispatchEvent(new Event("input"));
    ctrl.recompute();

    const valueEl = root.querySelector<HTMLElement>('[data-pillar="market"] [data-pillar-value]')!;
    // The element receives one of the two pulse classes when it changes;
    // worsening (falling score) -> pulse-dn.
    expect(valueEl.classList.contains("pulse-up") || valueEl.classList.contains("pulse-dn")).toBe(true);
    expect(valueEl.classList.contains("pulse-dn")).toBe(true);
  });

  it("does not toggle a pulse class when the value is unchanged", () => {
    const config = emptyConfig();
    const root = mountFixture(config);
    const ctrl = bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    // First recompute paints the initial value with no override; second
    // recompute with no slider movement should not pulse.
    ctrl.recompute();
    const valueEl = root.querySelector<HTMLElement>('[data-pillar="market"] [data-pillar-value]')!;
    valueEl.classList.remove("pulse-up", "pulse-dn");
    ctrl.recompute();
    expect(valueEl.classList.contains("pulse-up")).toBe(false);
    expect(valueEl.classList.contains("pulse-dn")).toBe(false);
  });
});

describe("bootstrapExplore — share button", () => {
  it("copies the URL when share is clicked", async () => {
    const config = buildConfig();
    const root = mountFixture(config);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    bootstrapExplore(root, config, window as unknown as Window & typeof globalThis);

    const shareBtn = root.querySelector<HTMLButtonElement>('[data-action="share"]')!;
    shareBtn.click();
    // Microtask flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(window.location.href);
  });
});
