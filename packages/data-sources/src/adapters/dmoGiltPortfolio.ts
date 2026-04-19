/**
 * UK Debt Management Office -- gilts in issue.
 *
 * Source: https://www.dmo.gov.uk/data/XmlDataReport?reportCode=D1A
 *
 * The endpoint returns a flat XML list of every outstanding gilt at the most
 * recent close-of-business date, with attributes per instrument:
 *
 *   INSTRUMENT_TYPE                  "Conventional " / "Index-linked 3 months"
 *                                    / "Index-linked 8 months"
 *   MATURITY_BRACKET                 "Ultra-Short" / "Short" / "Medium"
 *                                    / "Long" / "Ultra-Long"
 *   TOTAL_AMOUNT_IN_ISSUE            nominal amount £m
 *   TOTAL_AMOUNT_INCLUDING_IL_UPLIFT nominal + accrued inflation uplift, £m
 *   CLOSE_OF_BUSINESS_DATE           snapshot date (ISO-ish "YYYY-MM-DDT00:00:00")
 *
 * We use TOTAL_AMOUNT_INCLUDING_IL_UPLIFT because it reflects what the
 * government actually owes at today's RPI -- the economically meaningful
 * figure for an inflation-exposure measure like `ilg_share`.
 *
 * Two indicators emitted:
 *
 *   ilg_share             -- index-linked share of total gilt stock (%)
 *   issuance_long_share   -- long-dated share of conventional gilt stock (%)
 *
 * Note on `issuance_long_share`: the indicator ID is historical (preserved
 * for DB continuity); the measure is stock-based, not flow-based. The DMO
 * does publish an issuance-flow report (D2.1E) but it is protected by a
 * ShieldSquare bot-check, so the live endpoint cannot reach it. The stock
 * share is the right substitute -- it captures the same structural signal
 * (long-dated exposure as share of refinancing-relevant conventional debt)
 * without the flow measure's seasonality.
 *
 * No `fetchHistorical` implementation -- the D1A XML endpoint only exposes
 * the most recent snapshot; historical dates require the PDF-style UI that
 * is not machine-addressable. Seed data covers the 30-day history window.
 */
import type {
  AdapterResult,
  DataSourceAdapter,
  RawObservation,
} from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";

const SOURCE_ID = "dmo";
const SOURCE_URL = "https://www.dmo.gov.uk/data/XmlDataReport?reportCode=D1A";

export interface GiltRow {
  instrumentType: string;
  maturityBracket: string;
  amount: number;
  closeOfBusinessDate: string;
}

export interface PortfolioTotals {
  total: number;
  conventional: number;
  conventionalLong: number;
  indexLinked: number;
  closeOfBusinessDate: string;
}

export const dmoGiltPortfolioAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "UK DMO -- gilts in issue (D1A)",
  async fetch(fetchImpl): Promise<AdapterResult> {
    const res = await fetchOrThrow(fetchImpl, SOURCE_ID, SOURCE_URL, {
      headers: { accept: "application/xml, text/xml" },
    });
    const body = await res.text();
    const rows = parseGiltsInIssueXml(body, SOURCE_URL);
    const totals = aggregateGiltPortfolio(rows, SOURCE_URL);
    const observedAt = closeOfBusinessToIso(totals.closeOfBusinessDate, SOURCE_URL);
    const payloadHash = await sha256Hex(body);

    // Store full double precision. DMO publishes daily and single-issuance
    // moves change the long-share by thousandths of a percent; rounding at
    // storage time would flatten the sparkline to a step function. The
    // display layer (`fmtPct(1)`) handles rounding for humans.
    const ilgSharePct = (totals.indexLinked / totals.total) * 100;
    const longSharePct = (totals.conventionalLong / totals.conventional) * 100;

    const observations: RawObservation[] = [
      { indicatorId: "ilg_share",           value: ilgSharePct,  observedAt, sourceId: SOURCE_ID, payloadHash },
      { indicatorId: "issuance_long_share", value: longSharePct, observedAt, sourceId: SOURCE_ID, payloadHash },
    ];

    return { observations, sourceUrl: SOURCE_URL, fetchedAt: new Date().toISOString() };
  },
};

/**
 * Parse every `<View_GILTS_IN_ISSUE .../>` row from the D1A XML response.
 * The shape is flat (attributes only, no nested elements), so an attribute
 * regex over the matched tag is sufficient and avoids pulling in an XML
 * parser dependency (Workers runtime has no DOMParser).
 *
 * Exported for unit tests.
 */
export function parseGiltsInIssueXml(body: string, url: string): GiltRow[] {
  const tagMatches = [...body.matchAll(/<View_GILTS_IN_ISSUE\s+([^>]+?)\/>/g)];
  if (tagMatches.length === 0) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: url,
      message: "DMO D1A: no <View_GILTS_IN_ISSUE/> rows found in XML response",
    });
  }

  const rows: GiltRow[] = [];
  for (const m of tagMatches) {
    const attrs = parseAttributes(m[1]!);
    const amountRaw = attrs.TOTAL_AMOUNT_INCLUDING_IL_UPLIFT ?? attrs.TOTAL_AMOUNT_IN_ISSUE;
    const amount = Number(amountRaw);
    const instrumentType = (attrs.INSTRUMENT_TYPE ?? "").trim();
    const maturityBracket = (attrs.MATURITY_BRACKET ?? "").trim();
    const closeOfBusinessDate = (attrs.CLOSE_OF_BUSINESS_DATE ?? "").trim();
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (!instrumentType || !maturityBracket || !closeOfBusinessDate) continue;
    rows.push({ instrumentType, maturityBracket, amount, closeOfBusinessDate });
  }
  if (rows.length === 0) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: url,
      message: "DMO D1A: all XML rows failed attribute validation",
    });
  }
  return rows;
}

/**
 * Reduce a parsed gilt-portfolio snapshot to the three totals the adapter
 * needs. Exported for unit tests so we can verify bucketing without going
 * through the full fetch path.
 *
 * A "long-dated" conventional gilt is anything the DMO classifies as
 * `Long` or `Ultra-Long`. Historically the DMO used only four brackets
 * (Short/Medium/Long/Ultra-Short); Ultra-Long has been used intermittently,
 * so we include both to be future-proof.
 */
export function aggregateGiltPortfolio(rows: readonly GiltRow[], url: string): PortfolioTotals {
  let total = 0;
  let conventional = 0;
  let conventionalLong = 0;
  let indexLinked = 0;

  for (const row of rows) {
    total += row.amount;
    if (row.instrumentType === "Conventional") {
      conventional += row.amount;
      if (row.maturityBracket === "Long" || row.maturityBracket === "Ultra-Long") {
        conventionalLong += row.amount;
      }
    } else if (row.instrumentType.startsWith("Index-linked")) {
      indexLinked += row.amount;
    }
    // Other types (e.g. "Undated", "Treasury bill") would be excluded from
    // the conventional/IL split but still counted in `total`. At time of
    // writing, DMO D1A emits only Conventional and Index-linked rows.
  }

  if (total <= 0) {
    throw new AdapterError({
      sourceId: SOURCE_ID, sourceUrl: url,
      message: "DMO D1A: total gilt amount non-positive -- refusing to divide",
    });
  }
  if (conventional <= 0) {
    throw new AdapterError({
      sourceId: SOURCE_ID, sourceUrl: url,
      message: "DMO D1A: no conventional gilts parsed -- would produce NaN long-share",
    });
  }

  // All rows share the same snapshot date in practice; pick the first.
  const closeOfBusinessDate = rows[0]!.closeOfBusinessDate;
  return { total, conventional, conventionalLong, indexLinked, closeOfBusinessDate };
}

function parseAttributes(chunk: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of chunk.matchAll(/([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]*)"/gi)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * CLOSE_OF_BUSINESS_DATE arrives as "YYYY-MM-DDT00:00:00" (no timezone).
 * Treat it as midnight UTC of that trading day so our observedAt is a
 * canonical ISO-8601 with a Z suffix.
 */
function closeOfBusinessToIso(raw: string, url: string): string {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}$/);
  if (!m) {
    throw new AdapterError({
      sourceId: SOURCE_ID, sourceUrl: url,
      message: `DMO D1A: CLOSE_OF_BUSINESS_DATE '${raw}' not in expected YYYY-MM-DDT00:00:00 shape`,
    });
  }
  return `${m[1]}T00:00:00Z`;
}

registerAdapter(dmoGiltPortfolioAdapter);
