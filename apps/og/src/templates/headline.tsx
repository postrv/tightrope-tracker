import { h } from "../jsx/jsx-runtime.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";
import type { HeadlineScore } from "@tightrope/shared";
import { BANDS, PILLARS } from "@tightrope/shared";
import { BandChip, BigStat, CardShell, Caption, TOKENS, formatDate } from "./components.js";

/**
 * Headline score card — the primary share image.
 *
 * Layout mirrors the `.og.critical` variant from mockup-share-cards.html:
 * band chip, giant serif score (tinted by band), italic one-liner underneath,
 * mono source footer.
 */
export function HeadlineCard(headline: HeadlineScore): JsxNode {
  const band = BANDS.find((b) => b.id === headline.band) ?? BANDS[2]!;
  // ASCII trend label — the OG fonts (Bricolage / DM Sans / Plex Mono) are Latin
  // subsets and don't ship Geometric Shapes (U+25B2/U+25BC), so Unicode arrows
  // render as tofu in Satori. Keep this as plain ASCII unless we register a
  // symbol-fallback font.
  const trendLabel = headline.delta24h > 0 ? "UP" : headline.delta24h < 0 ? "DOWN" : "FLAT";
  const dominantTitle = PILLARS[headline.dominantPillar].title;
  const editorial =
    headline.editorial ||
    `${dominantTitle} is the biggest drag.`;

  return (
    <CardShell
      variant={bandVariant(band.id)}
      eyebrow="Tightrope Tracker · Headline"
      meta={formatDate(headline.updatedAt)}
      source="tightropetracker.uk"
      footerRight="Live · geometric mean of 4 pillars"
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <BandChip label={`${trendLabel} · ${band.label}`} color={band.hex} />
        <BigStat value={String(Math.round(headline.value))} unit="/100" tint={band.hex} />
        <Caption>
          <span style={{ display: "flex", flexWrap: "wrap" }}>
            <span style={{ marginRight: "8px", color: TOKENS.ink1 }}>Tightrope Score —</span>
            <span style={{ fontStyle: "italic", color: TOKENS.ink1 }}>{band.editorialLabel.toLowerCase()}.</span>
            <span style={{ color: TOKENS.ink1, marginLeft: "8px" }}>{editorial}</span>
          </span>
        </Caption>
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
