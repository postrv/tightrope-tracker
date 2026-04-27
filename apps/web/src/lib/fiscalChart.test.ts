/**
 * The Pillar-2 OBR-vintage chart had a coordinate-system bug: `yFor` mapped
 * £0..£40bn linearly over the SVG band [220, 40], but the grid lines and
 * labels were laid out as if the axis ran £10..£40bn over the same band.
 * Result: every plotted vintage rendered ~£6bn higher than the axis
 * implied, and the IFS prudent-cushion reference line at "£10bn" sat at
 * the y coordinate the formula reserved for £6bn. These tests pin the
 * geometry contract so the projection function and the rendered axis
 * cannot drift apart again.
 */
import { describe, expect, it } from "vitest";
import { yFor, Y_AXIS_TICKS, IFS_CUSHION_BN, IFS_CUSHION_Y } from "./fiscalChart.js";

describe("yFor (OBR-vintage chart projection)", () => {
  it("maps the axis bottom (£0bn) to y=220 — the bottom edge of the data area", () => {
    expect(yFor(0)).toBe(220);
  });

  it("maps the axis top (£40bn) to y=40 — the top edge of the data area", () => {
    expect(yFor(40)).toBe(40);
  });

  it("is monotonic decreasing (higher £ → smaller y, since SVG y grows downward)", () => {
    expect(yFor(5)).toBeGreaterThan(yFor(15));
    expect(yFor(15)).toBeGreaterThan(yFor(25));
    expect(yFor(25)).toBeGreaterThan(yFor(40));
  });

  it("is linear: doubling the £ delta doubles the SVG-y delta", () => {
    const d10 = yFor(0) - yFor(10);
    const d20 = yFor(0) - yFor(20);
    expect(d20).toBeCloseTo(2 * d10, 9);
  });

  it("places sub-£10 vintages BELOW the £10 gridline (y > yFor(10)), so the chart honestly shows headroom under the IFS cushion", () => {
    // The four real OBR vintages as of 2026-04: 9.9, 9.9, 22.0, 23.6. Two
    // of those are below £10bn — the previous code's £10..£40 axis would
    // have clamped them to the bottom edge.
    expect(yFor(9.9)).toBeGreaterThan(yFor(10));
    expect(yFor(9.9)).toBeLessThan(220);
  });
});

describe("Y_AXIS_TICKS", () => {
  it("renders five ticks at £0/£10/£20/£30/£40, top-down", () => {
    expect(Y_AXIS_TICKS.map((t) => t.value)).toEqual([40, 30, 20, 10, 0]);
  });

  it("each tick's gridY exactly equals yFor(value) — render and projection cannot drift", () => {
    for (const t of Y_AXIS_TICKS) {
      expect(t.gridY).toBe(yFor(t.value));
    }
  });

  it("ticks are evenly spaced (45 SVG units between successive £10bn lines)", () => {
    for (let i = 1; i < Y_AXIS_TICKS.length; i++) {
      const gap = Y_AXIS_TICKS[i]!.gridY - Y_AXIS_TICKS[i - 1]!.gridY;
      expect(gap).toBeCloseTo(45, 9);
    }
  });

  it("label y sits a few units below the gridline so it doesn't overlap with the line itself", () => {
    for (const t of Y_AXIS_TICKS) {
      expect(t.labelY).toBeGreaterThan(t.gridY);
      expect(t.labelY - t.gridY).toBeLessThanOrEqual(8);
    }
  });
});

describe("IFS prudent-cushion reference line", () => {
  it("is anchored at £10bn", () => {
    expect(IFS_CUSHION_BN).toBe(10);
  });

  it("its y coordinate matches the £10bn gridline exactly — the dashed reference cannot float free of the axis", () => {
    expect(IFS_CUSHION_Y).toBe(yFor(IFS_CUSHION_BN));
    const tenTick = Y_AXIS_TICKS.find((t) => t.value === 10);
    expect(tenTick).toBeDefined();
    expect(IFS_CUSHION_Y).toBe(tenTick!.gridY);
  });
});
