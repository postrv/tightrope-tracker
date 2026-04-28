/**
 * Single source of truth for TightropeWalker visualisation parameters.
 *
 * Maps a 0–100 instability score to sway amplitude, sway speed, and the
 * three stability-arc opacities. The Hero computes these once at SSR
 * (its score is fixed); the Explore page also recomputes on every
 * scenario change so the walker leans further or relaxes as sliders
 * move. Both paths must agree on the curve shape, which is why the
 * derivation lives here rather than duplicated.
 *
 * The TightropeWalker inline script duplicates the two threshold values
 * (ARC_AMBER_THRESHOLD, ARC_RED_THRESHOLD) so it can recolour the arc
 * each frame from a runtime-mutable `data-amp`. Keep the constants in
 * sync if they're tuned.
 */

export const MAX_SWAY = 30;
export const ARC_AMBER_THRESHOLD = 9;
export const ARC_RED_THRESHOLD = 18;

export const ARC_GREEN_OPACITY = 0.38;
export const ARC_AMBER_LIT_OPACITY = 0.48;
export const ARC_AMBER_DARK_OPACITY = 0.14;
export const ARC_RED_LIT_OPACITY = 0.5;
export const ARC_RED_DARK_OPACITY = 0.12;

export interface WalkerAnimParams {
  ampDeg: number;
  speedMult: number;
  greenOpacity: number;
  amberOpacity: number;
  redOpacity: number;
}

export function walkerAnimParams(score: number): WalkerAnimParams {
  const safe = Math.max(0, Math.min(100, score));
  const ampDeg = MAX_SWAY * Math.pow(safe / 100, 1.4);
  const speedMult = 1 + Math.pow(safe / 100, 1.5) * 1.8;
  return {
    ampDeg,
    speedMult,
    greenOpacity: ARC_GREEN_OPACITY,
    amberOpacity: ampDeg > ARC_AMBER_THRESHOLD ? ARC_AMBER_LIT_OPACITY : ARC_AMBER_DARK_OPACITY,
    redOpacity: ampDeg > ARC_RED_THRESHOLD ? ARC_RED_LIT_OPACITY : ARC_RED_DARK_OPACITY,
  };
}
