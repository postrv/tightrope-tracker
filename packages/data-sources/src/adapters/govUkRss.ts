/**
 * gov.uk announcements Atom feed adapter.
 *
 * Unlike other adapters this one does not emit indicator observations -- it
 * parses the Atom feed into *timeline event candidates* and returns them
 * alongside the (empty) observation list. The ingest Worker's delivery
 * pipeline forwards these candidates to a queue for editorial review rather
 * than writing them directly to the public timeline.
 *
 * We filter by department (passed via the `Content-Location`-style param in
 * the URL or via a configurable list below) so staff-pick departments such as
 * DESNZ / DBT / MHCLG get picked up for the delivery pillar.
 */
import type { AdapterResult, DataSourceAdapter } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";

const SOURCE_ID = "gov_uk";
// gov.uk retired `/government/announcements.atom` — the live replacement that
// surfaces the same stream of ministerial announcements/news/speeches is the
// site-wide search feed. Entries no longer carry `<category>` tags, so the
// department filter below only fires for entries that *do* carry one; the
// parser's "no category -> pass through" branch handles the new shape.
const URL = "https://www.gov.uk/search/news-and-communications.atom";

/** Departments we care about for delivery pillar timeline candidates. */
export const DELIVERY_DEPARTMENTS: readonly string[] = [
  "department-for-energy-security-and-net-zero",
  "department-for-business-and-trade",
  // MHCLG slug lost the "and" when the department was restated in 2024.
  "ministry-of-housing-communities-local-government",
  "hm-treasury",
  "cabinet-office",
];

export interface TimelineEventCandidate {
  id: string;
  title: string;
  link: string;
  publishedAt: string;
  summary: string;
  categorySlug: string | null;
}

export interface GovUkResult extends AdapterResult {
  candidates: TimelineEventCandidate[];
}

export const govUkRssAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "gov.uk -- announcements Atom feed",
  async fetch(fetchImpl): Promise<AdapterResult> {
    return await fetchGovUkCandidates(fetchImpl);
  },
};

/**
 * Public helper so the ingest Worker can access the `candidates[]` side-channel
 * without a cast. Wraps the same HTTP call as `adapter.fetch`.
 */
export async function fetchGovUkCandidates(fetchImpl: typeof globalThis.fetch): Promise<GovUkResult> {
  const res = await fetchOrThrow(fetchImpl, SOURCE_ID, URL, { headers: { accept: "application/atom+xml,application/xml" } });
  const body = await res.text();
  const entries = parseAtomEntries(body);
  if (entries.length === 0) {
    throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: URL, message: "gov.uk: no entries in Atom feed" });
  }
  const candidates: TimelineEventCandidate[] = entries.filter((e) => {
    if (!e.categorySlug) return true;
    return DELIVERY_DEPARTMENTS.some((slug) => e.categorySlug!.includes(slug));
  });
  const _ = await sha256Hex(body); // compute but unused -- atom feed doesn't feed observations
  void _;
  return {
    observations: [],
    sourceUrl: URL,
    fetchedAt: new Date().toISOString(),
    candidates,
  };
}

/**
 * Very small Atom parser. Extracts `<entry>` blocks and pulls out title, link,
 * id, published, summary and the first category `term`. Good enough for the
 * gov.uk Atom feed, which uses a fixed schema.
 */
export function parseAtomEntries(xml: string): TimelineEventCandidate[] {
  const entries: TimelineEventCandidate[] = [];
  const entryRegex = /<entry[\s>][\s\S]*?<\/entry>/g;
  const matches = xml.match(entryRegex) ?? [];
  for (const entry of matches) {
    const title = decode(textBetween(entry, "title") ?? "");
    const id = decode(textBetween(entry, "id") ?? "");
    const summary = decode(textBetween(entry, "summary") ?? "");
    const publishedAt = decode(textBetween(entry, "published") ?? textBetween(entry, "updated") ?? "");
    const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/);
    const link = linkMatch ? decode(linkMatch[1]!) : "";
    const categoryMatch = entry.match(/<category[^>]*term="([^"]+)"/);
    const categorySlug = categoryMatch ? decode(categoryMatch[1]!) : null;
    if (!title || !id) continue;
    entries.push({ id, title, link, publishedAt, summary, categorySlug });
  }
  return entries;
}

function textBetween(src: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = src.match(re);
  return m ? m[1]!.trim() : null;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

registerAdapter(govUkRssAdapter);
