import { h } from "../jsx/jsx-runtime.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";
import { BigStat, CardShell, Caption, TOKENS, formatDate } from "./components.js";

export interface Gilt30yProps {
  yieldPct: number;
  updatedAt: string;
}

/** 30-year gilt yield card. Critical variant — same styling as the headline when stressed. */
export function Gilt30yCard(props: Gilt30yProps): JsxNode {
  const { yieldPct, updatedAt } = props;
  return (
    <CardShell
      variant="critical"
      eyebrow="Tightrope Tracker · Market"
      meta={formatDate(updatedAt)}
      source="Source · DMO · Bank of England"
      footerRight="Intraday close"
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <BigStat value={yieldPct.toFixed(2)} unit="%" tint={TOKENS.bandCritical} />
        <Caption>
          30-year UK gilt yield — a fresh multi-decade high. UK long-end borrowing costs now above both Italy and Greece, despite lower debt-to-GDP.
        </Caption>
      </div>
    </CardShell>
  ) as JsxNode;
}
