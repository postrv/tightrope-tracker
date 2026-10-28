import { beforeEach, describe, expect, it } from "vitest";
import { initialiseScoreCharts } from "../../lib/scoreChartInteraction.js";

function fixture() {
  const data = {
    width: 100, padL: 10, plotW: 80,
    points: [
      { timestamp: "2026-10-01T12:00:00Z", headline: 50.1, pillars: { market: 40, fiscal: 50, labour: 60, delivery: 70 }, x: 10, y: 50 },
      { timestamp: "2026-10-11T12:00:00Z", headline: 42.3, pillars: { market: 31.2, fiscal: 45, labour: 52, delivery: 60 }, x: 90, y: 58 },
    ],
  };
  document.body.innerHTML = `<div class="annotated-chart"><script type="application/json" class="score-chart-data">${JSON.stringify(data)}</script>
    <svg class="chart-svg"><path class="pillar-market"></path><g class="score-crosshair"><line></line><circle></circle></g></svg>
    <time data-score-date></time><span data-score-position></span><span data-score-value="headline"></span><span data-score-value="market"></span>
    <input class="score-scrubber" type="range" min="0" max="1" value="1"><button data-score-reset>Latest</button><button data-toggle-pillar="market" aria-pressed="true">Market</button></div>`;
  initialiseScoreCharts();
}

describe("score history inspection", () => {
  beforeEach(fixture);

  it("updates exact values, timestamp and crosshair together when scrubbing", () => {
    const slider = document.querySelector<HTMLInputElement>("input")!;
    slider.value = "0";
    slider.dispatchEvent(new Event("input"));
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("50.1");
    expect(document.querySelector('[data-score-value="market"]')?.textContent).toBe("40.0");
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-01T12:00:00Z");
    expect(document.querySelector(".score-crosshair circle")?.getAttribute("cx")).toBe("10");
    expect(slider.getAttribute("aria-valuetext")).toContain("headline 50.1");
  });

  it("returns to latest on Escape and can toggle pillar lines", () => {
    const slider = document.querySelector<HTMLInputElement>("input")!;
    slider.value = "0";
    slider.dispatchEvent(new Event("input"));
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(slider.value).toBe("1");
    const toggle = document.querySelector<HTMLButtonElement>("[data-toggle-pillar]")!;
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector<SVGElement>(".pillar-market")?.style.display).toBe("none");
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<SVGElement>(".pillar-market")?.style.display).toBe("");
  });

  it("selects real samples on hover and keeps a clicked recording pinned", () => {
    const svg = document.querySelector<SVGSVGElement>("svg")!;
    svg.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    svg.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, pointerType: "mouse" }));
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("50.1");
    svg.dispatchEvent(new MouseEvent("click", { clientX: 10 }));
    svg.dispatchEvent(new PointerEvent("pointermove", { clientX: 90, pointerType: "mouse" }));
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("50.1");
    expect(document.querySelector("[data-score-position]")?.textContent).toContain("Pinned");
    document.querySelector<HTMLButtonElement>("[data-score-reset]")!.click();
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("42.3");
  });
});
