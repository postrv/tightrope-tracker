import { describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { parseHTML } from "linkedom";
import ProvenanceBadge from "./ProvenanceBadge.astro";

describe("Provenance publication and timestamp clarity", () => {
  it("describes automated collection without claiming five-minute source publications or successful ingestion", async () => {
    const container = await AstroContainer.create();
    for (const indicatorId of ["gilt_10y", "housebuilder_idx", "consumer_confidence"]) {
      const doc = parseHTML(await container.renderToString(ProvenanceBadge, { props: { indicatorId } })).document;
      const badge = doc.querySelector(".prov")!;
      const title = badge.getAttribute("title")!;
      expect(title).toContain("score computation");
      expect(title).not.toMatch(/five-minut|last successful ingest/i);
      expect(badge.getAttribute("aria-label")).toContain(title);
    }
  });
});
