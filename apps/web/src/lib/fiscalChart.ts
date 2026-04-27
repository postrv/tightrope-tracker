/**
 * Y-axis configuration for the OBR-vintage headroom chart in
 * `FiscalSection.astro`. Centralised here so that the data-point projection
 * (`yFor`) and the SVG grid-line + label coordinates can never drift apart
 * — a previous version had `yFor` mapping £0..£40bn over the SVG band but
 * rendered grid lines + labels for £10..£40bn over the same band, so every
 * plotted value sat ~£6bn higher than the axis claimed.
 *
 * Geometry contract (constant; do not adjust without updating the chart):
 *   - viewBox is 0 0 600 240
 *   - data area is y ∈ [40, 220]   (top → bottom)
 *   - axis is £0bn → £40bn         (linear, anchored at the data-area edges)
 *   - one tick per £10bn (5 ticks total: 40, 30, 20, 10, 0)
 *   - the IFS prudent-cushion reference line sits at £10bn
 *
 * The helper exposes both `yFor()` for arbitrary values and `Y_AXIS_TICKS`
 * for the gridline/label render. The tests assert the two stay coupled.
 */

const TOP_Y = 40;
const BOTTOM_Y = 220;
const MIN_BN = 0;
const MAX_BN = 40;
const RANGE_PX = BOTTOM_Y - TOP_Y; // 180
const RANGE_BN = MAX_BN - MIN_BN; // 40

/** Project a £bn value onto the chart's y axis. Linear, no clamping. */
export function yFor(bn: number): number {
  const t = (bn - MIN_BN) / RANGE_BN;
  return BOTTOM_Y - t * RANGE_PX;
}

export interface AxisTick {
  /** £ billion the tick represents. */
  value: number;
  /** y coordinate of the gridline (= yFor(value)). */
  gridY: number;
  /** y coordinate of the text label, sitting 4 SVG units below the gridline. */
  labelY: number;
}

const LABEL_OFFSET = 4;

function tick(value: number): AxisTick {
  const gridY = yFor(value);
  return { value, gridY, labelY: gridY + LABEL_OFFSET };
}

/**
 * Top → bottom. Render order is top-to-bottom in the SVG so the £40 line
 * is drawn first; the array order matches that visual order.
 */
export const Y_AXIS_TICKS: readonly AxisTick[] = [
  tick(40),
  tick(30),
  tick(20),
  tick(10),
  tick(0),
];

/**
 * The IFS-recommended prudent headroom cushion (£10bn). Rendered as a
 * dashed reference line on top of the gridline at the same value.
 */
export const IFS_CUSHION_BN = 10;
export const IFS_CUSHION_Y = yFor(IFS_CUSHION_BN);
