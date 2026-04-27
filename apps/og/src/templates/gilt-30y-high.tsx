import { h } from "../jsx/jsx-runtime.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";
import { BigStat, CardShell, Caption, TOKENS, formatDate } from "./components.js";

export interface Gilt30yProps {
  yieldPct: number;
  updatedAt: string;
}

/**
 * 20-year nominal gilt yield card. Critical variant.
 *
 * The caption is deliberately stripped of editorial claims like "fresh
 * multi-decade high" or peer-country comparisons — those are point-in-time
 * statements that drift faster than the card refreshes. The number itself,
 * sourced from BoE IADB, carries the message.
 */
export function Gilt30yCard(props: Gilt30yProps): JsxNode {
  const { yieldPct, updatedAt } = props;
  return (
    <CardShell
      variant="critical"
      eyebrow="Tightrope Tracker · Market"
      meta={formatDate(updatedAt)}
      source="Source · Bank of England IADB"
      footerRight="Daily close"
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <BigStat value={yieldPct.toFixed(2)} unit="%" tint={TOKENS.bandCritical} />
        <Caption>
          20-year UK nominal gilt yield. The long-end read on UK borrowing costs.
        </Caption>
      </div>
    </CardShell>
  ) as JsxNode;
}
