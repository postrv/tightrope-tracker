import { h } from "../jsx/jsx-runtime.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";
import { BigStat, CardShell, Caption, formatDate } from "./components.js";

export interface InactivityCardProps {
  /** Inactivity rate percent of 16-64 population (e.g. 20.7), from ONS LMS. */
  ratePercent: number;
  /** ISO timestamp of the latest LMS observation. */
  updatedAt: string;
}

/**
 * Labour card (`inactivity-9m.png`). Displays the live ONS Labour Market
 * Survey inactivity rate with no editorial claims about peer countries or
 * baselines — those drift, the rate doesn't.
 */
export function InactivityCard(props: InactivityCardProps): JsxNode {
  const rateStr = props.ratePercent.toFixed(1);
  return (
    <CardShell
      variant="sober"
      eyebrow="Tightrope Tracker · Labour"
      meta={formatDate(props.updatedAt)}
      source="Source · ONS Labour Market Survey"
      footerRight="Latest LMS print"
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <BigStat value={rateStr} unit="%" />
        <Caption>
          Economic-inactivity rate, 16–64. The share of working-age people neither in work nor looking for work.
        </Caption>
      </div>
    </CardShell>
  ) as JsxNode;
}
