import { h } from "../jsx/jsx-runtime.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";
import { BigStat, CardShell, Caption, TOKENS, formatDate } from "./components.js";

export interface MortgagePressureProps {
  /** Extra monthly cost on a £250k mortgage since last Budget (£). */
  extraPerMonth: number;
  /** Current average 2y fix rate %. */
  twoYearFixPct: number;
  /** Spread in basis points above the pre-shock baseline. */
  spreadBp: number;
  updatedAt: string;
}

/** Households / mortgage pressure card. Uses the `warn` variant. */
export function MortgagePressureCard(props: MortgagePressureProps): JsxNode {
  const { extraPerMonth, twoYearFixPct, spreadBp, updatedAt } = props;
  const amount = `+£${Math.round(extraPerMonth)}`;
  return (
    <CardShell
      variant="warn"
      eyebrow="Tightrope Tracker · Households"
      meta={formatDate(updatedAt)}
      source="Source · Moneyfacts · Bank of England"
      footerRight="Avg 2y fixed, 75% LTV"
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <BigStat value={amount} unit="/mo" tint={TOKENS.bandAcute} />
        <Caption>
          Extra cost of a £250k mortgage since the last Budget. The 2-year fix now averages {twoYearFixPct.toFixed(2)}%, {Math.round(spreadBp)}bp above the pre-inflation-shock baseline.
        </Caption>
      </div>
    </CardShell>
  ) as JsxNode;
}
