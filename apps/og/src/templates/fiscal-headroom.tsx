import { h } from "../jsx/jsx-runtime.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";
import { BigStat, CardShell, Caption, TOKENS, formatDate } from "./components.js";

export interface FiscalHeadroomProps {
  /** Headroom in GBP billions. Positive = surplus against stability rule. */
  valueGbpBn: number;
  /** ISO timestamp the OG card metadata stamps (renders DD.MM.YYYY). */
  updatedAt: string;
  /** OBR target year, e.g. "FY 2029/30". The figure is a forecast for this year. */
  targetYearLabel: string;
  /** OBR vintage label, e.g. "Spring Forecast 2026". */
  vintageLabel: string;
  /** Short qualitative callout (e.g. "The IFS puts the odds at 1 in 5"). */
  gloss?: string;
}

/**
 * Fiscal Room share card (`fiscal-headroom.png`).
 *
 * The headline number is an OBR forecast for the stability-rule target year
 * (currently FY 2029/30) — not a real-time outturn. The eyebrow, caption,
 * and footer all carry that context so the card is not mistaken for "today's
 * headroom" when shared on TV / social.
 */
export function FiscalHeadroomCard(props: FiscalHeadroomProps): JsxNode {
  const { valueGbpBn, updatedAt, targetYearLabel, vintageLabel, gloss } = props;
  const bn = Math.abs(valueGbpBn).toFixed(1);
  const label = gloss ?? `OBR forecast headroom for ${targetYearLabel} against the stability rule.`;

  return (
    <CardShell
      variant="accent"
      eyebrow={`Tightrope Tracker · Fiscal · ${targetYearLabel} forecast`}
      meta={formatDate(updatedAt)}
      source={`Source · OBR ${vintageLabel} · IFS Green Budget`}
      footerRight={`${targetYearLabel} target year (forecast)`}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <BigStat value={`£${bn}`} unit="bn" tint={TOKENS.accent} />
        <Caption>{label}</Caption>
      </div>
    </CardShell>
  ) as JsxNode;
}
