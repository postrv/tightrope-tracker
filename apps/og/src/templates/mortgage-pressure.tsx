import { h } from "../jsx/jsx-runtime.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";
import { BigStat, CardShell, Caption, TOKENS, formatDate } from "./components.js";

export interface MortgagePressureProps {
  /** Monthly payment change on a £250k mortgage since the baseline event (£). Negative = cheaper. */
  extraPerMonth: number;
  /** Current average 2y fix rate %. */
  twoYearFixPct: number;
  /** Spread in basis points vs the baseline rate. Negative = below baseline. */
  spreadBp: number;
  updatedAt: string;
  /** Editorial label for the comparator event, e.g. "Spring Statement 2025". */
  baselineLabel: string;
}

/**
 * Households / mortgage cost card. Variant + tint flex by sign so the card
 * never paints "households are paying less than at the comparator" in alarm
 * orange. Positive delta (more expensive than baseline) → warn (amber glow,
 * acute-orange tint). Negative delta (cheaper than baseline) → good (green
 * glow, slack-green tint). A flat-zero reading falls through to the sober
 * default rather than misrepresenting "no change" as either.
 */
export function MortgagePressureCard(props: MortgagePressureProps): JsxNode {
  const { extraPerMonth, twoYearFixPct, spreadBp, updatedAt, baselineLabel } = props;
  const rounded = Math.round(extraPerMonth);
  // ASCII hyphen-minus only — the Fontsource Latin subsets used by the OG
  // worker may not cover U+2212 MINUS SIGN, which would render as tofu in the
  // serif big stat. "-£100" reads correctly with the loaded fonts.
  const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
  const amount = `${sign}£${Math.abs(rounded)}`;
  const spreadAbs = Math.abs(Math.round(spreadBp));
  const spreadDirection = spreadBp > 0 ? "above" : spreadBp < 0 ? "below" : "level with";
  const variant: "warn" | "good" | "sober" = rounded > 0 ? "warn" : rounded < 0 ? "good" : "sober";
  const tint = rounded > 0 ? TOKENS.bandAcute : rounded < 0 ? TOKENS.bandSlack : TOKENS.ink1;
  return (
    <CardShell
      variant={variant}
      eyebrow="Tightrope Tracker · Households"
      meta={formatDate(updatedAt)}
      source="Source · Bank of England (IUMBV34)"
      footerRight="Effective 2y fixed, 75% LTV"
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <BigStat value={amount} unit="/mo" tint={tint} />
        <Caption>
          Change in the monthly cost of a £250k mortgage since the {baselineLabel}. The effective 2-year fix now averages {twoYearFixPct.toFixed(2)}%, {spreadAbs}bp {spreadDirection} the comparator rate.
        </Caption>
      </div>
    </CardShell>
  ) as JsxNode;
}
