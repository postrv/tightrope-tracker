import { beforeEach, describe, expect, it } from "vitest";
import { initialiseScoreCharts } from "../../lib/scoreChartInteraction.js";

function fixture(responsive = false) {
  const data = {
    width: 100, padL: 10, plotW: 80,
    ...(responsive ? { responsive: { width: 880, height: 420, padL: 44, padR: 16, padT: 44, padB: 64 } } : {}),
    points: [
      { timestamp: "2026-10-01T12:00:00Z", headline: 50.1, pillars: { market: 40, fiscal: 50, labour: 60, delivery: 70 }, x: 10, y: 50 },
      { timestamp: "2026-10-11T12:00:00Z", headline: 42.3, pillars: { market: 31.2, fiscal: 45, labour: 52, delivery: 60 }, x: 90, y: 58 },
    ],
  };
  document.body.innerHTML = `<div class="annotated-chart"><script type="application/json" class="score-chart-data">${JSON.stringify(data)}</script>
    <svg class="chart-svg"><path class="headline-line"></path><path class="pillar-line pillar-market" data-pillar="market"></path><line data-score-tick="100"></line><text data-score-tick="100">100</text><g class="score-crosshair"><line></line><circle></circle></g></svg>
    <time data-score-date></time><span data-score-position></span><span data-score-value="headline"></span><span data-score-value="market"></span>
    <input class="score-scrubber" type="range" min="0" max="1" value="1"><button data-score-reset>Latest</button><button data-score-previous>Previous</button><button data-score-next>Next</button><input type="datetime-local" data-score-jump><button data-toggle-pillar="market" aria-pressed="true">Market</button></div>`;
  if (responsive) document.querySelector<SVGSVGElement>("svg")!.getBoundingClientRect = () => ({ left: 0, width: 350 }) as DOMRect;
  initialiseScoreCharts();
}

describe("score history inspection", () => {
  beforeEach(() => fixture());

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

  it("reprojects a narrow chart and keeps axes, line and crosshair on the same scale", () => {
    fixture(true);
    expect(document.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 350 300");
    expect(document.querySelector(".score-crosshair circle")?.getAttribute("cx")).toBe("338");
    expect(document.querySelector("line[data-score-tick]")?.getAttribute("y1")).toBe("16");
    expect(document.querySelector("text[data-score-tick]")?.getAttribute("x")).toBe("28");
    expect(document.querySelector(".headline-line")?.getAttribute("d")).toContain("338.00,160.25");
  });

  it("moves between actual recordings and jumps to the nearest UTC date", () => {
    document.querySelector<HTMLButtonElement>("[data-score-previous]")!.click();
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("50.1");
    document.querySelector<HTMLButtonElement>("[data-score-next]")!.click();
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("42.3");
    const jump = document.querySelector<HTMLInputElement>("[data-score-jump]")!;
    jump.value = "2026-10-02T12:00";
    jump.dispatchEvent(new Event("change"));
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("50.1");
  });
});
