import { INDICATORS } from "@tightrope/shared";

/** Formats an indicator value using its defined `formatDisplay`, falling back to a sane default. */
export function formatIndicator(indicatorId: string, value: number): string {
  const ind = INDICATORS[indicatorId];
  if (!ind) return value.toLocaleString("en-GB");
  return ind.formatDisplay(value);
}

/** Sign-prefixed decimal with a fixed number of places — used in delta rows. */
export function signedDelta(value: number, digits = 1): string {
  if (Number.isNaN(value) || value === 0) return (0).toFixed(digits);
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}`;
}

/** Returns an arrow glyph matching a trend/delta direction. */
export function trendArrow(delta: number, threshold = 0.05): string {
  if (Math.abs(delta) < threshold) return "—";
  return delta > 0 ? "▲" : "▼";
}

/** Returns a CSS class suffix — 'up' | 'dn' | 'flat' — from a delta where positive = worsening. */
export function trendClass(delta: number, threshold = 0.05): "up" | "dn" | "flat" {
  if (Math.abs(delta) < threshold) return "flat";
  return delta > 0 ? "up" : "dn";
}

/**
 * Returns the plain-English semantic of a pressure-score delta — "worse",
 * "better", or "" for sub-threshold (flat) moves.
 *
 * Pressure scores rise when conditions deteriorate, so a positive delta
 * is "worse" and a negative delta is "better". This pair lives next to
 * the arrow so red ▲ / green ▼ has explicit semantic backing — viewers
 * default to "↑ = good" otherwise.
 *
 * Returns the empty string for flat deltas so callers can render
 * `{trendDescriptor(d)}` without conditional wrappers.
 */
export function trendDescriptor(delta: number, threshold = 0.05): "worse" | "better" | "" {
  if (Math.abs(delta) < threshold) return "";
  return delta > 0 ? "worse" : "better";
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Civic eyebrow date: "Fri 17 April 2026". */
export function eyebrowDate(iso: string | Date = new Date()): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Short date for timeline items: "17 April 2026". */
export function longDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Short date for compact contexts: "17 Apr 2026". */
export function shortDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** BST timestamp for footer: "2026-04-17 14:02 BST". Best effort — input is UTC. */
export function bstTimestamp(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm} UTC`;
}

/** Path from an array of numbers to a points-style polyline string (no normalisation). */
export function pathFromSeries(series: readonly number[], width: number, height: number, pad = 1): string {
  if (series.length === 0) return "";
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max === min ? 1 : max - min;
  const xs = series.length === 1 ? [width / 2] : series.map((_, i) => (i / (series.length - 1)) * (width - pad * 2) + pad);
  const ys = series.map((v) => height - pad - ((v - min) / range) * (height - pad * 2));
  return xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${ys[i]!.toFixed(2)}`).join(" ");
}
