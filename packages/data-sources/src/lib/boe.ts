/**
 * Shared helpers for the Bank of England IADB CSV endpoint.
 *
 * IADB moved: the legacy `boeapps/iadb/fromshowcolumns.asp` path now 302s to an
 * HTML error page, as does any request carrying the old `CodeVer=new` flag.
 * The current working shape is:
 *
 *   /boeapps/database/_iadb-fromshowcolumns.asp
 *     ?csv.x=yes
 *     &SeriesCodes=IUDMNPY,IUDMNZC       -- comma-separated series codes
 *     &Datefrom=01/Apr/2024              -- DD/MMM/YYYY, English abbreviations
 *     &Dateto=18/Apr/2026                -- DD/MMM/YYYY
 *     &UsingCodes=Y                      -- required, or it 302s
 *
 * Default lookback is two years -- comfortably more than the 252-day window
 * the SONIA adapter needs, and well beyond what the yield/FX/breakevens
 * adapters consume (they only take the most recent populated row).
 */
import { toBoEDateParam } from "./csv.js";

const BASE_URL = "https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp";
const DEFAULT_LOOKBACK_DAYS = 2 * 365;

/**
 * The IADB endpoint blocks obvious scrapers (no UA, curl default UA). A
 * generic browser-ish UA gets through; we keep it honest by also setting an
 * `accept` header pointing at CSV.
 */
export const BOE_FETCH_HEADERS: Record<string, string> = {
  accept: "text/csv,*/*;q=0.5",
  "user-agent": "Mozilla/5.0 (compatible; tightrope-ingest/1.0; +https://tightropetracker.uk/methodology)",
};

/**
 * Build the IADB CSV URL. Callers choose one of two modes:
 *
 *   - default (no opts, or `lookbackDays`/`now`): rolling window ending "now".
 *   - historical: pass both `from` and `to` to anchor an explicit range.
 *
 * When `from`/`to` are both supplied they take precedence over `lookbackDays`.
 * The endpoint is inclusive on both sides and tolerates `to` in the future
 * (it silently clips to the last available business day).
 */
export function buildBoEIadbUrl(
  seriesCodes: string,
  opts: { lookbackDays?: number; now?: Date; from?: Date; to?: Date } = {},
): string {
  const now = opts.now ?? new Date();
  const to = opts.to ?? now;
  const from =
    opts.from ??
    new Date(to.getTime() - (opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams();
  params.set("csv.x", "yes");
  params.set("SeriesCodes", seriesCodes);
  params.set("Datefrom", toBoEDateParam(from));
  params.set("Dateto", toBoEDateParam(to));
  params.set("UsingCodes", "Y");
  return `${BASE_URL}?${params.toString()}`;
}
