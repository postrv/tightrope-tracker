import { PLAUSIBILITY, deriveHousingTrajectory, derivePlanningConsents } from "@tightrope/shared";
import type { CaptureSpec, EffectivePlausibility } from "../types";

/**
 * Registry of AI-curated sources. Adding a source = adding a spec here plus
 * (if it feeds a new indicator) the usual registry entries in
 * packages/shared/src/indicators.ts.
 *
 * Prompt text lives with the spec consumer (pipeline/prompts.ts) keyed by
 * sourceId + promptVersion; bump promptVersion on any prompt change so capture
 * rows remain interpretable.
 *
 * PLAUSIBILITY DERIVATION. A spec declares ONLY `maxDelta` per indicator (the
 * per-RELEASE cap used by gate G4). The hard G3 range (`min`/`max`) is DERIVED
 * from the authoritative per-indicator bounds in packages/shared/src/
 * plausibility.ts via `effectivePlausibility` below — the same table the ingest
 * quarantine gate uses — so the curator G3 gate and the ingest write gate
 * cannot structurally diverge (there is no second copy to drift). A spec MAY
 * carry an explicit `min`/`max` override for the rare case it needs a tighter
 * bound than the shared table, but none do today. `maxDelta` is the inverse of
 * how plausibility.ts derived its per-DAY rate, i.e. maxDelta ≈ maxJumpPerDay ×
 * cadencePeriodDays ÷ 2 (equivalently the Appendix-A per-release Δ). Documented
 * per spec below.
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
    //
    // 5024 ROOT CAUSE (2026-07-07): this page's htmlToText is ~40KB, which
    // overwhelmed JSON-schema mode → "5024: JSON Model couldn't be met". The
    // headline number IS on the landing page (verified from residential egress:
    // "Services PMI in the United Kingdom decreased to 48.80 points in June from
    // 49.30 points in May of 2026"), so no follow-link is needed — the
    // capture-stage truncation-to-budget (lib/artefactText.ts) is the fix.
    sourceId: "sp_global_pmi",
    kind: "observation",
    indicatorIds: ["services_pmi"],
    urls: ["https://tradingeconomics.com/united-kingdom/services-pmi"],
    format: "html",
    cadence: "monthly",
    plausibility: {
      // range derived from shared PLAUSIBILITY services_pmi [30,72]; Appendix A Δ≤8.
      services_pmi: { maxDelta: 8 },
    },
    agreementTolerance: 0.5,
    allowAutoPublish: false, // flip per Phase 5 rollout, never before shadow sign-off
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
    // ANCHOR (2026-07-12): the TE page embeds dynamic modules (news feed,
    // calendar rows), so its content hash churns on every fetch and EVERY
    // poll re-extracts — each run re-rolls the 5024 dice on however the
    // churn lands in the truncation window (succeeded 17:05Z and 17:17Z,
    // failed 17:31Z, same day same page). The headline sentence always
    // contains "services pmi"; anchoring pins it in the window regardless
    // of how the surrounding modules shift.
    anchorTerms: ["services pmi"],
  },
  {
    // GfK's UK consumer-confidence business moved to NIQ (NielsenIQ). The
    // barometer landing page carries a "Latest press releases" list linking each
    // month's article, newest first. FOLLOW-LINK (implemented 2026-07-07): the
    // headline index sits in the linked article, not the landing page, so
    // `discover` fetches the landing page and follows to the newest
    // /news-center/YYYY/consumer-confidence-* article. Verified from residential
    // egress: the June article states "Overall Index Score was unchanged at -23
    // in June." Stays review-only until shadow sign-off.
    sourceId: "gfk_confidence",
    kind: "observation",
    indicatorIds: ["consumer_confidence"],
    urls: ["https://nielseniq.com/global/en/landing-page/consumer-confidence-barometer/"],
    format: "html",
    discover: {
      // The landing page lists articles newest-first; take the first match.
      linkPattern: "/news-center/\\d{4}/consumer-confidence-",
      newest: "first",
    },
    cadence: "monthly",
    plausibility: {
      // range derived from shared PLAUSIBILITY consumer_confidence [-60,10]; Appendix A Δ≤10.
      consumer_confidence: { maxDelta: 10 },
    },
    agreementTolerance: 0.5,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  // RICS UK Residential Market Survey — DISABLED 2026-07-07 (removed from the
  // sweep set). The rics.org site is behind Imperva/Incapsula bot protection:
  // both the canonical survey page and a browser-UA retry return only a
  // ~200–840-byte JS challenge stub (no article text), verified from residential
  // egress AND with a full Chrome UA + Accept headers. A GitHub Actions runner
  // (datacenter ASN) is challenged at least as hard, so `fetchVia:"relay"` would
  // not help either — there is no server-side-fetchable route to the
  // house-price-balance headline. `rics_price_balance` therefore stays on the
  // hand-refresh fixture path (docs/RUNBOOK.md §7.5; growth-sentiment trio in
  // Phase 0). Re-enable if RICS drops the challenge or publishes a plain-fetch
  // release mirror. See docs/SOURCES.md.
  {
    // gov.uk collection pages for the two quarterly MHCLG releases (both HTTP
    // 200, not bot-protected). Apply the derivation formulas at the top of
    // packages/data-sources/src/fixtures/housing-history.json. FOLLOW-LINK
    // (implemented 2026-07-07): each collection page lists quarterly releases
    // newest-first; `discover` follows to the newest housing-supply /
    // planning-applications release page (HTML, NOT the ODS attachments), where
    // the completions / decisions-granted figures live. The single combined
    // linkPattern matches whichever release family a given collection page
    // carries. Newest chosen by year+quarter. Verified from residential egress:
    // the newest links are housing-supply-…-january-to-march-2026 and
    // planning-applications-in-england-january-to-march-2026. Stays review-only
    // (the plan's "tight G4" intent is the Δ≤30% cap below).
    // DISABLED 2026-07-07 (SOURCES.md "Disabled capture specs"): rics.org sits
    // behind Imperva/Incapsula bot protection — a server-side fetch gets only a
    // ~200–840-byte JS challenge stub (no article text), verified from
    // residential egress and with full browser headers. A GitHub Actions runner
    // (datacenter ASN) is challenged at least as hard, so `fetchVia:"relay"`
    // cannot reach it either. `rics_price_balance` stays on the hand-refresh
    // fixture path (growth-sentiment.json; RUNBOOK §7.5). The spec was
    // initially DELETED, which left its final 'failure' audit row as the
    // latest attempt forever → the >1h source-health alert re-fired every 6h
    // for a source nothing polls. Re-added with `disabled` (2026-07-12) so the
    // sweep records an honest skip instead. Re-enable (drop `disabled`) if
    // RICS lifts the challenge or ships a plain-fetch release mirror.
    sourceId: "rics_rms",
    kind: "observation",
    indicatorIds: ["rics_price_balance"],
    urls: ["https://www.rics.org/news-insights/market-surveys/uk-residential-market-survey"],
    format: "html",
    cadence: "monthly",
    plausibility: {
      // range derived from shared PLAUSIBILITY rics_price_balance [-90,90]; Appendix A Δ≤25.
      rics_price_balance: { maxDelta: 25 },
    },
    agreementTolerance: 1,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
    disabled: "rics.org Imperva bot challenge blocks all non-residential egress (verified 2026-07-07); hand-refresh fixture path owns rics_price_balance",
  },
  {
    sourceId: "mhclg_housing",
    kind: "observation",
    indicatorIds: ["housing_trajectory", "planning_consents"],
    urls: [
      "https://www.gov.uk/government/collections/house-building-statistics",
      "https://www.gov.uk/government/collections/planning-applications-statistics",
    ],
    format: "html",
    discover: {
      // Hop 1: collection page → newest quarterly release page.
      linkPattern:
        "/government/statistics/(housing-supply-indicators-of-new-supply-england|planning-applications-in-england)-(january-to-march|april-to-june|july-to-september|october-to-december)-20\\d{2}",
      newest: "quarter",
      // Hop 2: release page → the FULL HTML statistical-release document (the
      // self-nested /…/…/…-<same slug> child), where the headline figures are
      // inlined. The release page itself only lists ODS attachments + a summary;
      // the `…$` anchor excludes the "-technical-notes" sibling, and requiring a
      // second path segment (statistics/<release>/<doc>) excludes the release
      // self-link. Verified from residential egress: the housing doc inlines
      // "199,500 net additional homes … between 1 April 2025 and 31 March 2026".
      then: {
        // Housing names the full doc with the bare slug repeated
        // (…january-to-march-2026); planning suffixes it "-statistical-release".
        // Match either, but NOT the "-technical-notes" sibling.
        linkPattern:
          "/government/statistics/[a-z0-9-]+/(housing-supply-indicators-of-new-supply-england|planning-applications-in-england)-(january-to-march|april-to-june|july-to-september|october-to-december)-20\\d{2}(-statistical-release)?$",
        newest: "first",
      },
    },
    cadence: "quarterly",
    plausibility: {
      // range derived from shared PLAUSIBILITY housing_trajectory [0,150]; Appendix A Δ≤30%.
      housing_trajectory: { maxDelta: 30 },
      // range derived from shared PLAUSIBILITY planning_consents [0,200]; maxDelta ≈ 1.0/day × 92 ÷ 2.
      planning_consents: { maxDelta: 46 },
    },
    agreementTolerance: 0.5,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    // v2 (2026-07-12): the brief now lists raw components instead of the
    // derived indicators, plus the do-not-sum instruction block.
    promptVersion: "v2",
    // 5024 MITIGATION (2026-07-12): the artefact is the FULL statistical-
    // release doc for BOTH collections. Anchors keep the component sentences
    // in the truncation window (the same fix that cleared obr_efo and
    // ons_dd_failure) — including the COMBINED-text truncation in capture.ts,
    // which silently dropped the whole planning section until 2026-07-12.
    // "net additional" was deliberately DROPPED when the spec went derived —
    // the annual net-additional-dwellings figure is now an explicit
    // anti-target (completions is the chosen raw series). Terms are tuned
    // against the 2026 Q1 releases' actual phrasing ("The number of
    // dwellings completed was 37,170 (seasonally adjusted)" / "granted 6,700
    // residential applications, down 5%…") AND against anchor-tier crowding:
    // broad terms like "completions" / "seasonally adjusted" match dozens of
    // housing-section lines, which fill the 8k shrink window in document
    // order before the planning section's lines get a turn — verified
    // offline that this set keeps BOTH headline sentences in the 20k and 8k
    // windows.
    anchorTerms: ["dwellings completed", "residential applications", "granted"],
    // DERIVED INDICATORS (re-enabled 2026-07-12, promptVersion v2). Both
    // indicators are ratios the releases never print — asking the model for
    // them directly forced refusal (the 07-08..12 5024 storm) or fabrication
    // (the spec's only two pre-derive "successes", capture ids 25/26,
    // recorded invented 95 / 120 at confidence 0.3). The spec now extracts
    // the RAW printed figures and computes the published values with the
    // shared formulas (packages/shared/src/derivations.ts, drift-guarded
    // against the hand-maintained fixtures):
    //   housing_trajectory = completions_sa × 4 ÷ 300,000 × 100
    //   planning_consents  = residential decisions granted ÷ 11,500 × 100
    // (The release prints the residential-granted TOTAL as one quotable
    // bullet — verified 2026 Q1: "granted 6,700 residential applications" —
    // so planning_consents is a single-component derivation. The fixture
    // note's major+minor breakdown comes from the release's tables, not a
    // quotable sentence; multi-component sums remain supported by the derive
    // machinery and covered by tests for the day a release only prints a
    // breakdown.)
    // Gate G1 anchors every component's verbatim quote; G2–G6 run on the
    // derived scale. EXPECTED on any run while the current quarter is
    // already published from the fixture path: G1–G5 pass, G6 FAIL ("not
    // newer than published") — correct behaviour, not a bug; the real
    // end-to-end test is the next MHCLG quarterly release (~Sept 2026).
    // CONTINGENCY if 5024s persist despite component extraction: split into
    // two specs (mhclg_housing_supply / mhclg_planning) — halves the
    // artefact and decouples the two collections' publication lag.
    derive: {
      housing_trajectory: {
        components: [
          {
            key: "completions_sa_quarterly",
            label: "New-build dwelling completions, seasonally adjusted, latest quarter (England)",
            unit: "dwellings",
            description:
              "The seasonally adjusted count of new-build dwellings completed in the latest quarter, e.g. 'The number of dwellings completed was 37,170 (seasonally adjusted)'. NOT the annualised figure, NOT the annual 'net additional dwellings' total, NOT starts.",
            // Fail-fast sanity, not the safety layer (G3 on the derived scale
            // owns that): max 100k sits BELOW the ×4-annualised range, so an
            // annualised misread trips here, component-named, before the G5
            // AI spend. Quarterly SA completions have never approached 100k.
            min: 5_000,
            max: 100_000,
          },
        ],
        compute: (v) => deriveHousingTrajectory(v.completions_sa_quarterly!),
      },
      planning_consents: {
        components: [
          {
            key: "residential_decisions_granted",
            label: "Residential planning applications granted in the quarter (England, district level)",
            unit: "decisions",
            description:
              "The printed count of residential applications granted by district level planning authorities in the quarter, e.g. 'granted 6,700 residential applications, down 5% from the same quarter a year earlier'. The QUARTERLY figure, NOT the year-ending total.",
            min: 1_000,
            max: 40_000,
          },
        ],
        compute: (v) => derivePlanningConsents(v.residential_decisions_granted!),
      },
    },
  },
  {
    // Event-driven. NEVER auto-publish: twice-yearly, high-stakes — always
    // human-reviewed, so G4 is advisory here.
    //
    // RELAY, MANUAL LEG (2026-07-08): obr.uk sits behind Cloudflare bot
    // management, which 403s BOTH Cloudflare Workers egress AND GitHub/Azure
    // runner IPs — the 2026-07-07 assumption that runners could reach it was
    // verified only from residential egress and failed on the first scheduled
    // runs. Only an operator machine (residential IP) can fetch it, so
    // `relayRunner:"manual"`: the scheduled workflow skips this spec, and on
    // EFO publication day (twice a year, March + autumn) an operator runs
    //   `CURATOR_ADMIN_TOKEN=... node --import tsx scripts/relay-artefacts.mjs --spec=obr_efo`.
    // FOLLOW-LINK (shared discover.ts): obr.uk/efo lists the EFO documents;
    // discovery follows to the newest exec-summary PDF download, which the
    // Worker converts via AI.toMarkdown.
    sourceId: "obr_efo",
    kind: "observation",
    indicatorIds: ["cb_headroom", "psnfl_trajectory"],
    urls: ["https://obr.uk/efo/"],
    format: "html",
    fetchVia: "relay",
    relayRunner: "manual",
    // The full EFO PDF's front matter (contents, charts index) is digit-dense
    // enough to flood the model window before the headroom sentence appears
    // mid-document (2026-07-08: the first relayed extraction returned no
    // values). Anchor the lines that state the two figures.
    anchorTerms: ["headroom", "net financial liabilities", "psnfl"],
    discover: {
      linkPattern: "obr\\.uk/download/economic-and-fiscal-outlook-[a-z]+-20\\d{2}",
      newest: "year",
      releaseFormat: "pdf",
    },
    cadence: "event",
    plausibility: {
      // range derived from shared PLAUSIBILITY cb_headroom [-30,80]; vintage step ~14 → maxDelta 30 (generous).
      cb_headroom: { maxDelta: 30 },
      // range derived from shared PLAUSIBILITY psnfl_trajectory [-5,5]; sub-pp vintage steps → maxDelta 1.0 (advisory; never auto-published).
      psnfl_trajectory: { maxDelta: 1 },
    },
    agreementTolerance: 0.1,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    // ONS "Monthly Direct Debit failure rate" dataset page (the upstream cited
    // in fixtures/ons-rti.json's _comment).
    //
    // RELAY + XLSX (2026-07-07): the figure is XLSX-ONLY. Verified from
    // residential egress that neither the dataset landing HTML nor the ONS APIs
    // state it — the page `/data` JSON is metadata-only, and the beta dataset
    // API 404s for this "statistics in development" series. The value lives
    // solely in the monthly workbook. So `fetchVia:"relay"`: the runner
    // discovers the newest ...dataset<ddmmyy>.xlsx link and POSTs the workbook;
    // the Worker converts it to markdown via AI.toMarkdown (the sanctioned
    // doc-conversion path — no hand-rolled xlsx parsing, no new deps). Review-
    // only until a shadow sign-off (toMarkdown-on-xlsx not verifiable off-Worker;
    // the fixture refresh path in RUNBOOK §7.5 remains the fallback).
    sourceId: "ons_dd_failure",
    kind: "observation",
    indicatorIds: ["dd_failure_rate"],
    urls: [
      "https://www.ons.gov.uk/economy/economicoutputandproductivity/output/datasets/monthlydirectdebitfailurerateandaveragetransactionamount",
    ],
    format: "html",
    fetchVia: "relay",
    discover: {
      linkPattern: "directdebittransactionsandfailuresdataset\\d+\\.xlsx",
      newest: "first",
      releaseFormat: "xlsx",
    },
    // Workbook rows are uniformly digit-dense; anchor the sheet rows that
    // carry the target series so tail-fill starts from them.
    anchorTerms: ["failure rate"],
    cadence: "monthly",
    plausibility: {
      // range derived from shared PLAUSIBILITY dd_failure_rate [0,5]; Appendix A Δ≤0.4.
      dd_failure_rate: { maxDelta: 0.4 },
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

/**
 * Resolve the effective G3 range + G4 maxDelta a spec applies for one indicator.
 * The `min`/`max` come from the shared `PLAUSIBILITY` table (single source of
 * truth) unless the spec carries an explicit tighter override; `maxDelta` is
 * always the spec's local value. Returns `undefined` when the spec does not
 * gate this indicator or no shared bound exists (verify.ts treats that as
 * "no range configured" — G3 passes open, matching the ingest gate philosophy).
 */
export function effectivePlausibility(spec: CaptureSpec, indicatorId: string): EffectivePlausibility | undefined {
  const local = spec.plausibility[indicatorId];
  if (!local) return undefined;
  const shared = PLAUSIBILITY[indicatorId];
  const min = local.min ?? shared?.min;
  const max = local.max ?? shared?.max;
  if (min === undefined || max === undefined) return undefined;
  return { min, max, maxDelta: local.maxDelta };
}
