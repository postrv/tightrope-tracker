/**
 * @vitest-environment node
 *
 * Page-level tests for /explore.
 *
 * Astro components can't be evaluated under vitest directly, but the page's
 * non-trivial behaviour is the embed-mode branch and snapshot wiring -- both
 * of which can be exercised by reading the source file and checking the
 * structural contract holds.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = resolve(HERE, "./explore.astro");
const ISLAND_PATH = resolve(HERE, "../components/explore/ExploreIsland.astro");

describe("/explore page", () => {
  const source = readFileSync(PAGE_PATH, "utf8");

  it("imports the snapshot loader from page-data", () => {
    expect(source).toContain("loadSnapshot");
    expect(source).toMatch(/from\s+["']~\/lib\/page-data\.js["']/);
  });

  it("renders the ExploreIsland with the live snapshot", () => {
    expect(source).toContain("ExploreIsland");
    expect(source).toMatch(/snapshot=\{snapshot\}/);
  });

  it("respects ?embed=1 by stripping the chrome", () => {
    expect(source).toContain('searchParams.get("embed")');
    expect(source).toContain('"1"');
    // Both branches present -- one with TopNav/SiteFooter and one without.
    expect(source).toMatch(/TopNav/);
    expect(source).toMatch(/SiteFooter/);
    // The embed branch passes embed prop into BaseLayout.
    expect(source).toMatch(/BaseLayout[^>]*embed/);
  });

  it("links the page through the BaseLayout (so canonical/og work)", () => {
    expect(source).toContain("BaseLayout");
    expect(source).toMatch(/title="Tightrope Tracker — explore/);
  });
});

describe("ExploreIsland source", () => {
  const source = readFileSync(ISLAND_PATH, "utf8");

  it("declares the five-lever data-lever attribute via LEVERS map", () => {
    // The template renders one <li data-lever={lever.key}> per LEVERS entry,
    // which the LEVER catalogue in whatIf.ts owns. We assert the binding is
    // present in the source.
    expect(source).toContain("data-lever={lever.key}");
  });

  it("emits a JSON config script the client picks up", () => {
    expect(source).toMatch(/type="application\/json"/);
    expect(source).toContain("data-explore-config");
  });

  it("provides four pre-baked scenario buttons + a reset button", () => {
    expect(source).toMatch(/data-scenario="live"/);
    expect(source).toMatch(/data-scenario="spring2025"/);
    expect(source).toMatch(/data-scenario="conflict"/);
    expect(source).toMatch(/data-scenario="recovery"/);
    expect(source).toMatch(/data-action="reset"/);
  });

  it("includes a share button and status region", () => {
    expect(source).toMatch(/data-action='share'|data-action="share"/);
    expect(source).toMatch(/data-share-status/);
  });

  it("wires up sliders with full ARIA metadata", () => {
    expect(source).toContain("aria-valuemin");
    expect(source).toContain("aria-valuemax");
    expect(source).toContain("aria-valuenow");
    expect(source).toContain("aria-valuetext");
  });

  it("links to the methodology page", () => {
    expect(source).toMatch(/href="\/methodology"/);
  });
});
