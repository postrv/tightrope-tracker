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

export function buildBoEIadbUrl(seriesCodes: string, opts: { lookbackDays?: number; now?: Date } = {}): string {
  const now = opts.now ?? new Date();
  const lookback = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const from = new Date(now.getTime() - lookback * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams();
  params.set("csv.x", "yes");
  params.set("SeriesCodes", seriesCodes);
  params.set("Datefrom", toBoEDateParam(from));
  params.set("Dateto", toBoEDateParam(now));
  params.set("UsingCodes", "Y");
  return `${BASE_URL}?${params.toString()}`;
}
