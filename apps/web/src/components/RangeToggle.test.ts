/**
 * Tests for the RangeToggle component.
 *
 * RangeToggle renders four time-range options as anchor links. We assert:
 *   - all four options appear with the correct ?range=N query
 *   - the option matching `current` carries aria-current="page"
 *   - the others do not
 *   - basePath override flows through to the href
 */
import { describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { parseHTML } from "linkedom";
import RangeToggle from "./RangeToggle.astro";

async function render(props: { current: 30 | 90 | 365 | "all"; basePath?: string }): Promise<Document> {
  const container = await AstroContainer.create();
  const html = await container.renderToString(RangeToggle, { props });
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return document;
}

describe("RangeToggle", () => {
  it("renders four range options with the right ?range= queries", async () => {
    const doc = await render({ current: 90 });
    const links = doc.querySelectorAll("a.range-link");
    expect(links.length).toBe(4);
    const hrefs = Array.from(links).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "/composite?range=30",
      "/composite?range=90",
      "/composite?range=365",
      "/composite?range=all",
    ]);
  });

  it("marks the active range with aria-current=\"page\" and is-active class", async () => {
    const doc = await render({ current: 365 });
    const links = doc.querySelectorAll("a.range-link");
    let activeCount = 0;
    for (const link of links) {
      const isCurrent = link.getAttribute("aria-current") === "page";
      const hasActiveClass = link.classList.contains("is-active");
      if (isCurrent) activeCount++;
      // Either both flags are set or neither — they must agree.
      expect(isCurrent).toBe(hasActiveClass);
    }
    expect(activeCount).toBe(1);
    const active = doc.querySelector("a.range-link.is-active");
    expect(active?.getAttribute("data-range")).toBe("365");
  });

  it("flows basePath through to the href", async () => {
    const doc = await render({ current: 30, basePath: "/explore" });
    const first = doc.querySelector("a.range-link");
    expect(first?.getAttribute("href")).toBe("/explore?range=30");
  });

  it("renders an aria-label on the wrapping nav", async () => {
    const doc = await render({ current: 90 });
    const nav = doc.querySelector("nav.range-toggle");
    expect(nav?.getAttribute("aria-label")).toBe("Time range");
  });

  it("supports the \"all\" sentinel as the active option", async () => {
    const doc = await render({ current: "all" });
    const active = doc.querySelector("a.range-link.is-active");
    expect(active?.getAttribute("data-range")).toBe("all");
    expect(active?.getAttribute("href")).toBe("/composite?range=all");
  });
});
