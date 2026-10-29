import { describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { parseHTML } from "linkedom";
import type { HeadlineScore } from "@tightrope/shared";
import TopNav from "./TopNav.astro";
import SiteFooter from "./SiteFooter.astro";
import Hero from "./Hero.astro";

const updatedAt = "2026-10-29T11:10:00Z";
const freshestAt = "2026-10-28T16:30:00Z";
const headline: HeadlineScore = {
  value: 37, band: "acute", editorial: "", updatedAt,
  delta24h: 0, delta30d: 0, deltaYtd: 0, dominantPillar: "market", sparkline90d: [],
};

describe("Visible score and source freshness", () => {
  it("separates today's computation from yesterday's source date throughout the page chrome", async () => {
    const container = await AstroContainer.create();
    const nav = parseHTML(await container.renderToString(TopNav, { props: { updatedAt, freshestAt } })).document;
    const chip = nav.querySelector(".live-chip")!;
    expect(chip.getAttribute("data-live-region")).toBe("nav-freshness");
    expect(nav.querySelector("nav.top")?.hasAttribute("data-live-region")).toBe(false);
    expect(nav.querySelector("[data-nav-toggle]")?.closest("[data-live-region]")).toBeNull();
    expect(chip.textContent).toContain("Score computed · 29 Oct 11:10 UTC");
    expect(chip.textContent).toContain("Latest source date · 28 Oct 16:30 UTC");
    expect(chip.querySelectorAll("time")[0]?.getAttribute("datetime")).toBe(updatedAt);
    expect(chip.querySelectorAll("time")[1]?.getAttribute("datetime")).toBe(freshestAt);

    const hero = parseHTML(await container.renderToString(Hero, { props: { headline, freshestAt } })).document;
    expect(hero.querySelector(".eyebrow")?.textContent).toContain("Score computed · 2026-10-29 11:10 UTC");
    expect(hero.querySelector(".source-date")?.textContent).toContain("Latest source date · 2026-10-28 16:30 UTC");
    expect(hero.querySelector(".source-date")?.textContent).toContain("Release date where available, otherwise observation date");

    const footer = parseHTML(await container.renderToString(SiteFooter, { props: { updatedAt, freshestAt } })).document;
    expect(footer.querySelector(".footer-freshness")?.textContent).toContain("Score computed: 2026-10-29 11:10 UTC");
    expect(footer.querySelector(".footer-freshness")?.textContent).toContain("Latest source date: 2026-10-28 16:30 UTC");
    expect(footer.querySelector(".footer-freshness")?.getAttribute("data-live-region")).toBe("footer-freshness");
    const refreshStatus = footer.querySelector("[data-live-status]")!;
    expect(refreshStatus.hasAttribute("hidden")).toBe(true);
    expect(refreshStatus.getAttribute("role")).toBe("status");
    expect(refreshStatus.closest("[data-live-region]")).toBeNull();
  });

  it("does not relabel a computation as source data when the source timestamp is unavailable", async () => {
    const container = await AstroContainer.create();
    const nav = parseHTML(await container.renderToString(TopNav, { props: { updatedAt, stale: true } })).document;
    expect(nav.querySelector(".live-chip")?.textContent).toContain("Latest source date · Unavailable");
    expect(nav.querySelector(".live-chip")?.textContent).toContain("Some inputs stale");
    const hero = parseHTML(await container.renderToString(Hero, { props: { headline } })).document;
    expect(hero.querySelector(".source-date")?.textContent).toContain("Latest source date · Unavailable");
    const footer = parseHTML(await container.renderToString(SiteFooter, { props: { updatedAt, stale: true } })).document;
    expect(footer.querySelector(".footer-freshness")?.textContent).toContain("Latest source date: Unavailable");
    expect(footer.querySelector(".stale-label")?.textContent).toBe("Some inputs stale");
  });

  it("does not invent a current timestamp when neither timestamp is available", async () => {
    const container = await AstroContainer.create();
    const footer = parseHTML(await container.renderToString(SiteFooter)).document;
    const freshness = footer.querySelector(".footer-freshness")!;
    expect(freshness.textContent).toContain("Score computed: Unavailable");
    expect(freshness.textContent).toContain("Latest source date: Unavailable");
    expect(freshness.querySelector("time")).toBeNull();
  });
});
