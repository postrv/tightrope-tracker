/**
 * Per-indicator plausibility gates (AUTOMATION_PLAN.md §2.2, Appendix A).
 *
 * `writeObservations` runs every LIVE observation through `checkPlausibility`
 * before it reaches `indicator_observations`. A violating value is NOT
 * written — it is quarantined in `curator_captures` and an alert fires — so a
 * gross error (the denominator-misalignment class from the 2026-04-29 audit,
 * where a raw count leaked in where a percentage belonged) can never silently
 * publish. This is a *safety net*, not a forecast: bounds are set wide, and a
 * quarantine is a "human, please look" signal, not a hard reject — the Phase 3
 * approve endpoint can release a genuinely-correct outlier.
 *
 * Derivation (per entry, cited inline):
 *   - min/max start from the reviewed magnitude ranges in
 *     `seedValues.test.ts::PLAUSIBLE_RANGE` (the repo's existing, unit-checked
 *     bounds), reconciled with Appendix A's explicit ranges for the
 *     sentiment/fiscal indicators, and widened where the 2019→present live
 *     series can plausibly reach.
 *   - maxJumpPerDay is a *rate*: the gate allows `maxJumpPerDay × daysBetween`
 *     between two consecutive observations, so a monthly series' ~30-day gap
 *     scales the allowance up and a same-day spike is caught. Rates are set
 *     from the largest day-over-day move in each indicator's history fixture
 *     ×2, or (for monthly/quarterly series) Appendix A's per-release cap ×2
 *     divided across the release period. Cross-checked against the fixtures in
 *     packages/data-sources/src/fixtures/*-history.json.
 *
 * `plausibility.test.ts` enforces that every indicator has an entry and that
 * every seed value in `CURRENT_SEED_VALUES` clears its own min/max, so the two
 * tables can never silently diverge.
 */

export interface PlausibilityBound {
  /** Hard lower bound. A value below this is quarantined. */
  min: number;
  /** Hard upper bound. A value above this is quarantined. */
  max: number;
  /**
   * Maximum allowed |Δvalue| per day between an observation and the previously
   * published one. Enforced as `maxJumpPerDay × max(1, daysBetween)`, so it
   * scales with the real gap (daily feeds check the raw daily move; a monthly
   * print's ~30-day gap widens the allowance proportionally).
   */
  maxJumpPerDay: number;
}

/** Which bound a value tripped. */
export type PlausibilityBoundKind = "min" | "max" | "maxJumpPerDay";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every indicator in INDICATORS has an entry. Where a series is short or
 * editorial (delivery milestones), bounds are deliberately loose — the note
 * on each such entry says so.
 */
export const PLAUSIBILITY: Record<string, PlausibilityBound> = {
  // --- Market: rates & FX (daily BoE/EODHD feeds) -------------------------
  // gilt yields: seed-test [0,10]; a single day rarely moves >0.3pp, ×2→0.8.
  gilt_10y: { min: 0, max: 10, maxJumpPerDay: 0.8 },
  gilt_30y: { min: 0, max: 10, maxJumpPerDay: 0.8 },
  // GBP/USD: seed-test [0.9,2.0]; biggest daily FX moves ~0.03-0.05, ×2→0.1.
  gbp_usd: { min: 0.9, max: 2.0, maxJumpPerDay: 0.1 },
  // Trade-weighted index ~78; daily moves ~0.5-1.5 index pts, ×2→3.
  gbp_twi: { min: 60, max: 120, maxJumpPerDay: 3 },
  // FTSE 250 ~22k; history (ftse-250-history.json) max daily move ~880, ×2→~2000.
  ftse_250: { min: 5000, max: 40000, maxJumpPerDay: 2000 },
  // 5y breakeven: seed-test [0,8]; daily moves like the gilt legs, 0.8.
  breakeven_5y: { min: 0, max: 8, maxJumpPerDay: 0.8 },
  // Brent in GBP ~65; history (brent-history.json) max daily move ~13.6, ×2→27.
  brent_gbp: { min: 20, max: 200, maxJumpPerDay: 27 },
  // Housebuilder composite ~63 (rebased 100=2019); a few % per day, allow ~15.
  housebuilder_idx: { min: 30, max: 200, maxJumpPerDay: 15 },
  // --- Market: sentiment (monthly fixtures; Appendix A ranges) ------------
  // Appendix A 35-70/Δ≤8; widened to 30-72 so a deep-recession print isn't
  // clipped (still quarantines a COVID-style sub-30 crash for a human look).
  // History (services-pmi-history.json) max monthly move 3.5; 8/30×2≈0.6.
  services_pmi: { min: 30, max: 72, maxJumpPerDay: 0.6 },
  // Appendix A −55–10/Δ≤10; GfK is almost always negative, widened low to −60.
  // History max monthly move 7; 10/30×2≈0.7.
  consumer_confidence: { min: -60, max: 10, maxJumpPerDay: 0.7 },
  // Appendix A −80–80/Δ≤25; widened to ±90 (RICS balance reaches extremes).
  // History max monthly move 20; 25/30×2≈1.7.
  rics_price_balance: { min: -90, max: 90, maxJumpPerDay: 1.7 },

  // --- Fiscal -------------------------------------------------------------
  // Appendix A headroom −20–60 £bn; widened to [-30,80]. Event cadence
  // (biannual EFO); a real vintage step ~14 over ~180d → 0.5/day is generous.
  cb_headroom: { min: -30, max: 80, maxJumpPerDay: 0.5 },
  // pp of GDP, small; seed-test [-5,5]. Vintage steps are sub-pp; 0.05/day.
  psnfl_trajectory: { min: -5, max: 5, maxJumpPerDay: 0.05 },
  // Monthly PSNB £bn; seed-test [-40,40]. Very seasonal (Jan surplus); a
  // month-to-month swing can be ~30 over 30d → 2.0/day covers it.
  borrowing_outturn: { min: -40, max: 40, maxJumpPerDay: 2.0 },
  // Monthly debt interest £bn; seed-test [0,15], widened to 25 (RPI-linked
  // months spiked ~£20bn in 2022). Monthly swing a few £bn → 1.0/day.
  debt_interest: { min: 0, max: 25, maxJumpPerDay: 1.0 },
  // DMO stock shares (daily snapshot); seed-test [0,40] / [10,60]. Stock
  // composition barely moves day-to-day; 1.0/day is loose but a scale error
  // (e.g. fraction vs %) still trips over the multi-day gaps that occur.
  ilg_share: { min: 0, max: 40, maxJumpPerDay: 1.0 },
  issuance_long_share: { min: 10, max: 60, maxJumpPerDay: 1.0 },

  // --- Labour (monthly ONS/BoE) -------------------------------------------
  // seed-test ranges; monthly moves are sub-pp so per-day rates are small
  // (the ~30-day gap scales the allowance up at check time).
  inactivity_rate: { min: 15, max: 30, maxJumpPerDay: 0.05 },
  inactivity_health: { min: 1, max: 5, maxJumpPerDay: 0.03 },
  unemployment: { min: 2, max: 12, maxJumpPerDay: 0.05 }, // seed-test hi 10, widened for a recession
  vacancies_per_unemployed: { min: 0.1, max: 3.0, maxJumpPerDay: 0.03 },
  // AWE regular-pay index ~232 (NOT a MoM %); seed-test [50,500]. Index rises
  // ~1-2/month → 0.3/day (30d allowance ~9).
  payroll_mom: { min: 50, max: 500, maxJumpPerDay: 0.3 },
  // Real pay YoY %; seed-test [-10,15], widened low to −12 (2022 trough ~−4).
  real_regular_pay: { min: -12, max: 15, maxJumpPerDay: 0.15 },
  // BoE 2y-fix effective rate; seed-test [0.5,12]. Monthly moves ~0.1-0.3 →
  // 0.06/day (30d allowance ~1.8).
  mortgage_2y_fix: { min: 0.5, max: 12, maxJumpPerDay: 0.06 },
  // Appendix A 0.3-3.0%/Δ≤0.4; widened to [0,5] (the seed 0.88 and the
  // history fixture 2.1-2.6 disagree on level, so keep it loose). 0.4/30×2≈0.05.
  dd_failure_rate: { min: 0, max: 5, maxJumpPerDay: 0.05 },

  // --- Delivery (quarterly MHCLG + editorial) -----------------------------
  // % of trajectory / baseline; seed-test [0,150] / [0,200]. Appendix A
  // Δ≤30% per quarterly release → 30/92×2≈0.7. planning_consents' baseline is
  // an estimate so its max is loose (raw counts ~6700 still trip it).
  housing_trajectory: { min: 0, max: 150, maxJumpPerDay: 0.7 },
  planning_consents: { min: 0, max: 200, maxJumpPerDay: 1.0 },
  // Editorial milestone %s (0-100 by construction). LOOSE maxJumpPerDay: an
  // editorial reassessment can legitimately jump a milestone score a long way
  // between quarterly reviews, so the day-rate is generous (the min/max is the
  // real guard here). Documented loose.
  new_towns_milestones: { min: 0, max: 100, maxJumpPerDay: 2.0 },
  bics_rollout: { min: 0, max: 100, maxJumpPerDay: 2.0 },
  industrial_strategy: { min: 0, max: 100, maxJumpPerDay: 2.0 },
  smr_programme: { min: 0, max: 100, maxJumpPerDay: 2.0 },
};

export interface PlausibilityCheckInput {
  indicatorId: string;
  value: number;
  /** ISO-8601 reference period of this observation. */
  observedAt: string;
  /** The latest already-published observation for this indicator, if any. */
  previous?: { value: number; observedAt: string };
}

export interface PlausibilityResult {
  ok: boolean;
  /** Set when `ok` is false: which bound was tripped. */
  bound?: PlausibilityBoundKind;
  /** Human-readable reason, safe to log / put in an alert. */
  detail?: string;
  /** The bound that was applied (for the verification record). */
  applied?: PlausibilityBound;
}

/**
 * Gate one observation. Fail-open only for an *unconfigured* indicator (a
 * config gap must never block a write); everything else with an entry is
 * checked. Non-finite values are treated as a max violation. The jump check
 * is skipped when there is no previous observation, and fails open on an
 * unparseable timestamp (we can't compute a rate we can't date).
 */
export function checkPlausibility(input: PlausibilityCheckInput): PlausibilityResult {
  const bound = PLAUSIBILITY[input.indicatorId];
  if (!bound) return { ok: true };
  const v = input.value;
  if (!Number.isFinite(v)) {
    return { ok: false, bound: "max", detail: `value ${v} is not finite`, applied: bound };
  }
  if (v < bound.min) {
    return { ok: false, bound: "min", detail: `value ${v} < min ${bound.min}`, applied: bound };
  }
  if (v > bound.max) {
    return { ok: false, bound: "max", detail: `value ${v} > max ${bound.max}`, applied: bound };
  }
  const prev = input.previous;
  if (prev && Number.isFinite(prev.value)) {
    const prevMs = Date.parse(prev.observedAt);
    const curMs = Date.parse(input.observedAt);
    if (Number.isFinite(prevMs) && Number.isFinite(curMs)) {
      const days = Math.max(1, Math.abs(curMs - prevMs) / DAY_MS);
      const allowed = bound.maxJumpPerDay * days;
      const jump = Math.abs(v - prev.value);
      if (jump > allowed) {
        return {
          ok: false,
          bound: "maxJumpPerDay",
          detail: `|Δ| ${round(jump)} over ${round(days)}d exceeds ${round(allowed)} (max ${bound.maxJumpPerDay}/day)`,
          applied: bound,
        };
      }
    }
  }
  return { ok: true, applied: bound };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
