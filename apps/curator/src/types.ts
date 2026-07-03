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

export type CaptureStatus =
  | "shadow"
  | "pending"
  | "auto_published"
  | "approved"
  | "rejected"
  | "superseded"
  | "quarantined"
  | "unchanged";

export type ArtefactFormat = "html" | "pdf" | "atom";

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
   * Publication gates, per indicator (AUTOMATION_PLAN Appendix A). Range is
   * a hard bound; maxDelta is per upstream release, checked against the
   * latest published observation (gate G4).
   */
  plausibility: Record<string, { min: number; max: number; maxDelta: number }>;
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
