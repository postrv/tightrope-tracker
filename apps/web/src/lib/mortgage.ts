/**
 * Pure helper: compute the extra monthly cost on a £250k, 2-year fix between a
 * baseline rate (e.g. the rate at the last Budget) and the current rate.
 *
 * Uses a standard amortising-mortgage formula over a 25-year term. The result
 * is the delta of monthly payments in whole pounds, rounded.
 */

/**
 * Editorial baseline: the average 2-year fix at the time of the Spring 2024
 * Budget, used to anchor the "since last Budget" mortgage delta. Source:
 * Moneyfacts press release archive, week of 6 March 2024. Update on the next
 * fiscal event that resets the comparator.
 */
export const MORTGAGE_BUDGET_BASELINE_PCT = 5.18;
export const MORTGAGE_BUDGET_BASELINE_LABEL = "Spring 2024 Budget";

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
