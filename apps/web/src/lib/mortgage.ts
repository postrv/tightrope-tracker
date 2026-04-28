/**
 * Pure helper: compute the extra monthly cost on a £250k, 2-year fix between a
 * baseline rate (e.g. the rate at the last Budget) and the current rate.
 *
 * Uses a standard amortising-mortgage formula over a 25-year term. The result
 * is the delta of monthly payments in whole pounds, rounded.
 */

/**
 * Editorial baseline: the BoE IADB IUMBV34 monthly print for March 2025 (the
 * month of the Spring Statement 2025, 26 March 2025). Anchors the "since the
 * Spring Statement" mortgage delta in the same units the live indicator
 * publishes — effective rate paid on new lending, 75% LTV, 2-year fix.
 *
 * Apples-to-apples is critical: when this site sourced the indicator from
 * Moneyfacts (advertised front-book rates) the baseline was 5.18%; that value
 * is no longer comparable to the live BoE effective-rate series, which runs
 * 30-80bp lower. Update on the next fiscal event that resets the comparator,
 * and only with another IUMBV34 print — never a Moneyfacts/advertised number.
 */
export const MORTGAGE_BUDGET_BASELINE_PCT = 4.54;
export const MORTGAGE_BUDGET_BASELINE_LABEL = "Spring Statement 2025";

export interface MortgageDelta {
  baselineRate: number;
  currentRate: number;
  baselinePayment: number;
  currentPayment: number;
  /** Positive = more expensive than baseline. */
  extraPerMonth: number;
  principal: number;
  termYears: number;
}

export function mortgageDelta(
  baselineRatePct: number,
  currentRatePct: number,
  principal = 250_000,
  termYears = 25,
): MortgageDelta {
  const baseline = monthlyPayment(principal, baselineRatePct, termYears);
  const current = monthlyPayment(principal, currentRatePct, termYears);
  return {
    baselineRate: baselineRatePct,
    currentRate: currentRatePct,
    baselinePayment: Math.round(baseline),
    currentPayment: Math.round(current),
    extraPerMonth: Math.round(current - baseline),
    principal,
    termYears,
  };
}

/**
 * Standard amortisation monthly payment.
 * ratePct is annual percentage (e.g. 5.84 for 5.84%).
 */
function monthlyPayment(principal: number, annualRatePct: number, termYears: number): number {
  const n = termYears * 12;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

/**
 * Pretty string helper: "+£142 a month".
 */
export function formatExtra(value: number): string {
  const sign = value >= 0 ? "+" : "−";
  return `${sign}£${Math.abs(value).toLocaleString("en-GB")}`;
}
