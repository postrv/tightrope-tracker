/**
 * Core types for the capture → extract → verify → publish pipeline.
 * Mirrors the `curator_captures` schema (db/migrations/0011) and the
 * contracts in docs/AUTOMATION_PLAN.md Phase 3.
 */

export type CaptureKind =
  | "observation"
  | "delivery_milestone"
  | "delivery_commitment"
  | "timeline_event";

/**
 * The editorial capture kinds — drafts that ALWAYS await human approval and are
 * never auto-published (AUTOMATION_PLAN Phase 3, rule 3). Single source of
 * truth: every pipeline stage that needs to branch editorial-vs-observation
 * imports `isEditorialKind` rather than re-declaring its own set (which is how
 * the five copies drifted apart before).
 */
export const EDITORIAL_KINDS: ReadonlySet<CaptureKind> = new Set<CaptureKind>([
  "delivery_milestone",
  "delivery_commitment",
  "timeline_event",
]);

/** True when a capture kind is editorial (never auto-publishable). */
export function isEditorialKind(kind: CaptureKind): boolean {
  return EDITORIAL_KINDS.has(kind);
}

/**
 * Every persisted / query-able `curator_captures.status` — the single source of
 * truth for both the `CaptureStatus` union and the admin surface's
 * `VALID_STATUSES`. Kept in lock-step with the CHECK constraint in
 * db/migrations/0011_curator_captures.sql.
 *
 * NB `unchanged` is in the DB CHECK (a byte-identical repoll short-circuits
 * before any row is inserted) but the curator never actually WRITES a capture
 * row with that status — the sweep records it on the ingestion_audit row, not
 * here. It is retained in the vocabulary so the type mirrors the DB contract
 * and the admin `?status=` filter stays symmetric with the migration.
 */
export const CAPTURE_STATUSES = [
  "shadow",
  "pending",
  "auto_published",
  "approved",
  "rejected",
  "superseded",
  "quarantined",
  "unchanged",
] as const;

export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

export type ArtefactFormat = "html" | "pdf" | "atom" | "xlsx";

/**
 * How a spec's artefact reaches the pipeline.
 *   "worker" (default) — the curator Worker fetches the URL(s) itself.
 *   "relay"            — the Worker's egress is blocked upstream (obr.uk 403s
 *                        Cloudflare Workers IPs; ONS xlsx is doc-only), so a
 *                        GitHub Actions runner fetches the artefact and POSTs it
 *                        to POST /admin/relay-artefact. The Worker-side sweep
 *                        skips the fetch for these (it would 403) and records an
 *                        honest 'unchanged' note. Same upstream-WAF class as the
 *                        BoE IADB relay the ingest worker already runs.
 */
export type FetchVia = "worker" | "relay";

/**
 * Follow-link discovery. Several publishers print the headline number one click
 * deeper than the fixed landing/collection page (a per-month article, a
 * quarterly release page, an exec-summary PDF). A spec with `discover` fetches
 * the landing page, picks the NEWEST link matching `linkPattern`, then fetches
 * THAT and hands the release — not the landing page — to the model. This logic
 * is written once (lib/discover.ts) and shared by the Worker capture stage and
 * the relay runner script (imported via tsx), so the two can never drift.
 */
export interface DiscoverConfig {
  /**
   * Regex SOURCE string matched (compiled `gi`) against the discovery page's
   * `href="..."` values. The captured full href identifies a release. Relative
   * hrefs are resolved against the discovery URL.
   */
  linkPattern: string;
  /**
   * Newest-selection strategy among the matches:
   *   "first"   — first match in document order (publishers list newest-first).
   *   "year"    — highest 4-digit year found in the href (ties → first).
   *   "quarter" — gov.uk quarterly slug (…january-to-march-YYYY / …april-to-june
   *               -YYYY / …july-to-september-YYYY / …october-to-december-YYYY);
   *               ordered by year then quarter.
   */
  newest: "first" | "year" | "quarter";
  /** Artefact format of the DISCOVERED release (overrides spec.format for the follow). */
  releaseFormat?: ArtefactFormat;
  /**
   * Optional SECOND discovery hop, run against the page this one discovers. Some
   * gov.uk statistical releases are two clicks deep: the collection links the
   * quarterly release page, which in turn links the full HTML statistical-release
   * document where the headline numbers actually live (MHCLG). The chain follows
   * each hop until `then` is undefined, then fetches the terminal artefact.
   */
  then?: DiscoverConfig;
}

/**
 * Per-indicator gate parameters on a CaptureSpec. `maxDelta` (gate G4) is local;
 * `min`/`max` (gate G3) default to the shared PLAUSIBILITY entry and are only
 * present as explicit tighter overrides (none today).
 */
export interface PlausibilitySpec {
  maxDelta: number;
  min?: number;
  max?: number;
}

/** The G3 range + G4 maxDelta a spec effectively applies for one indicator. */
export interface EffectivePlausibility {
  min: number;
  max: number;
  maxDelta: number;
}

export type ReleaseCadence =
  | "trading-daily"
  | "monthly"
  | "quarterly"
  | "biannual"
  | "event";

/**
 * Declarative description of one AI-curated source. The registry of these
 * (sources/registry.ts) is the single place a new source is wired up.
 */
export interface CaptureSpec {
  /** Matches SOURCES / ingestion_audit source ids, e.g. "sp_global_pmi". */
  sourceId: string;
  kind: CaptureKind;
  /** Indicator ids this spec can publish observations for (empty for editorial kinds). */
  indicatorIds: string[];
  /** Page(s) to fetch. Discovery pages are fine — the extractor is given the whole artefact. */
  urls: string[];
  format: ArtefactFormat;
  cadence: ReleaseCadence;
  /**
   * Publication gates, per indicator (AUTOMATION_PLAN Appendix A). Only
   * `maxDelta` (the per-upstream-release cap checked by gate G4) is a local
   * value. The hard range (G3 min/max) is DERIVED from the shared
   * `PLAUSIBILITY` table via `effectivePlausibility` (sources/registry.ts) so
   * the curator G3 gate and the ingest write gate can never structurally
   * diverge. `min`/`max` here are OPTIONAL overrides for the rare case a spec
   * needs a tighter bound than the shared table — there are none today.
   */
  plausibility: Record<string, PlausibilitySpec>;
  /**
   * Tolerance for gate G5 (independent second extraction must agree within
   * this absolute difference).
   */
  agreementTolerance: number;
  /**
   * Auto-publish is opt-in per source, only meaningful for kind
   * "observation", and stays false until the Phase 5 shadow-mode comparison
   * signs the source off. Editorial kinds ignore it (never auto-publish).
   */
  allowAutoPublish: boolean;
  /** Workers AI model id, pinned per spec so upgrades are deliberate. */
  modelId: string;
  /** Bumped whenever the extraction prompt changes; recorded on every capture row. */
  promptVersion: string;
  /**
   * Ingestion path. Defaults to "worker" when unset. "relay" specs are fed by
   * the GitHub Actions runner (POST /admin/relay-artefact); the Worker sweep
   * skips their fetch (it would 403). See FetchVia.
   */
  fetchVia?: FetchVia;
  /** Follow-link discovery config; when set, capture follows to the newest release. */
  discover?: DiscoverConfig;
}

/** True when this spec is fed by the relay runner rather than the Worker's own fetch. */
export function isRelaySpec(spec: Pick<CaptureSpec, "fetchVia">): boolean {
  return spec.fetchVia === "relay";
}

/** A fetched, hashed, archived artefact ready for extraction. */
export interface CaptureArtifact {
  spec: CaptureSpec;
  url: string;
  fetchedAt: string;
  contentSha256: string;
  /** R2 object key under curator/{sourceId}/. */
  rawR2Key: string;
  /** Text form handed to the model (HTML→text or PDF→markdown). */
  text: string;
}

/** What the extraction model must return (enforced via JSON-schema mode + validation). */
export interface ExtractionResult {
  values: Array<{
    indicatorId: string;
    value: number;
    unit: string;
    /** Period the value refers to, ISO date. */
    observedAt: string;
    /** Verbatim source sentence containing the value — gate G1 anchor. */
    quote: string;
  }>;
  /** Upstream publication instant if the artefact states one. */
  releasedAt: string | null;
  /** Editorial kinds: draft copy / field patch instead of numeric values. */
  draft: Record<string, unknown> | null;
}

export type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6";

export interface GateResult {
  gate: GateId;
  passed: boolean;
  detail: string;
}

export interface VerificationReport {
  gates: GateResult[];
  /** Deterministic function of gate results + extraction agreement. */
  confidence: number;
  passed: boolean;
}

/** Row shape for curator_captures (subset used by the pipeline). */
export interface CaptureRow {
  id?: number;
  sourceId: string;
  indicatorId: string | null;
  kind: CaptureKind;
  capturedAt: string;
  sourceUrl: string;
  contentSha256: string;
  rawR2Key: string | null;
  observedAt: string | null;
  releasedAt: string | null;
  value: number | null;
  payload: string | null;
  quote: string | null;
  confidence: number | null;
  verification: string | null;
  status: CaptureStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  publishedObservationKey: string | null;
  modelId: string | null;
  promptVersion: string | null;
}
