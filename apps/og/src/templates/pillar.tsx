import { h } from "../jsx/jsx-runtime.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";
import type { PillarId, PillarScore } from "@tightrope/shared";
import { BANDS, PILLARS } from "@tightrope/shared";
import { BandChip, BigStat, CardShell, Caption, formatDate } from "./components.js";

export interface PillarCardProps {
  pillar: PillarId;
  score: PillarScore;
  updatedAt: string;
}

/** Generic per-pillar card used at `/og/pillar/:pillarId.png`. */
export function PillarCard(props: PillarCardProps): JsxNode {
  const def = PILLARS[props.pillar];
  const band = BANDS.find((b) => b.id === props.score.band) ?? BANDS[2]!;
  const trendArrow = props.score.trend7d === "up" ? "▲" : props.score.trend7d === "down" ? "▼" : "▬";
  const variant = bandVariant(band.id);
  const deltaStr = props.score.delta7d > 0 ? `+${props.score.delta7d.toFixed(1)}` : props.score.delta7d.toFixed(1);

  return (
    <CardShell
      variant={variant}
      eyebrow={`Tightrope Tracker · ${def.shortTitle}`}
      meta={formatDate(props.updatedAt)}
      source={`Weight · ${(def.weight * 100).toFixed(0)}% of the headline`}
      footerRight={`${trendArrow} ${deltaStr} on the week`}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <BandChip label={`${trendArrow} ${band.label}`} color={band.hex} />
        <BigStat value={String(Math.round(props.score.value))} unit="/100" tint={band.hex} />
        <Caption>{def.blurb}</Caption>
      </div>
    </CardShell>
  ) as JsxNode;
}

function bandVariant(id: string): "critical" | "accent" | "sober" | "warn" {
  switch (id) {
    case "critical":
    case "acute":
      return "critical";
    case "strained":
      return "warn";
    case "steady":
      return "accent";
    default:
      return "sober";
  }
}
