/**
 * Minimal CSV parser. Assumes:
 *   - UTF-8 input
 *   - comma-separated
 *   - no embedded commas in values (Bank of England IADB + ONS /data CSVs satisfy this)
 *   - optional trailing blank lines
 *
 * Returns an array of objects keyed by the header row.
 */
import { AdapterError } from "./errors.js";

/**
 * Throws if `body` looks like an HTML document rather than CSV. The BoE IADB
 * endpoint 302-redirects malformed requests to an HTML error page, which
 * `parseCsv` would otherwise silently turn into zero rows -- we'd rather fail
 * loud so the audit row records the real cause.
 */
export function assertLooksLikeCsv(sourceId: string, sourceUrl: string, body: string): void {
  const head = body.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<head") || head.startsWith("<body")) {
    const snippet = body.trim().slice(0, 120).replace(/\s+/g, " ");
    throw new AdapterError({
      sourceId,
      sourceUrl,
      message: `${sourceId} returned HTML, expected CSV (body starts: "${snippet}")`,
    });
  }
}

export interface ParseCsvOptions {
  /**
   * When `true`, rows with fewer cells than the header are padded with "",
   * and rows with more cells are truncated to the header length. This
   * restores the parser's pre-2026 behaviour but hides two bugs:
   *
   *   - Short rows look valid downstream (parseNum returns null on "",
   *     the row drops silently, and the "zero observations" audit chip
   *     may still go green for an adapter with a catalog-level expected
   *     count of 1).
   *   - Long rows (e.g. a BoE footnote that contains an embedded comma)
   *     have the stray comma-split content shifted into the wrong column
   *     and the final field silently dropped — a numeric yield can be
   *     replaced by a footnote fragment with no error.
   *
   * Opt in only when the upstream feed is known to emit ragged rows and
   * the caller has an explicit strategy to handle them.
   */
  tolerateRaggedRows?: boolean;
}

export function parseCsv(
  input: string,
  opts: ParseCsvOptions = {},
): Array<Record<string, string>> {
  const lines = input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0]!.split(",").map((c) => c.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(",").map((c) => c.trim());
    if (!opts.tolerateRaggedRows && cells.length !== header.length) {
      throw new Error(
        `parseCsv: row ${i + 1} has ${cells.length} cell${cells.length === 1 ? "" : "s"} ` +
          `but header has ${header.length} column${header.length === 1 ? "" : "s"}; ` +
          `column count mismatch. Pass { tolerateRaggedRows: true } only if the ` +
          `upstream feed is known to emit ragged rows.`,
      );
    }
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]!] = cells[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Convert a BoE IADB date (DD Mmm YYYY) into an ISO 8601 UTC timestamp
 * stamped at the official 4 p.m. London close-of-business time the
 * series is fixed to. We previously stamped midnight UTC, which (a)
 * pre-dates the actual fixing by 16 hours and (b) misled the homepage
 * into rendering "as of HH:MM UTC = 00:00" next to a 4 p.m. London print.
 *
 * The BoE Statistical Database publishes daily series fixed at 16:00
 * London (15:00 BST → 16:00 BST during DST and 16:00 GMT outside).
 * We stamp 16:00:00Z as a defensible single-time approximation; the
 * sub-hour DST drift is invisible at the homepage's "HH:MM" resolution
 * and well below the BoE's own publication-lag tolerance.
 */
export function boeDateToIso(input: string): string {
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const match = input.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!match) {
    throw new Error(`boeDateToIso: cannot parse '${input}'`);
  }
  const day = match[1]!.padStart(2, "0");
  const monAbbr = match[2]!.slice(0, 1).toUpperCase() + match[2]!.slice(1, 3).toLowerCase();
  const mm = months[monAbbr];
  if (!mm) throw new Error(`boeDateToIso: unknown month '${match[2]}'`);
  return `${match[3]}-${mm}-${day}T16:00:00Z`;
}

const BOE_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"] as const;

/**
 * Format a JS Date as the BoE IADB query-param expects: `DD/MMM/YYYY` with the
 * English three-letter month abbreviation. The Datefrom / Dateto fields reject
 * any other format -- numeric months produce a 302 to ErrorPage.asp.
 */
export function toBoEDateParam(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mmm = BOE_MONTHS[d.getUTCMonth()]!;
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mmm}/${yyyy}`;
}
