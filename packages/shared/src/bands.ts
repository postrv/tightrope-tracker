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

/** Canonical score bands. Min is inclusive, max is exclusive except the final band. */
export const BANDS: readonly BandDefinition[] = [
  { id: "slack",    label: "Slack",    editorialLabel: "Room to move",       min: 0,  max: 20,  colourToken: "--band-slack",    hex: "#5FB27C" },
  { id: "steady",   label: "Steady",   editorialLabel: "Holding the line",   min: 20, max: 40,  colourToken: "--band-steady",   hex: "#4B9BB0" },
  { id: "strained", label: "Strained", editorialLabel: "Tightening vice",    min: 40, max: 60,  colourToken: "--band-strain",   hex: "#D4A24C" },
  { id: "acute",    label: "Acute",    editorialLabel: "Running out of rope", min: 60, max: 80, colourToken: "--band-acute",    hex: "#D97838" },
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
