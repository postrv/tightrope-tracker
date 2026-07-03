import type { CaptureSpec } from "../types";

/**
 * Registry of AI-curated sources. Adding a source = adding a spec here plus
 * (if it feeds a new indicator) the usual registry entries in
 * packages/shared/src/indicators.ts.
 *
 * `sp_global_pmi` is the reference spec — fully parameterised. The
 * remaining entries carry their Appendix-A parameters (docs/AUTOMATION_PLAN.md)
 * and TODO markers where discovery/extraction details need to be pinned
 * down during implementation.
 *
 * Prompt text lives with the spec consumer (pipeline/extract.ts) keyed by
 * sourceId + promptVersion; bump promptVersion on any prompt change so
 * capture rows remain interpretable.
 */

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const CAPTURE_SPECS: CaptureSpec[] = [
  {
    // Reference implementation: monthly numeric print, HTML press release,
    // auto-publish eligible after shadow-mode sign-off (Phase 5).
    sourceId: "sp_global_pmi",
    kind: "observation",
    indicatorIds: ["services_pmi"],
    // Discovery page listing recent releases; the extractor receives the
    // release matching "UK Services PMI" with the latest FINAL print.
    // TODO: pin the exact discovery URL + the follow-link heuristic during
    // implementation (the press-release index is stable; individual release
    // URLs are per-month).
    urls: ["https://www.pmi.spglobal.com/Public/Release/PressReleases"],
    format: "html",
    cadence: "monthly",
    plausibility: {
      services_pmi: { min: 35, max: 70, maxDelta: 8 },
    },
    agreementTolerance: 0.05,
    allowAutoPublish: false, // flip per Phase 5 rollout, never before shadow sign-off
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    sourceId: "gfk_confidence",
    kind: "observation",
    indicatorIds: ["consumer_confidence"],
    urls: ["TODO: GfK/NIQ UK consumer confidence barometer press page"],
    format: "pdf",
    cadence: "monthly",
    plausibility: {
      consumer_confidence: { min: -55, max: 10, maxDelta: 10 },
    },
    agreementTolerance: 0.5,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    sourceId: "rics_rms",
    kind: "observation",
    indicatorIds: ["rics_price_balance"],
    urls: ["TODO: RICS UK Residential Market Survey publication page"],
    format: "pdf",
    cadence: "monthly",
    plausibility: {
      rics_price_balance: { min: -80, max: 80, maxDelta: 25 },
    },
    agreementTolerance: 1,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    // Extract from the HTML statistical release, NOT the ODS attachments.
    // Apply the derivation formulas documented at the top of
    // packages/data-sources/src/fixtures/housing-history.json.
    sourceId: "mhclg_housing",
    kind: "observation",
    indicatorIds: ["housing_trajectory", "planning_consents"],
    urls: [
      "TODO: gov.uk housing-supply statistical release page",
      "TODO: gov.uk planning live-tables release page",
    ],
    format: "html",
    cadence: "quarterly",
    plausibility: {
      // TODO: derive bounds from the fixture back-series (±30% per release).
      housing_trajectory: { min: 0, max: 0, maxDelta: 0 },
      planning_consents: { min: 0, max: 0, maxDelta: 0 },
    },
    agreementTolerance: 0.01,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    // Event-driven (daily hash poll catches the publication). NEVER
    // auto-publish: twice-yearly, high-stakes — always human-reviewed.
    sourceId: "obr_efo",
    kind: "observation",
    indicatorIds: ["cb_headroom", "psnfl_trajectory"],
    urls: ["https://obr.uk/efo/"],
    format: "html",
    cadence: "event",
    plausibility: {
      cb_headroom: { min: -20, max: 60, maxDelta: 30 },
      // TODO: psnfl_trajectory bounds from the existing fixture vintages.
      psnfl_trajectory: { min: 0, max: 0, maxDelta: 0 },
    },
    agreementTolerance: 0.1,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  {
    sourceId: "ons_dd_failure",
    kind: "observation",
    indicatorIds: ["dd_failure_rate"],
    urls: ["TODO: upstream per the _comment in fixtures/ons-rti.json"],
    format: "html",
    cadence: "monthly",
    plausibility: {
      dd_failure_rate: { min: 0.3, max: 3.0, maxDelta: 0.4 },
    },
    agreementTolerance: 0.02,
    allowAutoPublish: false,
    modelId: DEFAULT_MODEL,
    promptVersion: "v1",
  },
  // --- Editorial kinds: drafts only, never auto-published -----------------
  // TODO(implementation): specs for
  //   delivery_milestones   (kind "delivery_milestone", 4 indicators,
  //                          dept-filtered gov.uk announcements)
  //   delivery_commitments  (kind "delivery_commitment", drafts field
  //                          patches for the /api/v1/delivery scorecard)
  //   timeline_triage       (kind "timeline_event", consumes the gov.uk
  //                          Atom candidates rerouted by AUTOMATION_PLAN 1.4)
  // For these, `plausibility` is empty, allowAutoPublish is ignored by the
  // decide stage (editorial kinds always land in the review queue), and the
  // extraction prompt asks for a cited draft rather than numeric values.
];
