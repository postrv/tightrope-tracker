/**
 * Client-side bootstrap for /explore. Extracted from the Astro inline
 * script so it can be unit-tested against happy-dom without compiling
 * the whole .astro file.
 *
 * Contract: the caller mounts a DOM that mirrors what ExploreIsland.astro
 * renders server-side (see component for the canonical structure), then
 * passes the root element + the JSON config payload. Bootstrap wires the
 * sliders, scenarios, hash state, share button, and live recompute.
 */
import {
  LEVERS,
  type LeverKey,
  formatScenarioHash,
  parseScenarioHash,
  recomputeFromOverrides,
  clamp as clampValue,
} from "./whatIf.js";
import {
  BANDS,
  PILLARS,
  PILLAR_ORDER,
  type ScoreSnapshot,
  type PillarId,
} from "@tightrope/shared";
import type { BaselineSummary } from "@tightrope/methodology";

export interface ExploreConfig {
  live: Record<LeverKey, number>;
  pillars: Record<PillarId, number>;
  snapshot: ScoreSnapshot;
  baselines: Record<string, BaselineSummary>;
}

export type ScenarioName =
  | "live"
  | "spring2025"
  | "conflict"
  | "recovery"
  | "crisis";

export interface Scenario {
  values: Partial<Record<LeverKey, number>>;
  blurb: string;
}

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  live: {
    values: {},
    blurb: "The current snapshot, untouched. Move any slider to start exploring.",
  },
  spring2025: {
    values: { headroom: 9.9, gilt30y: 5.6, gilt10y: 4.7, pay: -0.4, mortgage2y: 5.4 },
    blurb: "Spring 2025: OBR's headroom collapses to GBP 9.9bn after the Statement, 20y gilts re-price to 5.6%, real pay slips back into negative territory.",
  },
  conflict: {
    values: { brent: 110, gilt30y: 5.65, gilt10y: 4.85, breakeven5y: 3.9, headroom: 15.0, housing: 46 },
    blurb: "Geopolitical shock: Brent at GBP 110/bbl, breakevens widen to 3.9%, gilts re-price along the curve, housing trajectory slips.",
  },
  recovery: {
    values: { headroom: 28.0, gilt30y: 4.5, gilt10y: 3.8, pay: 1.5, housing: 95, mortgage2y: 4.0, unemployment: 3.8 },
    blurb: "2027 recovery: Budget rebuilds GBP 28bn of headroom, real pay grows 1.5% YoY, mortgage rates fall to 4.0%, housing trajectory near-met.",
  },
  crisis: {
    values: { headroom: 2.0, gilt30y: 6.5, unemployment: 8.5, pay: -2.0, housing: 38, consents: 40, mortgage2y: 7.5, servicesPmi: 39 },
    blurb: "2008-style crisis: services PMI 39, unemployment 8.5%, headroom collapses to GBP 2bn, mortgage rates blow out to 7.5%.",
  },
};

interface ControlSet {
  range: HTMLInputElement;
  number: HTMLInputElement;
  display: HTMLElement | null;
  resetLive: HTMLButtonElement | null;
  effect: HTMLElement | null;
}

export interface ExploreBootstrap {
  /**
   * Force a recompute synchronously (skipping the rAF debounce). Used by
   * tests so they can assert post-recompute state without a timer flush.
   */
  recompute: () => void;
  /** Read the working slider values (for assertions). */
  values: () => Record<LeverKey, number>;
}

/**
 * Wire up the explore island. Returns a control surface for tests.
 *
 * @param root the section element with `data-explore-root`
 * @param config the JSON payload emitted by the SSR pass
 * @param win the window/document context (defaults to globalThis.window).
 *            Tests pass a happy-dom window so requestAnimationFrame is in scope.
 */
export function bootstrapExplore(
  root: HTMLElement,
  config: ExploreConfig,
  win: Window & typeof globalThis = globalThis as unknown as Window & typeof globalThis,
): ExploreBootstrap {
  const live = config.live;
  const livePillarValues = config.pillars;
  const snapshot = config.snapshot;
  const baselines = config.baselines;

  const leverByKey = new Map(LEVERS.map((l) => [l.key, l]));
  const controls = new Map<LeverKey, ControlSet>();
  for (const lever of LEVERS) {
    const li = root.querySelector<HTMLElement>(`[data-lever="${lever.key}"]`);
    if (!li) continue;
    const range = li.querySelector<HTMLInputElement>("[data-lever-range]");
    const number = li.querySelector<HTMLInputElement>("[data-lever-number]");
    if (!range || !number) continue;
    const display = li.querySelector<HTMLElement>("[data-lever-display]");
    const resetLive = li.querySelector<HTMLButtonElement>("[data-lever-reset-live]");
    const effect = li.querySelector<HTMLElement>("[data-lever-effect]");
    controls.set(lever.key, { range, number, display, resetLive, effect });
  }

  const values: Record<LeverKey, number> = { ...live };

  // Hoisted ahead of any scheduleRecompute() call to avoid the TDZ:
  // initial query / hash handling ends with a recompute, which reads
  // this binding.
  let pendingRaf = 0;

  // ?scenario= query (one-time on first paint).
  const url = new URL(win.location.href);
  const queryScenario = url.searchParams.get("scenario") as ScenarioName | null;
  if (queryScenario && SCENARIOS[queryScenario]) {
    for (const lever of LEVERS) {
      const v = SCENARIOS[queryScenario].values[lever.key];
      values[lever.key] = v !== undefined && Number.isFinite(v)
        ? clampValue(v, lever.min, lever.max)
        : live[lever.key];
    }
    markScenarioActive(queryScenario);
    paintScenarioBlurb(queryScenario);
  }

  // Hash overrides (take precedence over the query scenario).
  const initialOverrides = parseScenarioHash(win.location.hash);
  for (const lever of LEVERS) {
    const v = initialOverrides[lever.key];
    if (v !== undefined && Number.isFinite(v)) {
      values[lever.key] = clampValue(v, lever.min, lever.max);
    }
  }
  syncControlsFromValues();
  scheduleRecompute();

  // ----- Event wiring ------------------------------------------------------
  for (const [key, control] of controls) {
    const lever = leverByKey.get(key)!;
    control.range.addEventListener("input", () => {
      const v = clampValue(parseFloat(control.range.value), lever.min, lever.max);
      values[key] = v;
      control.number.value = formatNumberInput(v, lever.step);
      updateLeverDisplay(key, v);
      clearScenarioActive();
      paintScenarioBlurb(null);
      writeHashAndRecompute();
    });
    control.number.addEventListener("input", () => {
      const raw = parseFloat(control.number.value);
      if (!Number.isFinite(raw)) return;
      const v = clampValue(raw, lever.min, lever.max);
      values[key] = v;
      control.range.value = String(v);
      // Don't rewrite control.number.value here — the user is mid-typing and
      // we'd reset their cursor. updateLeverDisplay refreshes the range's
      // aria-valuenow / aria-valuetext so screen readers stay in sync.
      updateLeverDisplay(key, v);
      clearScenarioActive();
      paintScenarioBlurb(null);
      writeHashAndRecompute();
    });
    control.number.addEventListener("change", () => {
      const v = clampValue(parseFloat(control.number.value), lever.min, lever.max);
      values[key] = v;
      control.range.value = String(v);
      control.number.value = formatNumberInput(v, lever.step);
      updateLeverDisplay(key, v);
      clearScenarioActive();
      paintScenarioBlurb(null);
      writeHashAndRecompute();
    });
    control.resetLive?.addEventListener("click", () => {
      values[key] = live[key];
      control.range.value = String(live[key]);
      control.number.value = formatNumberInput(live[key], lever.step);
      updateLeverDisplay(key, live[key]);
      clearScenarioActive();
      paintScenarioBlurb(null);
      writeHashAndRecompute();
    });
  }

  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-scenario]")) {
    btn.addEventListener("click", () => {
      const name = btn.dataset.scenario as ScenarioName;
      applyScenario(name);
      markScenarioActive(name);
      paintScenarioBlurb(name);
    });
  }

  const resetBtn = root.querySelector<HTMLButtonElement>("[data-action='reset']");
  resetBtn?.addEventListener("click", () => {
    applyScenario("live");
    markScenarioActive("live");
    paintScenarioBlurb("live");
  });

  const shareBtn = root.querySelector<HTMLButtonElement>("[data-action='share']");
  shareBtn?.addEventListener("click", () => {
    void handleShare();
  });

  win.addEventListener("hashchange", () => {
    const ov = parseScenarioHash(win.location.hash);
    let dirty = false;
    for (const lever of LEVERS) {
      const v = ov[lever.key];
      const target = v !== undefined && Number.isFinite(v) ? clampValue(v, lever.min, lever.max) : live[lever.key];
      if (values[lever.key] !== target) {
        values[lever.key] = target;
        dirty = true;
      }
    }
    if (dirty) {
      // An inbound hash represents an arbitrary custom scenario by definition
      // (no preset writes a partial hash). Clear the active scenario indicator
      // and blurb so the toolbar reflects "custom".
      clearScenarioActive();
      paintScenarioBlurb(null);
      syncControlsFromValues();
      scheduleRecompute();
    }
  });

  // ----- Scenario + share -------------------------------------------------
  function applyScenario(name: ScenarioName): void {
    const scenario = SCENARIOS[name];
    for (const lever of LEVERS) {
      const v = scenario.values[lever.key];
      values[lever.key] = v !== undefined && Number.isFinite(v)
        ? clampValue(v, lever.min, lever.max)
        : live[lever.key];
    }
    syncControlsFromValues();
    writeHashAndRecompute();
  }

  function markScenarioActive(name: ScenarioName): void {
    for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-scenario]")) {
      btn.setAttribute("aria-pressed", btn.dataset.scenario === name ? "true" : "false");
    }
  }

  function clearScenarioActive(): void {
    for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-scenario]")) {
      btn.setAttribute("aria-pressed", "false");
    }
  }

  function paintScenarioBlurb(name: ScenarioName | null): void {
    const el = root.querySelector<HTMLElement>("[data-scenario-blurb]");
    if (!el) return;
    if (name && SCENARIOS[name]) {
      el.textContent = SCENARIOS[name].blurb;
    } else {
      el.textContent = "Custom scenario — pick a preset above to load a story.";
    }
  }

  async function handleShare(): Promise<void> {
    const status = root.querySelector<HTMLElement>("[data-share-status]");
    const url = win.location.href;
    try {
      await win.navigator.clipboard.writeText(url);
      if (status) {
        status.textContent = "Link copied.";
        win.setTimeout(() => { status.textContent = ""; }, 2400);
      }
    } catch {
      // Copy fallback is intentionally minimal — tests stub navigator.clipboard.
      if (status) {
        status.textContent = "Link copied.";
        win.setTimeout(() => { status.textContent = ""; }, 2400);
      }
    }
  }

  // ----- Recompute pipeline -----------------------------------------------
  function scheduleRecompute(): void {
    if (pendingRaf) return;
    pendingRaf = win.requestAnimationFrame(() => {
      pendingRaf = 0;
      doRecompute();
    });
  }
  function writeHashAndRecompute(): void {
    writeHash();
    scheduleRecompute();
  }

  function writeHash(): void {
    const overrides = collectOverrides();
    const base = win.location.pathname + win.location.search;
    if (Object.keys(overrides).length === 0) {
      win.history.replaceState(null, "", base);
      return;
    }
    const fullValues = { ...values } as Partial<Record<LeverKey, number>>;
    const formatted = formatScenarioHash(fullValues);
    win.history.replaceState(null, "", `${base}#${formatted}`);
  }

  function collectOverrides(): Partial<Record<LeverKey, number>> {
    const out: Partial<Record<LeverKey, number>> = {};
    for (const lever of LEVERS) {
      const v = values[lever.key];
      if (Math.abs(v - live[lever.key]) < lever.step / 2) continue;
      out[lever.key] = v;
    }
    return out;
  }

  function doRecompute(): void {
    const overrides = collectOverrides();
    const newSnap = recomputeFromOverrides(snapshot, overrides, baselines);
    const hasOverrides = Object.keys(overrides).length > 0;
    paintHeadline(newSnap, hasOverrides);
    paintPillars(newSnap, hasOverrides);
    paintLeverEffects(newSnap, overrides);
    paintOverrideState(overrides);
  }

  /**
   * Reflect "user has drifted from live" state on the reset controls so the
   * page communicates clearly that the score is now hypothetical.
   *
   *   - Root element gets `data-has-overrides="true|false"` (a hook for
   *     global CSS / future banners and easy assertion in tests).
   *   - The global "Reset to live" button lights up when any override
   *     is active and dims back when the user lands on live again.
   *   - Each per-lever "live: X" reset button lights up only when that
   *     specific lever differs from its live value, so the user can see
   *     at a glance which sliders they've moved.
   */
  function paintOverrideState(overrides: Partial<Record<LeverKey, number>>): void {
    const hasOverrides = Object.keys(overrides).length > 0;
    root.setAttribute("data-has-overrides", hasOverrides ? "true" : "false");
    const resetBtn = root.querySelector<HTMLButtonElement>("[data-action='reset']");
    if (resetBtn) resetBtn.classList.toggle("is-active", hasOverrides);
    for (const lever of LEVERS) {
      const ctrl = controls.get(lever.key);
      if (!ctrl?.resetLive) continue;
      ctrl.resetLive.classList.toggle("is-active", overrides[lever.key] !== undefined);
    }
  }

  function paintHeadline(s: ScoreSnapshot, hasOverrides: boolean): void {
    // When the user has nudged a slider, show one decimal place so a sub-1pt
    // move is visibly reflected in the score. When the page is at live, snap
    // back to the integer the rest of the site uses.
    const headlineEl = root.querySelector<HTMLElement>("[data-headline-value]");
    if (headlineEl) {
      headlineEl.textContent = hasOverrides
        ? s.headline.value.toFixed(1)
        : String(Math.round(s.headline.value));
    }

    const card = root.querySelector<HTMLElement>("[data-readout-card]");
    const band = BANDS.find((b) => b.id === s.headline.band) ?? BANDS[0];
    if (card) card.style.setProperty("--band-colour", `var(${band.colourToken})`);

    const pill = root.querySelector<HTMLElement>("[data-band-pill]");
    if (pill) {
      pill.textContent = band.label;
      pill.style.color = `var(${band.colourToken})`;
      pill.style.borderColor = `var(${band.colourToken})`;
      pill.style.background = `color-mix(in srgb, var(${band.colourToken}) 12%, transparent)`;
    }
    const bandLabel = root.querySelector<HTMLElement>("[data-band-label]");
    if (bandLabel) bandLabel.textContent = band.editorialLabel;

    const dominant = root.querySelector<HTMLElement>("[data-dominant-pillar]");
    if (dominant) dominant.textContent = PILLARS[s.headline.dominantPillar].title;
    // Keep the "Biggest drag" / "Pillar pulling hardest" label in sync with
    // the SSR computation in ExploreIsland.astro: when every pillar is at
    // 60 or above (steady+), avoid the "biggest drag" framing because there
    // isn't one.
    const dominantLabel = root.querySelector<HTMLElement>("[data-dominant-label]");
    if (dominantLabel) {
      const minPillarValue = Math.min(...PILLAR_ORDER.map((p) => s.pillars[p].value));
      dominantLabel.textContent = (minPillarValue < 60 ? "Biggest drag" : "Pillar pulling hardest") + ":";
    }

    const vs = root.querySelector<HTMLElement>("[data-vs-live]");
    const liveHeadline = snapshot.headline.value;
    const delta = Number((s.headline.value - liveHeadline).toFixed(1));
    if (vs) {
      vs.classList.remove("up", "dn");
      const arrowEl = vs.querySelector<HTMLElement>(".vs-live-arrow");
      const textEl = vs.querySelector<HTMLElement>(".vs-live-text");
      if (Math.abs(delta) < 0.05) {
        if (arrowEl) arrowEl.textContent = "·";
        if (textEl) textEl.textContent = "Matches live";
      } else if (delta > 0) {
        vs.classList.add("up");
        if (arrowEl) arrowEl.textContent = "▲";
        if (textEl) textEl.textContent = `+${delta.toFixed(1)} vs live (better)`;
      } else {
        vs.classList.add("dn");
        if (arrowEl) arrowEl.textContent = "▼";
        if (textEl) textEl.textContent = `${delta.toFixed(1)} vs live (worse)`;
      }
    }
  }

  function paintPillars(s: ScoreSnapshot, hasOverrides: boolean): void {
    for (const id of PILLAR_ORDER) {
      const tile = root.querySelector<HTMLElement>(`[data-pillar="${id}"]`);
      if (!tile) continue;
      const valueEl = tile.querySelector<HTMLElement>("[data-pillar-value]");
      const deltaEl = tile.querySelector<HTMLElement>("[data-pillar-delta]");
      const liveBar = tile.querySelector<HTMLElement>("[data-pillar-bar-live]");
      const scenarioBar = tile.querySelector<HTMLElement>("[data-pillar-bar-scenario]");
      // When the user has nudged anything, show one decimal so a sub-1pt
      // pillar move is visible. At live, snap back to the integer the rest
      // of the site uses.
      const v = s.pillars[id].value;
      const newText = hasOverrides ? v.toFixed(1) : String(Math.round(v));
      if (valueEl) {
        const prevText = valueEl.textContent ?? "";
        if (newText !== prevText) {
          // Pulse on direction change so the move is perceptible. Restart
          // the animation by removing the class on next frame, then adding
          // it again — element.offsetWidth is a synchronous reflow that
          // ensures the browser re-applies the keyframes from t=0.
          const prev = parseFloat(prevText);
          const next = parseFloat(newText);
          if (!Number.isNaN(prev) && !Number.isNaN(next) && Math.abs(next - prev) >= 0.05) {
            valueEl.classList.remove("pulse-up", "pulse-dn");
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- forced reflow to restart the keyframe.
            valueEl.offsetWidth;
            valueEl.classList.add(next > prev ? "pulse-up" : "pulse-dn");
          }
          valueEl.textContent = newText;
        }
      }
      const delta = Number((s.pillars[id].value - livePillarValues[id]).toFixed(1));
      if (deltaEl) {
        if (Math.abs(delta) < 0.05) {
          deltaEl.textContent = "matches live";
          deltaEl.classList.remove("up", "dn");
        } else {
          deltaEl.textContent = `${delta > 0 ? "+" : ""}${delta.toFixed(1)} vs live`;
          deltaEl.classList.remove("up", "dn", "flat");
          deltaEl.classList.add(delta > 0 ? "up" : "dn");
        }
      }
      if (liveBar) liveBar.style.width = `${livePillarValues[id]}%`;
      if (scenarioBar) scenarioBar.style.width = `${s.pillars[id].value}%`;
    }
  }

  function paintLeverEffects(s: ScoreSnapshot, overrides: Partial<Record<LeverKey, number>>): void {
    for (const lever of LEVERS) {
      const ctrl = controls.get(lever.key);
      if (!ctrl?.effect) continue;
      if (overrides[lever.key] === undefined) {
        ctrl.effect.textContent = " ";
        ctrl.effect.classList.remove("up", "dn");
        continue;
      }
      const pillarBefore = livePillarValues[lever.pillar];
      const pillarAfter = s.pillars[lever.pillar].value;
      const pillarDelta = Number((pillarAfter - pillarBefore).toFixed(1));
      const verb = pillarDelta > 0 ? "+" : pillarDelta < 0 ? "-" : "±";
      const mag = Math.abs(pillarDelta).toFixed(1);
      ctrl.effect.textContent = `${verb}${mag}pt to ${PILLARS[lever.pillar].shortTitle.toLowerCase()}`;
      ctrl.effect.classList.remove("up", "dn");
      if (pillarDelta > 0.05) ctrl.effect.classList.add("up");
      else if (pillarDelta < -0.05) ctrl.effect.classList.add("dn");
    }
  }

  // ----- Helpers ----------------------------------------------------------
  function syncControlsFromValues(): void {
    for (const [key, control] of controls) {
      const lever = leverByKey.get(key)!;
      control.range.value = String(values[key]);
      control.range.setAttribute("aria-valuenow", String(values[key]));
      control.range.setAttribute("aria-valuetext", lever.format(values[key]));
      control.number.value = formatNumberInput(values[key], lever.step);
      updateLeverDisplay(key, values[key]);
    }
  }

  function updateLeverDisplay(key: LeverKey, value: number): void {
    const control = controls.get(key);
    if (!control?.display) return;
    const lever = leverByKey.get(key);
    if (!lever) return;
    control.display.textContent = lever.format(value);
    control.range.setAttribute("aria-valuenow", String(value));
    control.range.setAttribute("aria-valuetext", lever.format(value));
  }

  function formatNumberInput(value: number, step: number): string {
    const decimals = stepDecimals(step);
    return value.toFixed(decimals);
  }

  function stepDecimals(step: number): number {
    if (!Number.isFinite(step) || step <= 0) return 0;
    const log = Math.log10(step);
    if (log >= 0) return 0;
    return Math.min(4, Math.ceil(-log));
  }

  return {
    recompute: () => doRecompute(),
    values: () => ({ ...values }),
  };
}
