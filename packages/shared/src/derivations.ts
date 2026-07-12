/**
 * Published-indicator derivation formulas.
 *
 * Some indicators are ratios of raw printed statistics rather than figures any
 * upstream release states directly. The formulas were historically prose in
 * packages/data-sources/src/fixtures/housing-history.json (its `methodology`
 * block remains the rationale + primary-source citation record); this module
 * is their single CODE home, shared by:
 *
 *   - apps/curator (derived-indicator capture: the model extracts the raw
 *     printed components, the pipeline computes the published ratio), and
 *   - packages/data-sources' drift-guard test, which asserts the
 *     hand-computed values in housing.json / housing-history.json match
 *     these formulas applied to their stored raw_* components.
 *
 * No rounding here — display formatting (fmtPct(1)) owns presentation, and
 * gates G3/G4 operate on full precision. The hand-maintained fixtures round
 * to 1 dp, so consumers comparing against them use a small tolerance.
 */

/**
 * The 300,000 homes-per-year government target the OBR uses as its housing
 * trajectory working assumption. See housing-history.json → methodology →
 * housing_trajectory (trajectory_source: the long-term plan for housing).
 */
export const HOUSING_TRAJECTORY_ANNUAL_TARGET = 300_000;

/**
 * Estimated 2019 pre-COVID quarterly baseline for residential planning
 * decisions granted. An estimate reconstructed from MHCLG pre-COVID archives
 * (see housing-history.json → methodology → planning_consents) — deliberately
 * loose; revisit if the archived PDFs are ever manually extracted.
 */
export const PLANNING_CONSENTS_QUARTERLY_BASELINE_2019 = 11_500;

/**
 * housing_trajectory: quarterly new-build dwelling completions (seasonally
 * adjusted) annualised (×4), as a percentage of the 300k/yr target.
 * Quarterly completions is the chosen raw series (not annual "net additional
 * dwellings") so every quarter has a primary-source number.
 */
export function deriveHousingTrajectory(completionsSaQuarterly: number): number {
  return (completionsSaQuarterly * 4 / HOUSING_TRAJECTORY_ANNUAL_TARGET) * 100;
}

/**
 * planning_consents: total residential planning decisions granted in the
 * quarter, as a percentage of the 2019 quarterly baseline. Takes the TOTAL —
 * the statistical release prints major and minor decisions as separate
 * figures, so callers extracting components sum them first (the curator's
 * mhclg_housing spec does exactly that), while the history fixtures store the
 * pre-summed total.
 */
export function derivePlanningConsents(residentialDecisionsGrantedQuarterly: number): number {
  return (residentialDecisionsGrantedQuarterly / PLANNING_CONSENTS_QUARTERLY_BASELINE_2019) * 100;
}
