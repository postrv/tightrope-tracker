import { describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { parseHTML } from "linkedom";
import LineChart from "./LineChart.astro";

describe("dated market chart", () => {
  it("keeps missing days to scale and projects scores onto the declared 0–100 axis", async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(LineChart, { props: {
      series: [25, 50, 75], timestamps: ["2026-10-01", "2026-10-02", "2026-10-11"], domain: [0, 100], minLabel: "0", maxLabel: "100",
    } });
    const { document } = parseHTML(html);
    const data = JSON.parse(document.querySelector(".score-chart-data")!.textContent ?? "");
    expect(data.points[1].x).toBe(94); // one day into a ten-day plot
    expect(data.points[1].y).toBe(115); // 50 lies halfway down the 20..210 plot
    expect(document.querySelector(".score-scrubber")?.getAttribute("max")).toBe("2");
    expect(document.querySelector(".line-readout")?.textContent).toContain("75.0");
  });
});
