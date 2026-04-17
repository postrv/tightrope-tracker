import { h } from "../jsx/jsx-runtime.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";
import { BigStat, CardShell, Caption, TOKENS, formatDate } from "./components.js";

export interface FiscalHeadroomProps {
  /** Headroom in GBP billions. Positive = surplus against stability rule. */
  valueGbpBn: number;
  updatedAt: string;
  /** Short qualitative callout (e.g. "The IFS puts the odds at 1 in 5"). */
  gloss?: string;
}

/**
 * Fiscal Constraint share card (`fiscal-headroom.png`). Uses the accent / brass
 * variant from the mockup.
 */
export function FiscalHeadroomCard(props: FiscalHeadroomProps): JsxNode {
  const { valueGbpBn, updatedAt, gloss } = props;
  const bn = Math.abs(valueGbpBn).toFixed(1);
  const label = gloss ?? "Current-budget headroom against the stability rule.";

  return (
    <CardShell
      variant="accent"
      eyebrow="Tightrope Tracker · Fiscal"
      meta={formatDate(updatedAt)}
      source="Source · OBR Spring Forecast · IFS Green Budget"
      footerRight="2029/30 target year"
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <BigStat value={`£${bn}`} unit="bn" tint={TOKENS.accent} />
        <Caption>{label}</Caption>
      </div>
    </CardShell>
  ) as JsxNode;
}
