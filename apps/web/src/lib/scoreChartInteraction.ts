import type { PillarId, ScoreHistoryPoint } from "@tightrope/shared";
import { nearestPointIndex } from "./scoreChart.js";

interface ChartSample extends ScoreHistoryPoint { x: number; y: number }
interface ChartData { points: ChartSample[]; width: number; padL: number; plotW: number; label?: string }

/** Progressive enhancement: the SVG and latest reading remain useful without JS. */
export function initialiseScoreCharts(root: ParentNode = document): void {
  for (const chart of root.querySelectorAll<HTMLElement>(".annotated-chart, .interactive-score-chart")) {
    if (chart.dataset.scoreReady === "true") continue;
    const dataNode = chart.querySelector(".score-chart-data");
    const slider = chart.querySelector<HTMLInputElement>(".score-scrubber");
    const svg = chart.querySelector<SVGSVGElement>(".chart-svg");
    if (!dataNode || !slider || !svg) continue;
    let data: ChartData;
    try { data = JSON.parse(dataNode.textContent ?? ""); } catch { continue; }
    if (!data.points.length) continue;
    chart.dataset.scoreReady = "true";

    const date = chart.querySelector<HTMLTimeElement>("[data-score-date]");
    const label = chart.querySelector<HTMLElement>("[data-score-position]");
    const crosshair = chart.querySelector<SVGGElement>(".score-crosshair");
    const guide = crosshair?.querySelector("line");
    const dot = crosshair?.querySelector("circle");
    const fields = chart.querySelectorAll<HTMLElement>("[data-score-value]");
    const dateFormat = new Intl.DateTimeFormat("en-GB", {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
    });
    let pinned = false;
    let selected = data.points.length - 1;

    function select(index: number) {
      selected = Math.max(0, Math.min(data.points.length - 1, index));
      const point = data.points[selected]!;
      slider!.value = String(selected);
      const dateText = `${dateFormat.format(new Date(point.timestamp))} UTC`;
      slider!.setAttribute("aria-valuetext", `${dateText}; ${data.label ?? "headline"} ${point.headline.toFixed(1)} out of 100`);
      if (date) { date.dateTime = point.timestamp; date.textContent = dateText; }
      if (label) label.textContent = `${pinned ? "Pinned" : selected === data.points.length - 1 ? "Latest" : "Recorded"} · ${selected + 1} / ${data.points.length}`;
      fields.forEach(field => {
        const id = field.dataset.scoreValue;
        const value = id === "headline" ? point.headline : point.pillars[id as PillarId];
        field.textContent = Number.isFinite(value) ? value.toFixed(1) : "—";
      });
      guide?.setAttribute("x1", String(point.x));
      guide?.setAttribute("x2", String(point.x));
      dot?.setAttribute("cx", String(point.x));
      dot?.setAttribute("cy", String(point.y));
    }
    function eventIndex(event: PointerEvent): number | null {
      const rect = svg!.getBoundingClientRect();
      if (rect.width === 0) return null;
      const x = ((event.clientX - rect.left) / rect.width) * data.width;
      if (x < data.padL || x > data.padL + data.plotW) return null;
      return nearestPointIndex(data.points, (x - data.padL) / data.plotW);
    }
    svg.addEventListener("pointermove", event => {
      if (pinned || event.pointerType === "touch") return;
      const index = eventIndex(event);
      if (index !== null) select(index);
    });
    svg.addEventListener("click", event => {
      if ((event.target as Element).closest(".marker, .event-label")) return;
      const index = eventIndex(event as PointerEvent);
      if (index === null) return;
      pinned = !pinned || selected !== index;
      select(index);
    });
    slider.addEventListener("input", () => { pinned = false; select(Number(slider.value)); });
    chart.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      pinned = false;
      select(data.points.length - 1);
    });
    chart.querySelector("[data-score-reset]")?.addEventListener("click", () => {
      pinned = false;
      select(data.points.length - 1);
    });
    for (const button of chart.querySelectorAll<HTMLButtonElement>("[data-toggle-pillar]")) {
      button.addEventListener("click", () => {
        const visible = button.getAttribute("aria-pressed") !== "true";
        button.setAttribute("aria-pressed", String(visible));
        const line = chart.querySelector<SVGPathElement>(`.pillar-${button.dataset.togglePillar}`);
        if (line) line.style.display = visible ? "" : "none";
      });
    }
    select(selected);
  }
}
