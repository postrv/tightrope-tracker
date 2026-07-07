import { describe, expect, it } from "vitest";
import { discoverReleaseUrl, extractHrefs } from "../lib/discover";

describe("extractHrefs", () => {
  it("resolves relative + absolute hrefs and skips fragments / mailto / javascript", () => {
    const html = `
      <a href="/government/statistics/x-2026">rel</a>
      <a href="https://ex.test/y">abs</a>
      <a href="#top">frag</a>
      <a href="mailto:a@b.c">mail</a>
      <a href="javascript:void(0)">js</a>`;
    const hrefs = extractHrefs(html, "https://www.gov.uk/collections/z");
    expect(hrefs).toEqual(["https://www.gov.uk/government/statistics/x-2026", "https://ex.test/y"]);
  });
});

describe("discoverReleaseUrl", () => {
  // NielsenIQ landing page lists articles newest-first.
  const NIQ = `
    <a href="https://nielseniq.com/global/en/news-center/2026/consumer-confidence-stay-at-23-in-june/">June</a>
    <a href="https://nielseniq.com/global/en/news-center/2026/consumer-confidence-up-two-points-in-may-to-23/">May</a>
    <a href="https://nielseniq.com/global/en/landing-page/consumer-confidence-barometer/">self</a>`;

  it("'first' picks the first matching link in document order (newest-first publishers)", () => {
    const url = discoverReleaseUrl(NIQ, "https://nielseniq.com/x", { linkPattern: "/news-center/\\d{4}/consumer-confidence-", newest: "first" });
    expect(url).toBe("https://nielseniq.com/global/en/news-center/2026/consumer-confidence-stay-at-23-in-june/");
  });

  it("returns null when nothing matches", () => {
    expect(discoverReleaseUrl(NIQ, "https://x", { linkPattern: "/does-not-exist/", newest: "first" })).toBeNull();
  });

  // gov.uk collection with quarterly releases in ARBITRARY document order.
  const GOVUK = `
    <a href="/government/statistics/housing-supply-indicators-of-new-supply-england-july-to-september-2025">a</a>
    <a href="/government/statistics/housing-supply-indicators-of-new-supply-england-january-to-march-2026">b</a>
    <a href="/government/statistics/housing-supply-indicators-of-new-supply-england-october-to-december-2025">c</a>
    <a href="/government/statistics/house-building-in-england-april-to-june-2016">old-series</a>`;

  it("'quarter' picks the latest year+quarter regardless of document order", () => {
    const url = discoverReleaseUrl(GOVUK, "https://www.gov.uk/x", {
      linkPattern: "/government/statistics/housing-supply-indicators-of-new-supply-england-(january-to-march|april-to-june|july-to-september|october-to-december)-20\\d{2}",
      newest: "quarter",
    });
    expect(url).toBe("https://www.gov.uk/government/statistics/housing-supply-indicators-of-new-supply-england-january-to-march-2026");
  });

  it("'quarter' orders Q4-of-prev-year below Q1-of-next-year", () => {
    const html = `
      <a href="/s/x-october-to-december-2025">q4-2025</a>
      <a href="/s/x-january-to-march-2026">q1-2026</a>`;
    const url = discoverReleaseUrl(html, "https://h.test", { linkPattern: "/s/x-", newest: "quarter" });
    expect(url).toBe("https://h.test/s/x-january-to-march-2026");
  });

  it("'year' picks the highest 20xx year", () => {
    const html = `<a href="/efo/economic-and-fiscal-outlook-march-2024/">a</a>
      <a href="/efo/economic-and-fiscal-outlook-march-2026/">b</a>
      <a href="/efo/economic-and-fiscal-outlook-october-2025/">c</a>`;
    const url = discoverReleaseUrl(html, "https://obr.uk", { linkPattern: "economic-and-fiscal-outlook-[a-z]+-20\\d{2}", newest: "year" });
    expect(url).toBe("https://obr.uk/efo/economic-and-fiscal-outlook-march-2026/");
  });

  it("de-dupes repeated hrefs so a link listed twice is picked once", () => {
    const html = `<a href="/a-2026">1</a><a href="/a-2026">dup</a>`;
    expect(discoverReleaseUrl(html, "https://h.test", { linkPattern: "/a-", newest: "first" })).toBe("https://h.test/a-2026");
  });
});
