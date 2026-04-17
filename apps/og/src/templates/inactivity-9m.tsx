import { h } from "../jsx/jsx-runtime.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";
import { BigStat, CardShell, Caption, formatDate } from "./components.js";

export interface InactivityCardProps {
  /** Inactive people, in millions (e.g. 9.00). */
  valueMillions: number;
  /** Inactivity rate percent (e.g. 20.7). */
  ratePercent: number;
  /** Headroom above 2019 baseline in thousands (e.g. 800). */
  above2019Thousands: number;
  updatedAt: string;
  /** Reporting window label (e.g. "Nov 2025 → Jan 2026"). */
  window: string;
}

/** Labour card (`inactivity-9m.png`). Sober variant, no tint. */
export function InactivityCard(props: InactivityCardProps): JsxNode {
  const valueStr = props.valueMillions.toFixed(2);
  const rateStr = props.ratePercent.toFixed(1);
  const aboveStr = Math.round(props.above2019Thousands).toLocaleString("en-GB");
  return (
    <CardShell
      variant="sober"
      eyebrow="Tightrope Tracker · Labour"
      meta={formatDate(props.updatedAt)}
      source="Source · ONS Labour Market Survey"
      footerRight={props.window}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <BigStat value={valueStr} unit="m" />
        <Caption>
          People economically inactive. {rateStr}% of 16–64s. Still {aboveStr},000 above the 2019 baseline — the only G7 country where this is true.
        </Caption>
      </div>
    </CardShell>
  ) as JsxNode;
}
