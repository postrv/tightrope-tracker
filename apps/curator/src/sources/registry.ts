import type { CaptureSpec } from "../types";

/**
 * Registry of AI-curated sources. Adding a source = adding a spec here plus
 * (if it feeds a new indicator) the usual registry entries in
 * packages/shared/src/indicators.ts.
 *
 * Prompt text lives with the spec consumer (pipeline/prompts.ts) keyed by
 * sourceId + promptVersion; bump promptVersion on any prompt change so capture
 * rows remain interpretable.
 *
 * PLAUSIBILITY DERIVATION. Each spec's `min`/`max` mirror the authoritative
 * per-indicator bounds in packages/shared/src/plausibility.ts (the same table
 * the ingest quarantine gate uses), so the curator G3 gate and the ingest
 * write gate can never silently diverge. `maxDelta` is the per-RELEASE cap used
 * by gate G4; it is the inverse of how plausibility.ts derived its per-DAY
 * rate, i.e. maxDelta ≈ maxJumpPerDay × cadencePeriodDays ÷ 2 (equivalently the
 * Appendix-A per-release Δ). Documented per spec below.
 *
 * DISCOVERY / FOLLOW-LINK CAVEAT. Several upstreams print the headline number
 * on a page the fetcher must follow to (a per-month release, a PDF, or an xlsx
 * preview) rather than on the landing/collection page. The fetch layer takes a
 * fixed URL list and hands the whole artefact to the model — it does not yet
 * follow links — so these specs stay allowAutoPublish=false and lean on the
 * shadow-mode review queue until a per-source discovery step is added. Each
 * such case is noted honestly on its spec. This is the intended shadow-rollout
 * tuning surface, not a silent gap.
 */

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** gov.uk site-wide announcements Atom feed (the govUkRss adapter's source). */
const GOV_UK_ANNOUNCEMENTS = "https://www.gov.uk/search/news-and-communications.atom";

export const CAPTURE_SPECS: CaptureSpec[] = [
  {
    // Reference implementation: monthly numeric print, HTML press release,
    // auto-publish eligible after shadow-mode sign-off (Phase 5).
    //
    // DISCOVERY: the canonical S&P Global press-release index
    // (https://www.pmi.spglobal.com/Public/Release/PressReleases) and its
    // per-release pages return HTTP 403 to a plain server-side fetch (opaque
    // hex release ids, no date-derivable pattern) — confirmed 2026-07-03, and
    // Wave 1 hit the same block. Operational fallback: the Trading Economics
    // UK Services PMI page, an aggregator that carries the final headline +
    // revision + release date and serves server-side fetches. Cite it as a
    // MIRROR of the S&P figure, never as the primary source.
    sourceId: "sp_global_pmi",
    kind: "observation",
    indicatorIds: ["services_pmi"],
    urls: ["https://tradingeconomics.com/united-kingdom/services-pmi"],
    format: "html",
    cadence: "monthly",
    plausibility: {
      // plausibility.ts services_pmi [30,72]; Appendix A Δ≤8 (8/30×2≈0.53→0.6/day).
      services_pmi: { min: 30, max: 72, maxDelta: 8 },
    },
    agreementTolerance: 0.5,
    allowAutoPublish: false, // flip per Phase 5 rollout, never before shadow sign-off
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    // GfK's UK consumer-confidence business moved to NIQ (NielsenIQ). The
    // barometer landing page carries a "Latest press releases" list linking each
    // month's article (slug encodes the number/month, e.g.
    // /news-center/2026/consumer-confidence-stay-at-23-in-june/). HTML, serves
    // server-side fetches. FOLLOW-LINK: the headline index sits in the linked
    // article, not the landing page — review path until a follow step lands.
    sourceId: "gfk_confidence",
    kind: "observation",
    indicatorIds: ["consumer_confidence"],
    urls: ["https://nielseniq.com/global/en/landing-page/consumer-confidence-barometer/"],
    format: "html",
    cadence: "monthly",
    plausibility: {
      // plausibility.ts consumer_confidence [-60,10]; Appendix A Δ≤10.
      consumer_confidence: { min: -60, max: 10, maxDelta: 10 },
    },
    agreementTolerance: 0.5,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    // RICS UK Residential Market Survey landing page lists every monthly
    // release; serves server-side fetches. FOLLOW-LINK: the house-price-balance
    // headline lives inside the monthly PDF (filename casing varies month to
    // month, so it must be discovered from the landing page rather than
    // constructed) — review path until a PDF follow step lands.
    sourceId: "rics_rms",
    kind: "observation",
    indicatorIds: ["rics_price_balance"],
    urls: ["https://www.rics.org/news-insights/market-surveys/uk-residential-market-survey"],
    format: "html",
    cadence: "monthly",
    plausibility: {
      // plausibility.ts rics_price_balance [-90,90]; Appendix A Δ≤25.
      rics_price_balance: { min: -90, max: 90, maxDelta: 25 },
    },
    agreementTolerance: 1,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    // gov.uk collection pages for the two quarterly MHCLG releases (both HTTP
    // 200, not bot-protected). Apply the derivation formulas at the top of
    // packages/data-sources/src/fixtures/housing-history.json. FOLLOW-LINK: a
    // collection page lists releases; the completions / decisions-granted
    // figures live on the individual quarterly release page it links to — HTML,
    // NOT the ODS attachments — so this stays review-only until a follow step
    // lands. (The plan's "tight G4" intent is captured by the Δ≤30% cap below.)
    sourceId: "mhclg_housing",
    kind: "observation",
    indicatorIds: ["housing_trajectory", "planning_consents"],
    urls: [
      "https://www.gov.uk/government/collections/house-building-statistics",
      "https://www.gov.uk/government/collections/planning-applications-statistics",
    ],
    format: "html",
    cadence: "quarterly",
    plausibility: {
      // plausibility.ts housing_trajectory [0,150]; Appendix A Δ≤30% (30/92×2≈0.65→0.7/day).
      housing_trajectory: { min: 0, max: 150, maxDelta: 30 },
      // plausibility.ts planning_consents [0,200]; maxDelta = 1.0/day × 92 ÷ 2 ≈ 46.
      planning_consents: { min: 0, max: 200, maxDelta: 46 },
    },
    agreementTolerance: 0.5,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    // Event-driven (daily hash poll catches the publication). NEVER
    // auto-publish: twice-yearly, high-stakes — always human-reviewed, so G4 is
    // advisory here. FOLLOW-LINK: obr.uk/efo lists the EFO documents; the
    // headroom / PSNFL figures are in the linked exec-summary PDF.
    sourceId: "obr_efo",
    kind: "observation",
    indicatorIds: ["cb_headroom", "psnfl_trajectory"],
    urls: ["https://obr.uk/efo/"],
    format: "html",
    cadence: "event",
    plausibility: {
      // plausibility.ts cb_headroom [-30,80]; a real vintage step ~14 → maxDelta 30 (generous).
      cb_headroom: { min: -30, max: 80, maxDelta: 30 },
      // plausibility.ts psnfl_trajectory [-5,5]; sub-pp vintage steps → maxDelta 1.0 (advisory; never auto-published).
      psnfl_trajectory: { min: -5, max: 5, maxDelta: 1 },
    },
    agreementTolerance: 0.1,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    // ONS "Monthly Direct Debit failure rate" dataset page (the upstream cited
    // in fixtures/ons-rti.json's _comment). HTML article/dataset landing; the
    // headline Total-NSA % is in the page + the linked xlsx. Extract from the
    // HTML — do NOT parse the xlsx in the worker (AUTOMATION_PLAN Phase 3).
    sourceId: "ons_dd_failure",
    kind: "observation",
    indicatorIds: ["dd_failure_rate"],
    urls: [
      "https://www.ons.gov.uk/economy/economicoutputandproductivity/output/datasets/monthlydirectdebitfailurerateandaveragetransactionamount",
    ],
    format: "html",
    cadence: "monthly",
    plausibility: {
      // plausibility.ts dd_failure_rate [0,5]; Appendix A Δ≤0.4.
      dd_failure_rate: { min: 0, max: 5, maxDelta: 0.4 },
    },
    agreementTolerance: 0.05,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  // --- Editorial kinds: drafts only, never auto-published -----------------
  {
    // Editorial re-assessment of the four delivery-milestone indicators from
    // departmental announcements. Fetches the gov.uk announcements Atom feed;
    // the department filter is the govUkRss adapter's DELIVERY_DEPARTMENTS set
    // (exported from @tightrope/data-sources) — the same slugs the timeline
    // triage applies. Drafts a cited assessment per indicator for human review.
    sourceId: "delivery_milestones",
    kind: "delivery_milestone",
    indicatorIds: ["new_towns_milestones", "bics_rollout", "industrial_strategy", "smr_programme"],
    urls: [GOV_UK_ANNOUNCEMENTS],
    format: "atom",
    cadence: "event",
    plausibility: {},
    agreementTolerance: 1,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    // Editorial field-patch drafts for the /api/v1/delivery scorecard, from the
    // same monitoring stream. Approval POSTs to the ingest admin
    // /admin/delivery-commitment endpoint (AUTOMATION_PLAN 1.3). indicatorIds
    // empty: commitments are scorecard rows, not scored indicators.
    sourceId: "delivery_commitments",
    kind: "delivery_commitment",
    indicatorIds: [],
    urls: [GOV_UK_ANNOUNCEMENTS],
    format: "atom",
    cadence: "event",
    plausibility: {},
    agreementTolerance: 1,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    // Timeline triage. SPECIAL: consumes the gov.uk Atom candidates the ingest
    // worker stages into curator_captures (AUTOMATION_PLAN 1.4) — it does NOT
    // fetch a URL (urls is empty; the sweep short-circuits on this sourceId).
    // Runs an AI relevance pass: immaterial candidates are auto-rejected,
    // material ones enriched with a cited draft and left pending for a human.
    sourceId: "timeline_triage",
    kind: "timeline_event",
    indicatorIds: [],
    urls: [],
    format: "atom",
    cadence: "event",
    plausibility: {},
    agreementTolerance: 1,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
];
