/**
 * Tests for the /composite page.
 *
 * Render the page via the Astro Container API with a stubbed App.Locals.
 * The Container API doesn't run middleware, so the page reads its env
 * via `Astro.locals.runtime.env`; we stub D1 + KV to return canned rows
 * and assert on the resulting markup.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { parseHTML } from "linkedom";
import composite from "../composite.astro";

interface StubRow {
  observed_at: string;
  value: number;
  pillar_id?: string;
}

function rangeQuery(s: string, days: number): boolean {
  // Best-effort: every history-related SQL we care about begins with
  // SELECT … FROM headline_scores or pillar_scores and binds the day count.
  const lower = s.toLowerCase();
  return lower.includes("headline_scores") || lower.includes("pillar_scores") || lower.includes("ingestion_audit") || lower.includes("indicator_observations") || days > 0;
}

interface MockEnv {
  KV: { get: (key: string, type?: string) => Promise<unknown>; put: () => Promise<void> };
  DB: {
    prepare: (sql: string) => {
      bind: (...args: unknown[]) => { all: <T>() => Promise<{ results: T[] }>; first: <T>() => Promise<T | null> };
      all: <T>() => Promise<{ results: T[] }>;
      first: <T>() => Promise<T | null>;
    };
  };
}

function buildEnv(opts: {
  headlineRows?: StubRow[];
  pillarRows?: StubRow[];
  historyFailures?: number;
} = {}): MockEnv {
  const headlineRows = opts.headlineRows ?? [];
  const pillarRows = opts.pillarRows ?? headlineRows.flatMap(row => ["market", "fiscal", "labour", "delivery"].map(pillar_id => ({ ...row, pillar_id })));
  let historyReads = 0;

  function execute(sql: string): Promise<{ results: unknown[] }> {
    const lower = sql.toLowerCase();
    void rangeQuery(sql, 0);
    if (lower.includes("with selected as")) {
      if (historyReads++ < (opts.historyFailures ?? 0)) return Promise.reject(new Error("D1_ERROR: Network connection lost"));
      return Promise.resolve({ results: headlineRows.map(row => ({ ...row,
        ...Object.fromEntries(["market", "fiscal", "labour", "delivery"].map(id => [id,
          pillarRows.filter(p => p.pillar_id === id && p.observed_at <= row.observed_at).sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0]?.value ?? null,
        ])),
      })) });
    }
    if (lower.includes("min(observed_at) as first")) return Promise.resolve({ results: [{ first: headlineRows[0]?.observed_at ?? null, last: headlineRows.at(-1)?.observed_at ?? null }] });
    if (lower.includes("from headline_scores") && lower.includes("limit 1")) {
      const last = headlineRows[headlineRows.length - 1];
      return Promise.resolve({
        results: last ? [{ ...last, band: "strained", dominant: "market", editorial: "" }] : [],
      });
    }
    if (lower.includes("from headline_scores") && lower.includes("where observed_at >=")) {
      return Promise.resolve({ results: headlineRows });
    }
    if (lower.includes("from headline_scores")) {
      return Promise.resolve({ results: headlineRows.map((r) => ({ observed_at: r.observed_at, value: r.value })) });
    }
    if (lower.includes("from pillar_scores") && lower.includes("where observed_at >=")) {
      return Promise.resolve({ results: pillarRows.map((r) => ({ id: r.pillar_id, observed_at: r.observed_at, value: r.value })) });
    }
    if (lower.includes("from pillar_scores") && lower.includes("group by pillar_id") && !lower.includes("substr")) {
      // latest-per-pillar
      return Promise.resolve({
        results: ["market", "fiscal", "labour", "delivery"].map((id) => ({
          id, observed_at: "2026-04-20T12:00:00Z", value: 50, band: "strained",
        })),
      });
    }
    if (lower.includes("from pillar_scores")) {
      return Promise.resolve({ results: [] });
    }
    if (lower.includes("today_movements")) return Promise.resolve({ results: [] });
    if (lower.includes("delivery_commitments")) return Promise.resolve({ results: [] });
    if (lower.includes("timeline_events")) return Promise.resolve({ results: [] });
    if (lower.includes("ingestion_audit")) return Promise.resolve({ results: [] });
    if (lower.includes("indicator_observations")) return Promise.resolve({ results: [] });
    return Promise.resolve({ results: [] });
  }

  function first(sql: string): Promise<unknown> {
    return execute(sql).then((r) => r.results[0] ?? null);
  }

  return {
    KV: {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    },
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          all: () => execute(sql) as Promise<{ results: never[] }>,
          first: () => first(sql) as Promise<null>,
        }),
        all: () => execute(sql) as Promise<{ results: never[] }>,
        first: () => first(sql) as Promise<null>,
      }),
    },
  };
}

async function renderComposite(rangeQ: string, env: MockEnv): Promise<Document> {
  const container = await AstroContainer.create();
  // Astro requires `request.url`; the Container API will read query params
  // off it. Locals are passed through `Astro.locals.runtime.env`.
  const html = await container.renderToString(composite, {
    request: new Request(`https://example.test/composite?range=${rangeQ}`),
    locals: { runtime: { env } } as unknown as App.Locals,
  });
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return document;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("/composite page", () => {
  it("renders the page heading and the range toggle", async () => {
    const doc = await renderComposite("90", buildEnv());
    expect(doc.querySelector("h1.composite-title")?.textContent).toMatch(/last 90 days/);
    expect(doc.querySelector('nav.top a[href="/#market"]')).not.toBeNull();
    expect(doc.querySelector("nav.range-toggle")).not.toBeNull();
    const active = doc.querySelector("a.range-link.is-active");
    expect(active?.getAttribute("data-range")).toBe("90");
  });

  it("shows an empty state when no history rows are available", async () => {
    const doc = await renderComposite("90", buildEnv());
    expect(doc.querySelector(".empty")).not.toBeNull();
    expect(doc.querySelector(".chart-wrap")).toBeNull();
    expect(doc.querySelector(".history-unavailable")).toBeNull();
  });

  it("shows an explicit unavailable state after two failures, preserving retry controls and drivers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const doc = await renderComposite("all&resolution=daily&embed=1", buildEnv({ historyFailures: 2 }));
    const status = doc.querySelector(".history-unavailable");
    expect(status?.textContent).toContain("History temporarily unavailable");
    expect(status?.textContent).not.toContain("D1_ERROR");
    expect(status?.querySelector("a")?.getAttribute("href")).toBe("/composite?range=all&resolution=daily&embed=1");
    expect(doc.querySelector(".empty")).toBeNull();
    expect(doc.querySelector(".history-coverage")).toBeNull();
    expect(doc.querySelector('[data-live-region="composite-history"]')?.getAttribute("data-live-valid")).toBe("false");
    expect(doc.querySelectorAll("article.driver-card")).toHaveLength(4);
  });

  it("renders recovered history after a single transient failure instead of reporting no recordings", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const doc = await renderComposite("all&resolution=daily", buildEnv({ historyFailures: 1, headlineRows: [
      { observed_at: "2024-12-17T23:59:00Z", value: 40 },
      { observed_at: "2026-10-28T23:50:00Z", value: 36.9 },
    ] }));
    expect(doc.querySelector(".history-unavailable")).toBeNull();
    expect(doc.querySelector(".history-coverage")?.textContent).toContain("2 recordings");
    expect(doc.querySelector(".chart-wrap")).not.toBeNull();
  });

  it("renders the chart when D1 returns history rows", async () => {
    const headlineRows: StubRow[] = [];
    for (let i = 0; i < 10; i++) {
      const day = String(i + 1).padStart(2, "0");
      headlineRows.push({ observed_at: `2026-04-${day}T12:00:00Z`, value: 50 + i });
    }
    const doc = await renderComposite("30", buildEnv({ headlineRows }));
    expect(doc.querySelector(".empty")).toBeNull();
    expect(doc.querySelector(".chart-wrap")).not.toBeNull();
    expect(doc.querySelector("svg.chart-svg")).not.toBeNull();
    const liveHistory = doc.querySelector('[data-live-region="composite-history"]')!;
    expect(liveHistory.getAttribute("data-live-valid")).toBe("true");
    expect(liveHistory.querySelector(".history-coverage")).not.toBeNull();
    expect(liveHistory.querySelector(".sampling-note")).not.toBeNull();
    expect(liveHistory.querySelector("svg.chart-svg")).not.toBeNull();
    expect(liveHistory.querySelector("[data-live-region]")).toBeNull();
    expect(doc.querySelector(".resolution-form")?.closest("[data-live-region]")).toBeNull();
    expect(doc.querySelector("nav.range-toggle")?.closest("[data-live-region]")).toBeNull();
    expect(doc.querySelector('[data-live-region="pillar-drivers"]')?.closest('[data-live-region="composite-history"]')).toBeNull();
    // The 30d toggle should be the active link.
    const active = doc.querySelector("a.range-link.is-active");
    expect(active?.getAttribute("data-range")).toBe("30");
  });

  it("falls back to 90 days when the range query is invalid", async () => {
    const doc = await renderComposite("foo", buildEnv());
    const active = doc.querySelector("a.range-link.is-active");
    expect(active?.getAttribute("data-range")).toBe("90");
  });

  it("supports the \"all\" sentinel", async () => {
    const doc = await renderComposite("all", buildEnv());
    const active = doc.querySelector("a.range-link.is-active");
    expect(active?.getAttribute("data-range")).toBe("all");
    expect(doc.querySelector("h1.composite-title")?.textContent).toMatch(/all available history/);
  });

  it("renders the pillar drivers panel below the chart", async () => {
    const doc = await renderComposite("90", buildEnv());
    const cards = doc.querySelectorAll("article.driver-card");
    expect(cards.length).toBe(4);
  });

  it("exposes real short-window resolution and controls without manufacturing daily intraday points", async () => {
    const now = Date.now();
    const doc = await renderComposite("1&resolution=raw", buildEnv({ headlineRows: [
      { observed_at: new Date(now - 300_000).toISOString(), value: 42.7 },
      { observed_at: new Date(now).toISOString(), value: 42.8 },
    ] }));
    expect(doc.querySelector("h1.composite-title")?.textContent).toContain("last 24 hours");
    expect(doc.querySelector(".history-coverage")?.textContent).toContain("Every recorded snapshot");
    expect(doc.querySelector('select[name="resolution"] option[selected]')?.getAttribute("value")).toBe("raw");
    expect(doc.querySelector('a[data-range="7"]')?.getAttribute("href")).toContain("resolution=raw");
    expect(doc.querySelectorAll(".score-chart-data").length).toBe(1);
  });
});
