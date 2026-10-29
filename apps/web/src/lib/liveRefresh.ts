import { captureScoreChartState, disposeScoreCharts, initialiseScoreCharts, restoreScoreChartState } from "./scoreChartInteraction.js";
import { captureChartEventState, disposeChartEvents, initialiseChartEvents, restoreChartEventState } from "./chartEventInteraction.js";

const REGION = "[data-live-region]";
const CHART = ".annotated-chart, .interactive-score-chart";
const STAMP = 'meta[name="live-score-updated-at"]';
const INTERVAL = 60_000;
const signatures = new WeakMap<Element, string>();

function charts(root: HTMLElement): HTMLElement[] {
  return [...(root.matches(CHART) ? [root] : []), ...root.querySelectorAll<HTMLElement>(CHART)];
}

function timestamp(root: ParentNode): number {
  return Date.parse(root.querySelector<HTMLMetaElement>(STAMP)?.content ?? "");
}

/** Only import our server-rendered data. Never replay scripts, analytics or forms. */
function removeExecutableContent(region: HTMLElement): void {
  for (const node of region.querySelectorAll("script, iframe, object, embed")) {
    if (node.matches('script.score-chart-data[type="application/json"]')) continue;
    node.remove();
  }
  for (const element of [region, ...region.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || attribute.name === "nonce") element.removeAttribute(attribute.name);
    }
  }
}

type ElementPosition = { selector: string } | { path: number[] };

function elementPosition(element: Element, region: HTMLElement): ElementPosition | null {
  if (element.id) return { selector: `#${CSS.escape(element.id)}` };
  for (const name of ["data-score-reset", "data-score-previous", "data-score-next", "data-score-jump", "data-toggle-pillar", "data-event-id"]) {
    if (element.hasAttribute(name)) return { selector: `${element.tagName.toLowerCase()}[${name}="${CSS.escape(element.getAttribute(name)!)}"]` };
  }
  if (element.matches(".score-scrubber")) return { selector: ".score-scrubber" };
  // Stable structural path for ordinary links and disclosure summaries.
  const path: number[] = [];
  let current: Element | null = element;
  while (current && current !== region) {
    const parent: Element | null = current.parentElement;
    if (!parent) return null;
    path.unshift([...parent.children].indexOf(current));
    current = parent;
  }
  return current === region ? { path } : null;
}

function findPosition(region: HTMLElement, position: ElementPosition | null): HTMLElement | null {
  if (!position) return null;
  if ("selector" in position) return region.querySelector<HTMLElement>(position.selector);
  let element: Element | undefined = region;
  for (const index of position.path) element = element?.children[index];
  return (element as HTMLElement | undefined) ?? null;
}

/** Swap only opted-in data regions, retaining the chart's semantic selection. */
export function applyLiveDocument(fresh: Document, busy?: (region: HTMLElement) => boolean): { updated: number; unavailable: boolean } {
  const nextStamp = timestamp(fresh);
  const currentStamp = timestamp(document);
  if (!Number.isFinite(nextStamp) || nextStamp < Date.UTC(2000, 0, 1)
    || (Number.isFinite(currentStamp) && nextStamp < currentStamp)) {
    throw new Error("Refresh did not contain a current published snapshot");
  }
  const incoming = new Map([...fresh.querySelectorAll<HTMLElement>(REGION)].map(region => [region.dataset.liveRegion, region]));
  const existing = [...document.querySelectorAll<HTMLElement>(REGION)];
  if (!existing.length || !existing.some(region => incoming.has(region.dataset.liveRegion))) throw new Error("Refresh regions missing");
  // Keep the visible section anchored if content above it changes height.
  const anchor = existing.find(region => {
    if (!region.closest("main")) return false;
    const rect = region.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > 100 && rect.top < window.innerHeight;
  });
  const anchorKey = anchor?.dataset.liveRegion;
  const anchorTop = anchor?.getBoundingClientRect().top;
  let updated = 0;
  let unavailable = false;
  for (const old of existing) {
    const next = incoming.get(old.dataset.liveRegion);
    if (!next || next.dataset.liveValid === "false") { unavailable = true; continue; }
    const active = document.activeElement;
    // Do not interrupt a drag or a date/search input being edited. The next
    // refresh will pick up this region after the interaction finishes.
    if (busy?.(old) || (active && old.contains(active) && active.matches('input:not([type="range"]), textarea, select, [contenteditable="true"]'))) continue;
    removeExecutableContent(next);
    const signature = next.outerHTML;
    if (signatures.get(old) === signature) continue;
    const states = charts(old).map(chart => ({ score: captureScoreChartState(chart), event: captureChartEventState(chart) }));
    const details = [...old.querySelectorAll("details")].map(detail => detail.open);
    const scrollPositions = [...old.querySelectorAll<HTMLElement>("*")]
      .filter(element => element.scrollLeft || element.scrollTop)
      .map(element => ({ position: elementPosition(element, old), left: element.scrollLeft, top: element.scrollTop }));
    const focus = active && old.contains(active) ? elementPosition(active, old) : null;
    disposeScoreCharts(old);
    disposeChartEvents(old);
    const replacement = document.importNode(next, true);
    // The walker has a persistent animation loop that reads these attributes.
    // Retain its element/phase and feed it the new score instead of starting
    // another loop or leaving an animated detached element behind.
    const walkers = old.querySelectorAll<HTMLElement>('.tightrope-walker[data-animate="true"]');
    replacement.querySelectorAll<HTMLElement>('.tightrope-walker[data-animate="true"]').forEach((newWalker, index) => {
      const walker = walkers[index];
      if (!walker) return;
      for (const attribute of ["data-score", "data-amp", "data-speed", "aria-label"]) {
        const value = newWalker.getAttribute(attribute);
        if (value !== null) walker.setAttribute(attribute, value);
      }
      for (const property of ["--arc-green", "--arc-amber", "--arc-red"]) walker.style.setProperty(property, newWalker.style.getPropertyValue(property));
      newWalker.replaceWith(walker);
    });
    old.replaceWith(replacement);
    signatures.set(replacement, signature);
    replacement.querySelectorAll("details").forEach((detail, index) => { if (details[index] !== undefined) detail.open = details[index]!; });
    initialiseScoreCharts(replacement);
    initialiseChartEvents(replacement);
    charts(replacement).forEach((chart, index) => {
      const state = states[index];
      if (!state) return;
      if (state.score) restoreScoreChartState(chart, state.score);
      restoreChartEventState(chart, state.event);
    });
    if (focus) findPosition(replacement, focus)?.focus({ preventScroll: true });
    for (const position of scrollPositions) {
      const element = findPosition(replacement, position.position);
      if (element) { element.scrollLeft = position.left; element.scrollTop = position.top; }
    }
    updated++;
  }
  const meta = document.querySelector<HTMLMetaElement>(STAMP);
  if (meta) meta.content = fresh.querySelector<HTMLMetaElement>(STAMP)!.content;
  if (updated) {
    document.dispatchEvent(new CustomEvent("tightrope:live-updated"));
    if (anchorKey && anchorTop !== undefined) {
      const newAnchor = [...document.querySelectorAll<HTMLElement>(REGION)].find(region => region.dataset.liveRegion === anchorKey);
      const shift = newAnchor ? newAnchor.getBoundingClientRect().top - anchorTop : 0;
      if (Math.abs(shift) > .5) window.scrollBy({ top: shift, behavior: "instant" });
    }
  }
  return { updated, unavailable };
}

let activeStop: (() => void) | undefined;

/** One bounded request per minute while visible; failures retain last-good UI. */
export function startLiveRefresh(): () => void {
  activeStop?.();
  if (!document.querySelector(STAMP) || !document.querySelector(REGION)) return () => {};
  let stopped = false;
  let suspended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;
  let failures = 0;
  let refreshOnReturn = false;
  let pointerRegion: HTMLElement | null = null;
  const keyTimes = new WeakMap<HTMLElement, number>();
  const statusNodes = document.querySelectorAll<HTMLElement>("[data-live-status]");
  const status = (message: string, checked = false) => {
    for (const node of statusNodes) {
      node.hidden = false;
      if (node.textContent !== message) node.textContent = message;
      if (checked) {
        node.dataset.liveCheckedAt = new Date().toISOString();
        node.title = `Last checked ${new Date().toLocaleTimeString("en-GB", { timeZone: "UTC" })} UTC`;
      }
    }
  };
  const available = () => !stopped && !suspended && document.visibilityState !== "hidden" && navigator.onLine !== false;
  const schedule = () => {
    clearTimeout(timer);
    if (available()) timer = setTimeout(refresh, Math.min(300_000, INTERVAL * 2 ** failures));
  };
  async function refresh() {
    if (!available() || pending) return;
    const url = new URL(window.location.href);
    url.hash = "";
    const controller = new AbortController();
    pending = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url.href, {
        signal: controller.signal, cache: "no-store", credentials: "same-origin", redirect: "error",
        headers: { Accept: "text/html", "X-Tightrope-Refresh": "1" },
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) throw new Error("Refresh unavailable");
      const html = await response.text();
      const currentUrl = new URL(window.location.href);
      currentUrl.hash = "";
      if (!available() || controller.signal.aborted || url.href !== currentUrl.href) return;
      const result = applyLiveDocument(new DOMParser().parseFromString(html, "text/html"), region =>
        region === pointerRegion || Date.now() - (keyTimes.get(region) ?? 0) < 2_000);
      failures = 0;
      status(result.unavailable ? "Some sections couldn’t refresh · retrying automatically" : "Updates automatically · every minute", true);
    } catch {
      if (available()) {
        failures = Math.min(failures + 1, 3);
        status("Update delayed · showing last received data · retrying automatically");
      }
    } finally {
      clearTimeout(timeout);
      pending = undefined;
      if (refreshOnReturn && available()) { refreshOnReturn = false; void refresh(); }
      else schedule();
    }
  }
  function resume() {
    clearTimeout(timer);
    if (available()) {
      if (pending?.signal.aborted) refreshOnReturn = true;
      else void refresh();
    }
    else {
      pointerRegion = null;
      pending?.abort();
      if (navigator.onLine === false) status("Offline · showing last received data · resumes when connected");
    }
  }
  const pageHide = () => { suspended = true; pointerRegion = null; clearTimeout(timer); pending?.abort(); };
  const pageShow = () => { suspended = false; resume(); };
  const pointerDown = (event: Event) => { pointerRegion = (event.target as Element)?.closest<HTMLElement>(REGION) ?? null; };
  const pointerUp = () => { pointerRegion = null; };
  const keyDown = (event: Event) => {
    const region = (event.target as Element)?.closest<HTMLElement>(REGION);
    if (region) keyTimes.set(region, Date.now());
  };
  document.addEventListener("visibilitychange", resume);
  document.addEventListener("pointerdown", pointerDown);
  document.addEventListener("keydown", keyDown);
  window.addEventListener("pointerup", pointerUp);
  window.addEventListener("pointercancel", pointerUp);
  window.addEventListener("blur", pointerUp);
  window.addEventListener("online", resume);
  window.addEventListener("offline", resume);
  window.addEventListener("pagehide", pageHide);
  window.addEventListener("pageshow", pageShow);
  status(navigator.onLine === false ? "Offline · showing last received data · resumes when connected" : "Updates automatically · every minute");
  schedule();
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    pending?.abort();
    document.removeEventListener("visibilitychange", resume);
    document.removeEventListener("pointerdown", pointerDown);
    document.removeEventListener("keydown", keyDown);
    window.removeEventListener("pointerup", pointerUp);
    window.removeEventListener("pointercancel", pointerUp);
    window.removeEventListener("blur", pointerUp);
    window.removeEventListener("online", resume);
    window.removeEventListener("offline", resume);
    window.removeEventListener("pagehide", pageHide);
    window.removeEventListener("pageshow", pageShow);
    if (activeStop === stop) activeStop = undefined;
  };
  activeStop = stop;
  return stop;
}
