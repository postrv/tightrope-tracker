/**
 * Indicator taxonomy for the Tightrope Tracker.
 *
 * Pillars: market (40%), fiscal (30%), labour (20%), delivery (10%).
 *
 * The Market pillar has been extended with OBR-proxy indicators: real-time
 * market variables that approximate the inputs that feed the Office for Budget
 * Responsibility's Economic and Fiscal Outlook (EFO) -- CPI inflation (5y and
 * 10y breakevens, Brent in GBP), real GDP growth (UK housebuilder composite,
 * Services PMI, consumer confidence, RICS house-price balance), and the real
 * rate regime (index-linked gilt real yield). These market-implied series move
 * daily/weekly whereas the OBR publishes twice a year, so they signal when the
 * OBR's central forecast is drifting away from what markets expect. See
 * docs/OBR_PROXIES.md for the full mechanism-by-mechanism write-up.
 *
 * Additive-only: existing indicator IDs are preserved; the expansion
 * rebalances Market intra-pillar weights so they still sum to 1.0. The Market
 * pillar weight of 0.40 in PILLARS is unchanged.
 */
export type PillarId = "market" | "fiscal" | "labour" | "delivery";

export interface PillarDefinition {
  id: PillarId;
  title: string;
  shortTitle: string;
  weight: number;
  cadence: "intraday" | "daily" | "monthly" | "event";
  blurb: string;
  /** If true, higher raw score means better delivery -- we invert before normalising. */
  inverted: boolean;
}

export const PILLARS: Record<PillarId, PillarDefinition> = {
  market: {
    id: "market",
    title: "Market Pressure",
    shortTitle: "Market",
    weight: 0.40,
    cadence: "intraday",
    blurb: "Are markets tightening the vice?",
    inverted: false,
  },
  fiscal: {
    id: "fiscal",
    title: "Fiscal Constraint",
    shortTitle: "Fiscal",
    weight: 0.30,
    cadence: "event",
    blurb: "Is the fiscal buffer shrinking or expanding?",
    inverted: false,
  },
  labour: {
    id: "labour",
    title: "Labour & Living-Standards Strain",
    shortTitle: "Labour",
    weight: 0.20,
    cadence: "monthly",
    blurb: "Is the labour force getting healthier and more engaged?",
    inverted: false,
  },
  delivery: {
    id: "delivery",
    title: "Growth Delivery",
    shortTitle: "Delivery",
    weight: 0.10,
    cadence: "event",
    blurb: "Are the promised growth reforms visibly delivering?",
    inverted: true,
  },
};

export const PILLAR_ORDER: readonly PillarId[] = ["market", "fiscal", "labour", "delivery"];

/**
 * How this indicator's values reach the database. Surfaced next to every
 * card in the UI so a reader (or BBC journalist fact-checking the chart)
 * can tell at a glance whether a number is machine-fetched from a primary
 * source, hand-curated from a periodic release, or editorial judgement.
 *
 *   "live"       — an adapter fetches the latest value from the primary
 *                  publisher on a cron (BoE, ONS, Moneyfacts...).
 *   "fixture"    — the primary publisher does not expose a machine-readable
 *                  feed; the value is transcribed into a versioned JSON
 *                  fixture after each release and mirrored by the adapter.
 *   "editorial"  — no primary data series exists; the value reflects
 *                  editorial judgement applied to public announcements
 *                  (delivery milestones) or has no data source wired yet.
 */
export type IndicatorProvenance = "live" | "fixture" | "editorial";

export interface IndicatorDefinition {
  id: string;
  pillar: PillarId;
  label: string;
  shortLabel: string;
  unit: string;
  /** Intra-pillar weight. Normalised so all indicators in a pillar sum to 1 at scoring time. */
  weight: number;
  /** True if a rising raw value represents worsening pressure. */
  risingIsBad: boolean;
  sourceId: string;
  description: string;
  formatDisplay: (value: number) => string;
  /**
   * Where this indicator's values come from. Required for public rollout —
   * the UI renders a "LIVE / FIXTURE / EDITORIAL" chip next to every card
   * so readers don't have to cross-reference the /sources page.
   */
  provenance: IndicatorProvenance;
  /**
   * Per-indicator freshness window, in milliseconds. An observation is
   * "fresh" for the pillar quorum check if `(now - observedAt) <=
   * maxStaleMs`. The value must match the source's publication cadence
   * plus a buffer for weekends / bank holidays / known reporting lag --
   * e.g. BoE daily feeds get ~5 days, ONS PSF (monthly with 45-day lag)
   * gets ~90 days, OBR EFO (semi-annual) gets ~220 days. Values are
   * expressed via the `STALE_*_MS` constants below so each entry is
   * self-documenting.
   */
  maxStaleMs: number;
  /**
   * Whether a defensible historical time-series exists for this indicator.
   * Defaults to `true` when omitted. Set `false` for indicators whose values
   * cannot be responsibly backfilled — either because they are editorial
   * interpretations of political announcements (delivery milestones) or
   * because the upstream feed only exposes today's snapshot (DMO D1A gilts
   * in issue). The historical backfill pipeline excludes them from its
   * quorum math; live recompute still uses every indicator regardless.
   */
  hasHistoricalSeries?: boolean;
  /**
   * When `hasHistoricalSeries` is `false`, a short sentence explaining
   * _why_ the indicator is live-only. Surfaced verbatim in the methodology
   * page's live-only disclosure table. Required whenever
   * `hasHistoricalSeries === false` — the seedArtifact / historicalSubset
   * tests enforce presence so the disclosure never ships with blank cells.
   */
  historicalExclusionReason?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Per-cadence freshness windows used by `IndicatorDefinition.maxStaleMs`.
 *
 * These are not arbitrary: each answers "how old can the latest observation
 * reasonably get while the adapter is still healthy?". If an observation is
 * older than this, the upstream source has actually gone quiet -- the
 * homepage "stale" banner should fire for exactly that case, not for the
 * natural gap between a twice-yearly OBR release or a quarterly MHCLG print.
 */
const STALE_DAILY_MS = 5 * DAY_MS;
const STALE_WEEKLY_FIXTURE_MS = 14 * DAY_MS;
const STALE_MONTHLY_FIXTURE_MS = 50 * DAY_MS;
const STALE_RTI_MONTHLY_MS = 60 * DAY_MS;
const STALE_ONS_PSF_MS = 90 * DAY_MS;
const STALE_MHCLG_QUARTERLY_MS = 130 * DAY_MS;
const STALE_ONS_LMS_MS = 180 * DAY_MS;
const STALE_OBR_SEMIANNUAL_MS = 220 * DAY_MS;

const fmtPct = (digits = 2) => (v: number) => `${v.toFixed(digits)}%`;
const fmtBp = (v: number) => `${v.toFixed(2)}%`;
const fmtIndex = (digits = 0) => (v: number) => v.toFixed(digits);
const fmtGbpBn = (v: number) => `GBP ${v.toFixed(1)}bn`;
const fmtMillions = (v: number) => `${v.toFixed(2)}m`;
const fmtRatio = (v: number) => v.toFixed(4);
const fmtCount = (v: number) => v.toLocaleString("en-GB");

export const INDICATORS: Record<string, IndicatorDefinition> = {
  // Market (40%) -- intra-pillar weights sum to 1.00.
  // Weights were rebalanced when the OBR-proxy block was added: the rates/FX/gas
  // core kept its relative ordering but was scaled down to make room for the
  // eight OBR-proxy indicators below, which sit in a collective 0.36 slot.
  gilt_10y: {
    id: "gilt_10y", pillar: "market", label: "10-year gilt yield", shortLabel: "10y gilt",
    unit: "%", weight: 0.18, risingIsBad: true, sourceId: "boe_yields",
    description: "UK 10-year nominal zero-coupon gilt yield (BoE IUDMNZC, daily close).", formatDisplay: fmtBp,
    provenance: "live",
    maxStaleMs: STALE_DAILY_MS,
  },
  gilt_30y: {
    id: "gilt_30y", pillar: "market", label: "20-year gilt yield", shortLabel: "20y gilt",
    unit: "%", weight: 0.16, risingIsBad: true, sourceId: "boe_yields",
    description: "UK 20-year nominal zero-coupon gilt yield (BoE IUDLNZC). Sensitivity proxy for long-duration borrowing. Indicator ID preserved as gilt_30y for DB continuity.", formatDisplay: fmtBp,
    provenance: "live",
    maxStaleMs: STALE_DAILY_MS,
  },
  gbp_usd: {
    id: "gbp_usd", pillar: "market", label: "GBP / USD", shortLabel: "GBP/USD",
    unit: "ccy", weight: 0.07, risingIsBad: false, sourceId: "boe_fx",
    description: "Sterling vs. US dollar.", formatDisplay: fmtRatio,
    provenance: "live",
    maxStaleMs: STALE_DAILY_MS,
  },
  gbp_twi: {
    id: "gbp_twi", pillar: "market", label: "GBP trade-weighted index", shortLabel: "GBP TWI",
    unit: "index", weight: 0.07, risingIsBad: false, sourceId: "boe_fx",
    description: "Broad effective exchange rate index for sterling.", formatDisplay: fmtIndex(2),
    provenance: "live",
    maxStaleMs: STALE_DAILY_MS,
  },
  ftse_250: {
    id: "ftse_250", pillar: "market", label: "FTSE 250", shortLabel: "FTSE 250",
    unit: "index", weight: 0.10, risingIsBad: false, sourceId: "lseg",
    description: "Mid-cap index -- cleaner domestic UK read than FTSE 100.", formatDisplay: fmtIndex(0),
    // Fixture-backed editorial mirror of the LSE close. The adapter's
    // freshness guard (14 days) prevents silent staleness.
    provenance: "live",
    maxStaleMs: STALE_WEEKLY_FIXTURE_MS,
  },
  // OBR-proxy extension -- see docs/OBR_PROXIES.md for the mechanism per indicator.
  // Inflation-input proxies: breakevens from BoE zero-coupon curves, Brent in GBP.
  breakeven_5y: {
    id: "breakeven_5y", pillar: "market", label: "5y breakeven inflation", shortLabel: "5y BE",
    unit: "%", weight: 0.12, risingIsBad: true, sourceId: "boe_yields",
    description: "5y nominal minus 5y real gilt yield -- market-implied CPI/RPI 5y ahead, a direct proxy for OBR's CPI inflation path over the forecast horizon.",
    formatDisplay: fmtBp,
    provenance: "live",
    maxStaleMs: STALE_DAILY_MS,
  },
  brent_gbp: {
    id: "brent_gbp", pillar: "market", label: "Brent crude in GBP", shortLabel: "Brent GBP",
    unit: "GBP/bbl", weight: 0.10, risingIsBad: true, sourceId: "eia_brent",
    description: "Brent dated spot price converted to GBP -- the single largest swing input to OBR's CPI energy subcomponent and fuel-duty receipts.",
    formatDisplay: (v) => `GBP ${v.toFixed(2)}/bbl`,
    provenance: "fixture",
    maxStaleMs: STALE_WEEKLY_FIXTURE_MS,
  },
  // Growth-input proxies: housebuilder composite, Services PMI, consumer confidence, RICS balance.
  housebuilder_idx: {
    id: "housebuilder_idx", pillar: "market", label: "UK housebuilder composite", shortLabel: "Housebuilders",
    unit: "index", weight: 0.08, risingIsBad: false, sourceId: "eodhd_housebuilders",
    description: "Equal-weighted price index of the five largest listed UK housebuilders (rebased 100 = 2019 avg) -- leads OBR's residential investment and construction GVA lines by 3-6 months.",
    formatDisplay: fmtIndex(1),
    provenance: "live",
    maxStaleMs: STALE_DAILY_MS,
  },
  services_pmi: {
    id: "services_pmi", pillar: "market", label: "S&P Global UK Services PMI", shortLabel: "Services PMI",
    unit: "index", weight: 0.05, risingIsBad: false, sourceId: "sp_global_pmi",
    description: "Headline Services PMI -- 50 = no change. Services is ~80% of UK GVA, so this leads OBR's real-GDP growth forecast by roughly one quarter.",
    formatDisplay: fmtIndex(1),
    provenance: "fixture",
    maxStaleMs: STALE_MONTHLY_FIXTURE_MS,
  },
  consumer_confidence: {
    id: "consumer_confidence", pillar: "market", label: "GfK consumer confidence", shortLabel: "Cons. conf.",
    unit: "index", weight: 0.04, risingIsBad: false, sourceId: "gfk_confidence",
    description: "GfK/NIESR consumer confidence headline index -- leading signal for household-consumption growth, the largest single expenditure line in OBR's GDP decomposition.",
    formatDisplay: fmtIndex(0),
    provenance: "fixture",
    maxStaleMs: STALE_MONTHLY_FIXTURE_MS,
  },
  rics_price_balance: {
    id: "rics_price_balance", pillar: "market", label: "RICS house-price balance", shortLabel: "RICS price",
    unit: "%", weight: 0.03, risingIsBad: false, sourceId: "rics_rms",
    description: "Net balance of RICS surveyors reporting price rises vs. falls -- leads residential investment in OBR's expenditure GDP by 1-2 quarters.",
    formatDisplay: fmtPct(0),
    provenance: "fixture",
    maxStaleMs: STALE_MONTHLY_FIXTURE_MS,
  },

  // Fiscal (30%)
  cb_headroom: {
    id: "cb_headroom", pillar: "fiscal", label: "Current-budget headroom", shortLabel: "CB headroom",
    unit: "GBPbn", weight: 0.35, risingIsBad: false, sourceId: "obr_efo",
    description: "Surplus against the stability rule at the target year.", formatDisplay: fmtGbpBn,
    provenance: "fixture",
    maxStaleMs: STALE_OBR_SEMIANNUAL_MS,
  },
  psnfl_trajectory: {
    id: "psnfl_trajectory", pillar: "fiscal", label: "PSNFL trajectory deviation", shortLabel: "PSNFL dev",
    unit: "pp", weight: 0.15, risingIsBad: true, sourceId: "obr_efo",
    description: "Deviation of PSNFL path from OBR baseline, percentage points of GDP.", formatDisplay: fmtPct(2),
    provenance: "fixture",
    maxStaleMs: STALE_OBR_SEMIANNUAL_MS,
  },
  borrowing_outturn: {
    id: "borrowing_outturn", pillar: "fiscal", label: "Public-sector net borrowing", shortLabel: "PSNB",
    unit: "GBPbn", weight: 0.15, risingIsBad: true, sourceId: "ons_psf",
    description: "Monthly public-sector net borrowing excluding public-sector banks (ONS J5II). Higher values = more borrowing.", formatDisplay: fmtGbpBn,
    provenance: "live",
    maxStaleMs: STALE_ONS_PSF_MS,
  },
  debt_interest: {
    id: "debt_interest", pillar: "fiscal", label: "Central-government net interest payable", shortLabel: "Debt interest",
    unit: "GBPbn", weight: 0.15, risingIsBad: true, sourceId: "ons_psf",
    description: "Central-government net interest payable, monthly (ONS NMFX).", formatDisplay: fmtGbpBn,
    provenance: "live",
    maxStaleMs: STALE_ONS_PSF_MS,
  },
  ilg_share: {
    id: "ilg_share", pillar: "fiscal", label: "Index-linked gilt share of stock", shortLabel: "ILG share",
    unit: "%", weight: 0.10, risingIsBad: true, sourceId: "dmo",
    description: "Share of outstanding gilt stock (inflation-uplifted nominal) that is index-linked -- inflation-sensitivity proxy. Source: DMO D1A gilts-in-issue feed.",
    formatDisplay: fmtPct(1),
    provenance: "live",
    maxStaleMs: STALE_DAILY_MS,
    hasHistoricalSeries: false,
    historicalExclusionReason: "DMO D1A feed only exposes today's gilts-in-issue snapshot; archived stock composition is not machine-addressable, so historical values cannot be reconstructed from primary source.",
  },
  issuance_long_share: {
    // Indicator ID preserved for DB continuity. The measure is now a
    // stock-based share of conventional debt in the Long / Ultra-Long
    // maturity brackets, sourced from the DMO D1A gilts-in-issue feed.
    // The original flow-based "planned annual issuance" formulation is
    // only published through a ShieldSquare-gated report, which we cannot
    // reach from a Worker. The stock share captures the same structural
    // signal (long-dated exposure as a share of refinancing-relevant debt)
    // without the flow measure's intra-year seasonality.
    id: "issuance_long_share", pillar: "fiscal", label: "Long-dated share of conventional gilt stock", shortLabel: "Long share",
    unit: "%", weight: 0.10, risingIsBad: true, sourceId: "dmo",
    description: "Long / Ultra-Long conventional gilts as % of all conventional gilt stock (DMO D1A). Higher = more exposure to long-dated rate moves. Methodology note: the historical indicator was a flow-based annual issuance share; we switched to this stock-based measure in 2026-04 because the flow report is behind a ShieldSquare bot-check. The stock share captures the same structural signal without the flow measure's intra-year seasonality.",
    formatDisplay: fmtPct(1),
    provenance: "live",
    maxStaleMs: STALE_DAILY_MS,
    hasHistoricalSeries: false,
    historicalExclusionReason: "DMO D1A feed only exposes today's gilts-in-issue snapshot; archived stock composition is not machine-addressable, so historical values cannot be reconstructed from primary source.",
  },

  // Labour & Living (20%)
  inactivity_rate: {
    id: "inactivity_rate", pillar: "labour", label: "Economic inactivity rate, 16-64", shortLabel: "Inactivity",
    unit: "%", weight: 0.22, risingIsBad: true, sourceId: "ons_lms",
    description: "Share of 16-64 population neither in work nor looking for work.", formatDisplay: fmtPct(1),
    provenance: "live",
    maxStaleMs: STALE_ONS_LMS_MS,
  },
  inactivity_health: {
    id: "inactivity_health", pillar: "labour", label: "Health-related inactivity (m)", shortLabel: "Health inactive",
    unit: "m", weight: 0.18, risingIsBad: true, sourceId: "ons_lms",
    description: "Millions reporting long-term sickness as main reason for inactivity.", formatDisplay: fmtMillions,
    provenance: "live",
    maxStaleMs: STALE_ONS_LMS_MS,
  },
  unemployment: {
    id: "unemployment", pillar: "labour", label: "Unemployment rate, 16+", shortLabel: "Unemployment",
    unit: "%", weight: 0.10, risingIsBad: true, sourceId: "ons_lms",
    description: "ILO unemployment rate.", formatDisplay: fmtPct(1),
    provenance: "live",
    maxStaleMs: STALE_ONS_LMS_MS,
  },
  vacancies_per_unemployed: {
    id: "vacancies_per_unemployed", pillar: "labour", label: "Vacancies per unemployed person", shortLabel: "V/U",
    unit: "ratio", weight: 0.10, risingIsBad: false, sourceId: "ons_lms",
    description: "Tightness of the labour market; falling = slack.", formatDisplay: (v) => v.toFixed(2),
    provenance: "live",
    maxStaleMs: STALE_ONS_LMS_MS,
  },
  payroll_mom: {
    // Indicator ID preserved for DB continuity. The upstream CDID (K54L) is
    // the AWE whole-economy regular-pay index (seasonally adjusted, excl.
    // arrears), not a PAYE payroll-count series -- the earlier label was
    // incorrect. Scoring still works (baseline is the same series) but the
    // displayed unit/format now match what the number actually is.
    id: "payroll_mom", pillar: "labour", label: "AWE regular pay index", shortLabel: "Regular pay",
    unit: "index", weight: 0.10, risingIsBad: false, sourceId: "ons_rti",
    description: "Average Weekly Earnings -- whole economy regular-pay index (2015=100, SA, excl. arrears). Rising means earnings are growing.",
    formatDisplay: fmtIndex(1),
    provenance: "live",
    maxStaleMs: STALE_RTI_MONTHLY_MS,
  },
  real_regular_pay: {
    id: "real_regular_pay", pillar: "labour", label: "Real regular pay growth, YoY", shortLabel: "Real pay",
    unit: "%", weight: 0.10, risingIsBad: false, sourceId: "ons_lms",
    description: "CPIH-adjusted regular pay, year-on-year.", formatDisplay: fmtPct(1),
    provenance: "live",
    maxStaleMs: STALE_ONS_LMS_MS,
  },
  mortgage_2y_fix: {
    id: "mortgage_2y_fix", pillar: "labour", label: "Average 2y fixed mortgage rate", shortLabel: "2y fix",
    unit: "%", weight: 0.12, risingIsBad: true, sourceId: "moneyfacts",
    description: "UK average 2-year fixed-rate mortgage at 75% LTV.", formatDisplay: fmtPct(2),
    provenance: "live",
    maxStaleMs: STALE_DAILY_MS,
  },
  dd_failure_rate: {
    id: "dd_failure_rate", pillar: "labour", label: "Direct-debit failure rate", shortLabel: "DD failures",
    unit: "%", weight: 0.08, risingIsBad: true, sourceId: "ons_rti",
    description: "ONS real-time indicators -- share of direct debits failing.", formatDisplay: fmtPct(2),
    // ONS publishes this as an Excel indicator inside the RTI bundle, not as
    // a queryable timeseries; we mirror the headline figure into a fixture.
    provenance: "fixture",
    maxStaleMs: STALE_RTI_MONTHLY_MS,
  },

  // Growth Delivery (10%) -- inverted
  housing_trajectory: {
    id: "housing_trajectory", pillar: "delivery", label: "Net housing additions vs. trajectory", shortLabel: "Housing",
    unit: "%", weight: 0.25, risingIsBad: false, sourceId: "mhclg",
    description: "Latest net additions as % of OBR trajectory for the year.", formatDisplay: fmtPct(1),
    provenance: "fixture",
    maxStaleMs: STALE_MHCLG_QUARTERLY_MS,
  },
  planning_consents: {
    id: "planning_consents", pillar: "delivery", label: "Planning consents vs. baseline", shortLabel: "Consents",
    unit: "%", weight: 0.20, risingIsBad: false, sourceId: "mhclg",
    // The 2019 quarterly baseline (11,500) is an estimate reconstructed
    // from MHCLG's pre-COVID archives — the authoritative figure would
    // require manual PDF extraction, which is out of scope for the
    // current fixture. Surfaced in the description so the caveat ships
    // on /methodology next to the indicator.
    description: "Quarterly residential planning-decisions-granted as a % of a self-declared estimated 2019 pre-COVID quarterly baseline of 11,500. The denominator is an estimate — archived MHCLG PDFs can tighten it; the caveat is intentional and surfaced here.",
    formatDisplay: fmtPct(1),
    provenance: "fixture",
    maxStaleMs: STALE_MHCLG_QUARTERLY_MS,
  },
  new_towns_milestones: {
    id: "new_towns_milestones", pillar: "delivery", label: "New towns milestones hit", shortLabel: "New towns",
    unit: "%", weight: 0.15, risingIsBad: false, sourceId: "gov_uk",
    description: "Milestones hit as % of committed milestones YTD.", formatDisplay: fmtPct(1),
    hasHistoricalSeries: false,
    historicalExclusionReason: "Editorial judgement against published departmental milestones — backfilling a score for a prior date would invent an assessment that was never made at the time.",
    // Fixture-backed via deliveryMilestones adapter with a 90-day
    // freshness guard. The indicator remains "editorial" because the
    // score is still a judgement call against political commitments;
    // the adapter just ensures the figure refreshes on a quarterly beat.
    provenance: "editorial",
    maxStaleMs: STALE_MHCLG_QUARTERLY_MS,
  },
  bics_rollout: {
    id: "bics_rollout", pillar: "delivery", label: "BICS firms onboarded", shortLabel: "BICS",
    unit: "firms", weight: 0.15, risingIsBad: false, sourceId: "desnz",
    description: "Cumulative firms onboarded to the British Industrial Competitiveness Scheme.", formatDisplay: fmtCount,
    hasHistoricalSeries: false,
    historicalExclusionReason: "Editorial judgement against the BICS rollout plan — the cumulative-firms figure is published quarterly only; intra-quarter historical days would be fabricated.",
    provenance: "editorial",
    maxStaleMs: STALE_MHCLG_QUARTERLY_MS,
  },
  industrial_strategy: {
    id: "industrial_strategy", pillar: "delivery", label: "Industrial Strategy milestones", shortLabel: "Industrial",
    unit: "%", weight: 0.15, risingIsBad: false, sourceId: "dbt",
    description: "Industrial Strategy milestones on/ahead of schedule vs. slipped/missed.", formatDisplay: fmtPct(1),
    hasHistoricalSeries: false,
    historicalExclusionReason: "Editorial judgement against the Industrial Strategy commitments — historical days predate the current milestone list and cannot be scored against it retroactively.",
    provenance: "editorial",
    maxStaleMs: STALE_MHCLG_QUARTERLY_MS,
  },
  smr_programme: {
    id: "smr_programme", pillar: "delivery", label: "SMR fleet progress", shortLabel: "SMR",
    unit: "%", weight: 0.10, risingIsBad: false, sourceId: "gov_uk",
    description: "Small Modular Reactor programme progress against published milestones.", formatDisplay: fmtPct(1),
    hasHistoricalSeries: false,
    historicalExclusionReason: "Editorial judgement against the SMR programme plan — progress assessments are episodic ministerial statements, not a time-series.",
    provenance: "editorial",
    maxStaleMs: STALE_MHCLG_QUARTERLY_MS,
  },
};

export function indicatorsForPillar(pillar: PillarId): IndicatorDefinition[] {
  return Object.values(INDICATORS).filter((i) => i.pillar === pillar);
}

export interface DataSource {
  id: string;
  name: string;
  homepage: string;
  /** Machine-readable endpoint or RSS feed where appropriate. */
  endpoint?: string;
  notes?: string;
}

export const SOURCES: Record<string, DataSource> = {
  boe_yields: {
    id: "boe_yields", name: "Bank of England -- Statistical Database (gilt yields)",
    homepage: "https://www.bankofengland.co.uk/boeapps/database/",
    endpoint: "https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp",
  },
  boe_fx: {
    id: "boe_fx", name: "Bank of England -- Exchange rates",
    homepage: "https://www.bankofengland.co.uk/statistics/exchange-rates",
  },
  boe_breakevens: {
    id: "boe_breakevens", name: "Bank of England -- 5y breakeven inflation",
    homepage: "https://www.bankofengland.co.uk/boeapps/database/",
    endpoint: "https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp",
    notes: "Derived from the IADB CSV endpoint (IUDSNZC/IUDSIZC). Emits 5y breakeven inflation (nominal minus real).",
  },
  lseg: {
    id: "lseg", name: "LSEG -- FTSE 250",
    homepage: "https://www.londonstockexchange.com/indices/ftse-250",
  },
  lseg_housebuilders: {
    id: "lseg_housebuilders", name: "LSEG -- UK listed housebuilders (composite)",
    homepage: "https://www.londonstockexchange.com",
    notes: "Equal-weighted composite of Persimmon, Barratt Redrow, Taylor Wimpey, Berkeley, Vistry. No free daily bulk feed; data editorially curated from public last-close quotes. Licence: individual issuer closing prices are public domain; the composite calculation is ours.",
  },
  twelve_data_housebuilders: {
    id: "twelve_data_housebuilders", name: "Twelve Data -- UK housebuilder composite (deprecated)",
    homepage: "https://twelvedata.com",
    notes: "Deprecated: free tier does not support LSE equities (403). Replaced by eodhd_housebuilders.",
  },
  eodhd_housebuilders: {
    id: "eodhd_housebuilders", name: "EODHD -- UK housebuilder composite (daily EOD)",
    homepage: "https://eodhd.com",
    notes: "Equal-weighted composite of Persimmon, Barratt Redrow, Taylor Wimpey, Berkeley, Vistry via EODHD EOD API. Rebased to 100 at 2019 average. Free tier: 20 req/day (5 per fetch). Falls back to editorial fixture when API key is unset.",
  },
  eia_brent: {
    id: "eia_brent", name: "US EIA -- Europe Brent Spot Price (FOB)",
    homepage: "https://www.eia.gov/dnav/pet/hist/rbrted.htm",
    endpoint: "https://www.eia.gov/dnav/pet/hist_xls/RBRTEd.xls",
    notes: "EIA Open Data API requires a registration key; the canonical daily series is also available as XLS which is not parseable from a Cloudflare Worker. Fixture-backed, refreshed weekly from the public HTML table. Licence: EIA data is U.S. public domain.",
  },
  sp_global_pmi: {
    id: "sp_global_pmi", name: "S&P Global -- UK Services PMI",
    homepage: "https://www.pmi.spglobal.com/Public/Home/PressRelease",
    notes: "Headline Services PMI index. Press releases are public; the underlying series is licensed to S&P Global. We mirror only the monthly headline figure -- fair-dealing summary use.",
  },
  gfk_confidence: {
    id: "gfk_confidence", name: "GfK / NIESR -- Consumer Confidence Barometer",
    homepage: "https://www.niesr.ac.uk/our-work/consumer-confidence",
    notes: "Transferred from GfK to NIESR in 2025. Headline index published monthly as a press release; sub-indices are subscription-gated. Fixture-backed, headline-only.",
  },
  rics_rms: {
    id: "rics_rms", name: "RICS -- UK Residential Market Survey",
    homepage: "https://www.rics.org/news-insights/market-surveys/uk-residential-market-survey",
    notes: "Monthly residential survey. Headline balances in each month's press release are public; the full back-set is subscription-gated. Fixture-backed with the headline net price balance.",
  },
  obr_efo: {
    id: "obr_efo", name: "Office for Budget Responsibility -- Economic & Fiscal Outlook",
    homepage: "https://obr.uk/efo/",
  },
  ons_psf: {
    id: "ons_psf", name: "ONS -- Public Sector Finances",
    homepage: "https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance",
  },
  dmo: {
    id: "dmo", name: "UK Debt Management Office -- gilts in issue",
    homepage: "https://www.dmo.gov.uk/data/gilt-market/gilts-in-issue/",
    endpoint: "https://www.dmo.gov.uk/data/XmlDataReport?reportCode=D1A",
    notes: "Flat XML list of every outstanding gilt at the most recent close-of-business date (instrument type, maturity bracket, nominal + inflation-uplifted amount). Refreshes once per working day. Methodology note: `issuance_long_share` was originally a flow-based measure (planned annual issuance share); it is now stock-based (Long / Ultra-Long share of outstanding conventional gilt stock) because the flow report (D2.1E) is behind a ShieldSquare bot-check. The stock share captures the same structural signal without intra-year seasonality. The D1A feed exposes only today's snapshot, so both DMO indicators are excluded from historical backfill quorum; see the live-only disclosure on /methodology.",
  },
  ons_lms: {
    id: "ons_lms", name: "ONS -- Labour Market Statistics",
    homepage: "https://www.ons.gov.uk/employmentandlabourmarket",
  },
  ons_rti: {
    id: "ons_rti", name: "ONS -- Real-Time Indicators",
    homepage: "https://www.ons.gov.uk/peoplepopulationandcommunity/healthandsocialcare/conditionsanddiseases/datasets/realtimeindicatorsofuseconomicactivity",
  },
  moneyfacts: {
    id: "moneyfacts", name: "Moneyfacts -- UK Mortgage Rates",
    homepage: "https://moneyfacts.co.uk",
  },
  mhclg: {
    id: "mhclg", name: "MHCLG / DLUHC -- Housing Statistics",
    homepage: "https://www.gov.uk/government/organisations/ministry-of-housing-communities-local-government",
  },
  gov_uk: {
    id: "gov_uk", name: "gov.uk -- Announcements RSS",
    homepage: "https://www.gov.uk/search/news-and-communications.atom",
  },
  desnz: {
    id: "desnz", name: "Department for Energy Security and Net Zero",
    homepage: "https://www.gov.uk/government/organisations/department-for-energy-security-and-net-zero",
  },
  dbt: {
    id: "dbt", name: "Department for Business and Trade",
    homepage: "https://www.gov.uk/government/organisations/department-for-business-and-trade",
  },
  ifs: {
    id: "ifs", name: "Institute for Fiscal Studies",
    homepage: "https://ifs.org.uk",
  },
  resolution_foundation: {
    id: "resolution_foundation", name: "Resolution Foundation",
    homepage: "https://www.resolutionfoundation.org",
  },
  ifg: {
    id: "ifg", name: "Institute for Government",
    homepage: "https://www.instituteforgovernment.org.uk",
  },
};

/** Nominal 90-day sparkline length. */
export const SPARK_POINTS_90D = 90;
/** Short sparkline used in pillar tiles and today cards. */
export const SPARK_POINTS_30D = 30;

/** Reference baseline window used by the methodology ECDF. */
export const BASELINE_START_ISO: string = "2019-01-01T00:00:00Z";
/** COVID outlier window to exclude from baseline. */
export const COVID_EXCLUDE_START_ISO: string = "2020-04-01T00:00:00Z";
export const COVID_EXCLUDE_END_ISO: string = "2020-06-30T23:59:59Z";
