import type { D1Database } from "@cloudflare/workers-types";
import type { CaptureKind, CaptureRow, CaptureStatus } from "../types";

/**
 * D1 access layer for `curator_captures` (migration 0011). Every AI candidate
 * lands here first; nothing reaches indicator_observations / delivery_commitments
 * / timeline_events without either passing the gates (auto-publish) or a human
 * decision. Mirrors the insert/dedupe idiom of
 * apps/ingest/src/lib/timelineCaptures.ts.
 */

/** Raw DB row shape (snake_case columns as stored). */
interface CaptureDbRow {
  id: number;
  source_id: string;
  indicator_id: string | null;
  kind: CaptureKind;
  captured_at: string;
  source_url: string;
  content_sha256: string;
  raw_r2_key: string | null;
  observed_at: string | null;
  released_at: string | null;
  value: number | null;
  payload: string | null;
  quote: string | null;
  confidence: number | null;
  verification: string | null;
  status: CaptureStatus;
  decided_by: string | null;
  decided_at: string | null;
  published_observation_key: string | null;
  model_id: string | null;
  prompt_version: string | null;
  created_at: string;
}

export interface CaptureListItem {
  id: number;
  sourceId: string;
  indicatorId: string | null;
  kind: CaptureKind;
  value: number | null;
  confidence: number | null;
  status: CaptureStatus;
  createdAt: string;
  observedAt: string | null;
}

export interface CaptureDetail extends CaptureRow {
  id: number;
  createdAt: string;
}

function toDetail(r: CaptureDbRow): CaptureDetail {
  return {
    id: r.id,
    sourceId: r.source_id,
    indicatorId: r.indicator_id,
    kind: r.kind,
    capturedAt: r.captured_at,
    sourceUrl: r.source_url,
    contentSha256: r.content_sha256,
    rawR2Key: r.raw_r2_key,
    observedAt: r.observed_at,
    releasedAt: r.released_at,
    value: r.value,
    payload: r.payload,
    quote: r.quote,
    confidence: r.confidence,
    verification: r.verification,
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    publishedObservationKey: r.published_observation_key,
    modelId: r.model_id,
    promptVersion: r.prompt_version,
    createdAt: r.created_at,
  };
}

/**
 * content_sha256 of the most recent capture for a source, or null if the
 * source has never been captured. The dedupe anchor: capture.ts short-circuits
 * to "unchanged" when a fresh fetch hashes to this.
 */
export async function latestCaptureSha(db: D1Database, sourceId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT content_sha256 FROM curator_captures
        WHERE source_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
    .bind(sourceId)
    .first<{ content_sha256: string }>();
  return row?.content_sha256 ?? null;
}

/** Insert a capture row, returning its new id. */
export async function insertCapture(db: D1Database, row: CaptureRow): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO curator_captures
         (source_id, indicator_id, kind, captured_at, source_url, content_sha256, raw_r2_key,
          observed_at, released_at, value, payload, quote, confidence, verification, status,
          decided_by, decided_at, published_observation_key, model_id, prompt_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      row.sourceId,
      row.indicatorId,
      row.kind,
      row.capturedAt,
      row.sourceUrl,
      row.contentSha256,
      row.rawR2Key,
      row.observedAt,
      row.releasedAt,
      row.value,
      row.payload,
      row.quote,
      row.confidence,
      row.verification,
      row.status,
      row.decidedBy,
      row.decidedAt,
      row.publishedObservationKey,
      row.modelId,
      row.promptVersion,
    )
    .first<{ id: number }>();
  return res?.id ?? 0;
}

/** List captures filtered by status, newest first, for the review queue. */
export async function listCaptures(
  db: D1Database,
  status: CaptureStatus,
  limit = 100,
): Promise<CaptureListItem[]> {
  const res = await db
    .prepare(
      `SELECT id, source_id, indicator_id, kind, value, confidence, status, created_at, observed_at
         FROM curator_captures
        WHERE status = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .bind(status, limit)
    .all<Pick<CaptureDbRow, "id" | "source_id" | "indicator_id" | "kind" | "value" | "confidence" | "status" | "created_at" | "observed_at">>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    indicatorId: r.indicator_id,
    kind: r.kind,
    value: r.value,
    confidence: r.confidence,
    status: r.status,
    createdAt: r.created_at,
    observedAt: r.observed_at,
  }));
}

/**
 * Pending captures of a given kind + source, oldest first — the timeline-triage
 * reader over rows the ingest worker stages (source_id='gov_uk',
 * kind='timeline_event', status='pending').
 */
export async function listPending(
  db: D1Database,
  kind: CaptureKind,
  sourceId: string,
  limit: number,
): Promise<CaptureDetail[]> {
  const res = await db
    .prepare(
      `SELECT * FROM curator_captures
        WHERE status = 'pending' AND kind = ? AND source_id = ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
    .bind(kind, sourceId, limit)
    .all<CaptureDbRow>();
  return (res.results ?? []).map(toDetail);
}

/** Overwrite a capture's payload JSON (timeline triage enriches the staged draft). */
export async function updatePayload(db: D1Database, id: number, payload: string): Promise<void> {
  await db.prepare("UPDATE curator_captures SET payload = ? WHERE id = ?").bind(payload, id).run();
}

/** Full detail for one capture (admin detail view / approve/reject). */
export async function getCapture(db: D1Database, id: number): Promise<CaptureDetail | null> {
  const r = await db.prepare("SELECT * FROM curator_captures WHERE id = ?").bind(id).first<CaptureDbRow>();
  return r ? toDetail(r) : null;
}

/** Update a capture's status + decision provenance (approve/reject/publish). */
export async function setCaptureDecision(
  db: D1Database,
  id: number,
  status: CaptureStatus,
  opts: { decidedBy?: string; publishedObservationKey?: string } = {},
): Promise<void> {
  await db
    .prepare(
      `UPDATE curator_captures
         SET status = ?, decided_by = ?, decided_at = ?, published_observation_key = COALESCE(?, published_observation_key)
       WHERE id = ?`,
    )
    .bind(status, opts.decidedBy ?? null, new Date().toISOString(), opts.publishedObservationKey ?? null, id)
    .run();
}

/**
 * Mark older, not-yet-published captures for the same (indicator, observed_at)
 * as 'superseded' — a newer capture of the same reading replaced them. Never
 * touches rows already in a terminal published/approved/rejected state, and
 * skips the current row.
 */
export async function supersedeOlderUnpublished(
  db: D1Database,
  indicatorId: string,
  observedAt: string,
  exceptId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE curator_captures
         SET status = 'superseded'
       WHERE indicator_id = ? AND observed_at = ? AND id <> ?
         AND status IN ('pending', 'shadow', 'quarantined')`,
    )
    .bind(indicatorId, observedAt, exceptId)
    .run();
}
