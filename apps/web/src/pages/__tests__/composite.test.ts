/**
 * Tests for the /composite page.
 *
 * Render the page via the Astro Container API with a stubbed App.Locals.
 * The Container API doesn't run middleware, so the page reads its env
 * via `Astro.locals.runtime.env`; we stub D1 + KV to return canned rows
 * and assert on the resulting markup.
 */
import { describe, expect, it } from "vitest";
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
} = {}): MockEnv {
  const headlineRows = opts.headlineRows ?? [];
  const pillarRows = opts.pillarRows ?? [];

  function execute(sql: string): Promise<{ results: unknown[] }> {
    const lower = sql.toLowerCase();
    void rangeQuery(sql, 0);
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

describe("/composite page", () => {
  it("renders the page heading and the range toggle", async () => {
    const doc = await renderComposite("90", buildEnv());
    expect(doc.querySelector("h1.composite-title")?.textContent).toMatch(/last 90 days/);
    expect(doc.querySelector("nav.range-toggle")).not.toBeNull();
    const active = doc.querySelector("a.range-link.is-active");
    expect(active?.getAttribute("data-range")).toBe("90");
  });

  it("shows an empty state when no history rows are available", async () => {
    const doc = await renderComposite("90", buildEnv());
    expect(doc.querySelector(".empty")).not.toBeNull();
    expect(doc.querySelector(".chart-wrap")).toBeNull();
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
});
