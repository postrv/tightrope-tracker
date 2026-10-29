import type { PillarId, ScoreHistoryPoint } from "@tightrope/shared";
import { nearestPointIndex, projectScorePoints, scoreLinePath, timeRatio, yForScore, type ScorePlotLayout } from "./scoreChart.js";

interface ChartSample extends ScoreHistoryPoint { x: number; y: number }
interface ChartData { points: ChartSample[]; width: number; padL: number; plotW: number; label?: string; responsive?: ScorePlotLayout; maxGapMs?: number }

/** Reader choices carried across a replacement with fresh server-rendered data. */
export interface ScoreChartState {
  selectedTimestamp: string;
  followingLatest: boolean;
  pinned: boolean;
  pillarVisibility: Partial<Record<PillarId, boolean>>;
  dateInputDraft: string | null;
  eventDetailsOpen: boolean | null;
}

interface ChartController {
  capture(): ScoreChartState;
  restore(state: ScoreChartState): void;
  dispose(): void;
}

const controllers = new WeakMap<HTMLElement, ChartController>();
const CHART_SELECTOR = ".annotated-chart, .interactive-score-chart";

function chartsWithin(root: ParentNode | HTMLElement): HTMLElement[] {
  const charts = Array.from(root.querySelectorAll<HTMLElement>(CHART_SELECTOR));
  if ("matches" in root && typeof root.matches === "function" && root.matches(CHART_SELECTOR)) {
    charts.unshift(root as HTMLElement);
  }
  return charts;
}

/** Capture before disposing/removing a chart; no point indices cross refreshes. */
export function captureScoreChartState(chart: HTMLElement): ScoreChartState | null {
  return controllers.get(chart)?.capture() ?? null;
}

/** Release observers and listeners before replacing a chart or its region. */
export function disposeScoreCharts(root: ParentNode | HTMLElement = document): void {
  for (const chart of chartsWithin(root)) controllers.get(chart)?.dispose();
}

/** Initialise fresh markup if needed, then restore against its actual recordings. */
export function restoreScoreChartState(chart: HTMLElement, state: ScoreChartState): void {
  initialiseScoreCharts(chart);
  controllers.get(chart)?.restore(state);
}

/** Progressive enhancement: the SVG and latest reading remain useful without JS. */
export function initialiseScoreCharts(root: ParentNode | HTMLElement = document): void {
  for (const chart of chartsWithin(root)) {
    // The controller, rather than a copied data attribute, owns the lifecycle.
    if (controllers.has(chart)) continue;
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
    let followingLatest = true;
    let layoutWidth = -1;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    const jump = chart.querySelector<HTMLInputElement>("[data-score-jump]");
    const eventDetails = chart.querySelector<HTMLDetailsElement>("details.event-list");

    function listen<T extends Event>(target: EventTarget, type: string, callback: (event: T) => void, options?: AddEventListenerOptions) {
      const listener = callback as EventListener;
      target.addEventListener(type, listener, options);
      cleanups.push(() => target.removeEventListener(type, listener, options));
    }

    function setPillarVisible(button: HTMLButtonElement, visible: boolean) {
      button.setAttribute("aria-pressed", String(visible));
      const line = chart.querySelector<SVGPathElement>(`.pillar-${button.dataset.togglePillar}`);
      if (line) line.style.display = visible ? "" : "none";
    }

    function resizePlot() {
      if (disposed) return;
      const original = data.responsive;
      if (!original) return;
      const cssWidth = svg!.getBoundingClientRect().width;
      if (!cssWidth || Math.abs(cssWidth - layoutWidth) < .5) return;
      layoutWidth = cssWidth;
      const compact = cssWidth < 600;
      const layout: ScorePlotLayout = compact ? { ...original, width: cssWidth, height: Math.min(300, Math.max(240, original.height * .8)), padL: 36, padR: 12, padT: 16, padB: 34 } : original;
      data.width = layout.width;
      data.padL = layout.padL;
      data.plotW = layout.width - layout.padL - layout.padR;
      data.points = projectScorePoints(data.points, layout);
      svg!.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
      svg!.dataset.compact = String(compact);
      svg!.dataset.labels = String(cssWidth >= 850);
      chart.style.setProperty("--chart-font-scale", String(layout.width / cssWidth));
      const line = scoreLinePath(data.points, data.maxGapMs);
      chart.querySelector(".headline-line")?.setAttribute("d", line);
      const fill = chart.querySelector(".headline-fill");
      if (fill) {
        const bottom = layout.height - layout.padB;
        fill.setAttribute("d", line.includes(" M") ? "" : `${line} L${layout.width - layout.padR},${bottom} L${layout.padL},${bottom} Z`);
      }
      for (const path of chart.querySelectorAll<SVGPathElement>(".pillar-line")) {
        const id = path.dataset.pillar as PillarId;
        const projected = data.points.map(point => ({ ...point, y: yForScore(point.pillars[id], layout) }));
        path.setAttribute("d", scoreLinePath(projected, data.maxGapMs));
      }
      for (const band of chart.querySelectorAll<SVGRectElement>("[data-band-min]")) {
        const top = yForScore(Math.min(100, Number(band.dataset.bandMax)), layout);
        band.setAttribute("x", String(layout.padL)); band.setAttribute("width", String(data.plotW));
        band.setAttribute("y", String(top)); band.setAttribute("height", String(yForScore(Number(band.dataset.bandMin), layout) - top));
      }
      for (const grid of chart.querySelectorAll<SVGLineElement>("line[data-score-tick]")) {
        const y = yForScore(Number(grid.dataset.scoreTick), layout);
        grid.setAttribute("x1", String(layout.padL)); grid.setAttribute("x2", String(layout.width - layout.padR));
        grid.setAttribute("y1", String(y)); grid.setAttribute("y2", String(y));
      }
      for (const tick of chart.querySelectorAll<SVGTextElement>("text[data-score-tick]")) {
        tick.setAttribute("x", String(layout.padL - 8)); tick.setAttribute("y", String(yForScore(Number(tick.dataset.scoreTick), layout) + 4));
      }
      const first = data.points[0]!.timestamp;
      const last = data.points[data.points.length - 1]!.timestamp;
      for (const tick of chart.querySelectorAll<SVGTextElement>("[data-chart-date]")) {
        tick.setAttribute("x", String(layout.padL + timeRatio(tick.dataset.chartDate!, first, last) * data.plotW));
        tick.setAttribute("y", String(layout.height - 9));
      }
      for (const marker of chart.querySelectorAll<SVGGElement>(".marker[data-chart-x]")) {
        const x = layout.padL + Number(marker.dataset.chartX) * data.plotW;
        const y = yForScore(Number(marker.dataset.chartScore), layout);
        for (const circle of marker.querySelectorAll("circle")) { circle.setAttribute("cx", String(x)); circle.setAttribute("cy", String(y)); }
        const guide = marker.querySelector("line");
        guide?.setAttribute("x1", String(x)); guide?.setAttribute("x2", String(x)); guide?.setAttribute("y1", String(y)); guide?.setAttribute("y2", String(layout.height - layout.padB));
      }
      for (const tooltip of chart.querySelectorAll<HTMLElement>(".tooltip[data-chart-x]")) {
        tooltip.style.left = `${((layout.padL + Number(tooltip.dataset.chartX) * data.plotW) / layout.width) * 100}%`;
      }
      guide?.setAttribute("y1", String(layout.padT)); guide?.setAttribute("y2", String(layout.height - layout.padB));
      select(selected, followingLatest);
    }

    function select(index: number, followLatest?: boolean) {
      selected = Math.max(0, Math.min(data.points.length - 1, index));
      followingLatest = followLatest ?? (!pinned && selected === data.points.length - 1);
      const point = data.points[selected]!;
      slider!.value = String(selected);
      const dateText = `${dateFormat.format(new Date(point.timestamp))} UTC`;
      const pillarSummary = ["market", "fiscal", "labour", "delivery"].flatMap(id => Number.isFinite(point.pillars[id as PillarId]) ? [`${id} ${point.pillars[id as PillarId].toFixed(1)}`] : []).join(", ");
      slider!.setAttribute("aria-valuetext", `${dateText}; ${data.label ?? "headline"} ${point.headline.toFixed(1)} out of 100${pillarSummary ? `; ${pillarSummary}` : ""}`);
      if (date) { date.dateTime = point.timestamp; date.textContent = dateText; }
      if (label) label.textContent = `${pinned ? "Pinned" : followingLatest ? "Latest" : "Recorded"} · ${selected + 1} / ${data.points.length}`;
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
    listen<PointerEvent>(svg, "pointermove", event => {
      if (pinned || event.pointerType === "touch") return;
      const index = eventIndex(event);
      if (index !== null) select(index);
    });
    listen<MouseEvent>(svg, "click", event => {
      if ((event.target as Element).closest(".marker, .event-label")) return;
      const index = eventIndex(event as PointerEvent);
      if (index === null) return;
      pinned = !pinned || selected !== index;
      select(index);
    });
    listen(slider, "input", () => { pinned = false; select(Number(slider.value)); });
    const previous = chart.querySelector("[data-score-previous]");
    const next = chart.querySelector("[data-score-next]");
    if (previous) listen(previous, "click", () => { pinned = false; select(selected - 1); });
    if (next) listen(next, "click", () => { pinned = false; select(selected + 1); });
    if (jump) listen(jump, "change", () => {
      const target = Date.parse(`${jump.value}Z`);
      const first = Date.parse(data.points[0]!.timestamp);
      const last = Date.parse(data.points[data.points.length - 1]!.timestamp);
      if (!Number.isFinite(target)) return;
      pinned = true;
      select(nearestPointIndex(data.points, last > first ? (target - first) / (last - first) : .5));
    });
    listen<KeyboardEvent>(chart, "keydown", event => {
      if (event.key !== "Escape") return;
      pinned = false;
      select(data.points.length - 1);
    });
    const reset = chart.querySelector("[data-score-reset]");
    if (reset) listen(reset, "click", () => {
      pinned = false;
      select(data.points.length - 1);
    });
    for (const button of chart.querySelectorAll<HTMLButtonElement>("[data-toggle-pillar]")) {
      listen(button, "click", () => {
        const visible = button.getAttribute("aria-pressed") !== "true";
        setPillarVisible(button, visible);
      });
    }

    controllers.set(chart, {
      capture() {
        const pillarVisibility: ScoreChartState["pillarVisibility"] = {};
        for (const button of chart.querySelectorAll<HTMLButtonElement>("[data-toggle-pillar]")) {
          pillarVisibility[button.dataset.togglePillar as PillarId] = button.getAttribute("aria-pressed") === "true";
        }
        return {
          selectedTimestamp: data.points[selected]!.timestamp,
          followingLatest,
          pinned,
          pillarVisibility,
          dateInputDraft: jump?.value ?? null,
          eventDetailsOpen: eventDetails?.open ?? null,
        };
      },
      restore(state) {
        pinned = !state.followingLatest && state.pinned;
        const first = data.points[0]!.timestamp;
        const last = data.points[data.points.length - 1]!.timestamp;
        const index = !state.followingLatest && Number.isFinite(Date.parse(state.selectedTimestamp))
          ? nearestPointIndex(data.points, timeRatio(state.selectedTimestamp, first, last))
          : data.points.length - 1;
        select(index, state.followingLatest);
        for (const button of chart.querySelectorAll<HTMLButtonElement>("[data-toggle-pillar]")) {
          const visible = state.pillarVisibility[button.dataset.togglePillar as PillarId];
          if (typeof visible === "boolean") setPillarVisible(button, visible);
        }
        if (jump && state.dateInputDraft !== null) jump.value = state.dateInputDraft;
        if (eventDetails && state.eventDetailsOpen !== null) eventDetails.open = state.eventDetailsOpen;
      },
      dispose() {
        disposed = true;
        cleanups.forEach(cleanup => cleanup());
        controllers.delete(chart);
        delete chart.dataset.scoreReady;
      },
    });
    select(selected);
    resizePlot();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(resizePlot);
      observer.observe(chart);
      cleanups.push(() => observer.disconnect());
    } else listen(window, "resize", resizePlot, { passive: true });
  }
}
