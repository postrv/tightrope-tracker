export type ScoreBand = "slack" | "steady" | "strained" | "acute" | "critical";

export interface BandDefinition {
  id: ScoreBand;
  label: string;
  editorialLabel: string;
  min: number;
  max: number;
  colourToken: string;
  hex: string;
}

/**
 * Canonical score bands. Min is inclusive, max is exclusive except the final band.
 *
 * Hex values must stay in lockstep with the `--band-*` custom properties in
 * apps/web/src/styles/tokens.css and the `TOKENS.band*` mirror in
 * apps/og/src/templates/components.tsx — consumers (API clients, OG cards,
 * embed charts) pull directly from the hex field.
 */
export const BANDS: readonly BandDefinition[] = [
  { id: "slack",    label: "Slack",    editorialLabel: "Room to move",       min: 0,  max: 20,  colourToken: "--band-slack",    hex: "#5FB27C" },
  { id: "steady",   label: "Steady",   editorialLabel: "Holding the line",   min: 20, max: 40,  colourToken: "--band-steady",   hex: "#79CAC4" },
  { id: "strained", label: "Strained", editorialLabel: "Wire wobbling",      min: 40, max: 60,  colourToken: "--band-strain",   hex: "#EE9944" },
  { id: "acute",    label: "Acute",    editorialLabel: "Running out of rope", min: 60, max: 80, colourToken: "--band-acute",    hex: "#FE5500" },
  { id: "critical", label: "Critical", editorialLabel: "Systemic stress",    min: 80, max: 101, colourToken: "--band-critical", hex: "#C84B3C" },
] as const;

export function bandFor(score: number): BandDefinition {
  const clamped = Math.max(0, Math.min(100, score));
  for (const band of BANDS) {
    if (clamped >= band.min && clamped < band.max) return band;
  }
  // Safety fallback — final band covers 80..100 inclusive.
  return BANDS[BANDS.length - 1]!;
}
