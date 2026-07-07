import type { DiscoverConfig } from "../types";

/**
 * Follow-link discovery — the shared logic behind `CaptureSpec.discover`.
 *
 * Several UK publishers print the headline number one click deeper than the
 * fixed landing/collection page the fetcher grabs: NielsenIQ links each month's
 * consumer-confidence article; gov.uk collections link each quarterly release;
 * obr.uk/efo links the exec-summary PDF. This module takes the discovery page's
 * HTML and returns the single NEWEST release URL matching the spec's
 * `linkPattern`, so the caller can fetch THAT and hand the release — not the
 * landing page — to the model.
 *
 * It is a PURE function of (html, discoveryUrl, config): no fetch, no env. That
 * is deliberate — the Worker capture stage and the relay runner script
 * (scripts/relay-artefacts.mjs, run under tsx) both import it, so the discovery
 * a cron does and the discovery a runner does can never drift.
 */

/** gov.uk quarterly slug fragments → quarter ordinal, for the "quarter" strategy. */
const QUARTERS: Record<string, number> = {
  "january-to-march": 1,
  "april-to-june": 2,
  "july-to-september": 3,
  "october-to-december": 4,
};

/**
 * Extract every `href="..."` from HTML, resolved to an absolute URL against
 * `baseUrl`. Hand-rolled (repo idiom — no cheerio). Skips fragments, mailto:,
 * and javascript: pseudo-links; silently drops malformed hrefs.
 */
export function extractHrefs(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /href\s*=\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1]!.trim();
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel):/i.test(raw)) continue;
    try {
      out.push(new URL(raw, baseUrl).toString());
    } catch {
      /* malformed href — skip */
    }
  }
  return out;
}

/**
 * The newest release URL on a discovery page, or null if nothing matches.
 * `matches` are deduped in document order; the newest-selection strategy is:
 *   "first"   → first match in document order (publishers list newest-first).
 *   "year"    → highest 4-digit 20xx year in the href (ties keep the first).
 *   "quarter" → gov.uk quarterly slug ordered by year then quarter.
 */
export function discoverReleaseUrl(html: string, discoveryUrl: string, config: DiscoverConfig): string | null {
  const pattern = new RegExp(config.linkPattern, "i");
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const href of extractHrefs(html, discoveryUrl)) {
    if (!pattern.test(href) || seen.has(href)) continue;
    seen.add(href);
    matches.push(href);
  }
  if (matches.length === 0) return null;

  switch (config.newest) {
    case "first":
      return matches[0]!;
    case "year":
      return pickByKey(matches, yearKey);
    case "quarter":
      return pickByKey(matches, quarterKey);
  }
}

/** Return the match with the greatest key; on ties keep the earliest (document order = newest-first). */
function pickByKey(matches: string[], keyOf: (href: string) => number): string {
  let best = matches[0]!;
  let bestKey = keyOf(best);
  for (const href of matches) {
    const k = keyOf(href);
    if (k > bestKey) {
      best = href;
      bestKey = k;
    }
  }
  return best;
}

function yearKey(href: string): number {
  const years = href.match(/20\d{2}/g);
  return years ? Math.max(...years.map(Number)) : -1;
}

function quarterKey(href: string): number {
  const q = href.toLowerCase().match(/(january-to-march|april-to-june|july-to-september|october-to-december)-(20\d{2})/);
  if (!q) return yearKey(href) * 10; // no quarter slug: order by year alone
  return Number(q[2]) * 10 + (QUARTERS[q[1]!] ?? 0);
}
