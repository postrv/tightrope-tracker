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

  it("imports the snapshot + baseline loaders from page-data", () => {
    expect(source).toContain("loadSnapshot");
    expect(source).toContain("loadBaselineSummaries");
    expect(source).toMatch(/from\s+["']~\/lib\/page-data\.js["']/);
  });

  it("renders the ExploreIsland with the live snapshot + baselines", () => {
    expect(source).toContain("ExploreIsland");
    expect(source).toMatch(/snapshot=\{snapshot\}/);
    expect(source).toMatch(/baselines=\{baselines\}/);
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

  it("declares the data-lever attribute bound to LEVERS map", () => {
    // The template renders one <li data-lever={lever.key}> per LEVERS entry,
    // which the LEVER catalogue in whatIf.ts owns.
    expect(source).toContain("data-lever={lever.key}");
  });

  it("groups sliders by pillar with a fieldset per pillar", () => {
    expect(source).toContain("data-pillar-group");
    expect(source).toContain("PILLAR_ORDER.map");
  });

  it("emits a JSON config script the client picks up", () => {
    expect(source).toMatch(/type="application\/json"/);
    expect(source).toContain("data-explore-config");
    expect(source).toContain("baselines"); // payload includes baselines
  });

  it("provides five pre-baked scenario buttons + a reset button", () => {
    expect(source).toMatch(/data-scenario="live"/);
    expect(source).toMatch(/data-scenario="spring2025"/);
    expect(source).toMatch(/data-scenario="conflict"/);
    expect(source).toMatch(/data-scenario="recovery"/);
    expect(source).toMatch(/data-scenario="crisis"/);
    expect(source).toMatch(/data-action="reset"/);
  });

  it("imports bootstrapExplore from the extracted module", () => {
    expect(source).toContain("bootstrapExplore");
    expect(source).toContain("~/lib/exploreBootstrap.js");
  });

  it("includes the live-vs-scenario indicator + pillar delta bars", () => {
    expect(source).toContain("data-vs-live");
    expect(source).toContain("data-pillar-bar-live");
    expect(source).toContain("data-pillar-bar-scenario");
  });

  it("includes a per-lever effect badge slot", () => {
    expect(source).toContain("data-lever-effect");
  });

  it("declares the ECDF / linear mode badge per lever", () => {
    expect(source).toContain("mode-badge");
    expect(source).toMatch(/ECDF|ecdf/);
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

  it("declares 'counterfactual, not a forecast' framing in the lede", () => {
    expect(source).toMatch(/counterfactual recomputation, not a forecast/i);
  });

  it("includes a <noscript> fallback so JS-disabled readers see context", () => {
    expect(source).toContain("<noscript>");
  });
});
