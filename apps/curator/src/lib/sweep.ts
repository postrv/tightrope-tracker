import type { Env } from "../env";
import { isEditorialKind, type CaptureRow, type CaptureSpec, type ExtractionResult } from "../types";
import { CAPTURE_SPECS } from "../sources/registry";
import { captureSource } from "../pipeline/capture";
import { extractFromArtifact, runExtraction } from "../pipeline/extract";
import { verifyExtraction } from "../pipeline/verify";
import { decideAndPersist } from "../pipeline/publish";
import { closeAudit, openAudit } from "./audit";
import { listPending, setCaptureDecision, updatePayload } from "./captures";

/** The triage spec reads staged gov.uk rows rather than fetching a URL. */
export const TIMELINE_TRIAGE_SOURCE = "timeline_triage";
const TIMELINE_TRIAGE_LIMIT = 15;

export interface SpecResult {
  sourceId: string;
  status: "success" | "unchanged" | "failure";
  rows: number;
  error?: string;
}

export interface SweepSummary {
  ran: number;
  results: SpecResult[];
}

/** Bounded fan-out: a modest pool keeps AI/upstream calls in flight without stampeding rate-limited sources. */
const SWEEP_CONCURRENCY = 3;

/**
 * Run the full capture→verify→decide pipeline across every registered spec.
 *
 * Error isolation is the invariant (mirrors ingest's dispatch): each spec is
 * wrapped so one source's failure never aborts the run, and each opens exactly
 * one `ingestion_audit` row under its own sourceId (started → success /
 * unchanged / failure). `force: true` (the pre-deadline sweep) ignores the
 * content-hash short-circuit; `force: false` (the daily poll) extracts only on
 * change.
 *
 * Specs run with bounded concurrency (pool of 3): runSpec never throws (it
 * records a 'failure' audit row and returns a failure result), so per-spec
 * isolation holds under concurrency, and results are written back by input
 * index so the summary order is deterministic (CAPTURE_SPECS order) regardless
 * of completion order — the tests rely on that stability.
 */
export async function runSweep(env: Env, opts: { force: boolean }): Promise<SweepSummary> {
  const results = await mapWithConcurrency(CAPTURE_SPECS, SWEEP_CONCURRENCY, (spec) => runSpec(env, spec, opts));
  return { ran: results.length, results };
}

/** Map with a fixed worker pool, preserving input order in the output array. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (let index = cursor++; index < items.length; index = cursor++) {
      out[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

async function runSpec(env: Env, spec: CaptureSpec, opts: { force: boolean }): Promise<SpecResult> {
  const auditUrl = spec.urls[0] ?? `curator:${spec.sourceId}`;
  const handle = await openAudit(env.DB, spec.sourceId, auditUrl);
  try {
    if (spec.sourceId === TIMELINE_TRIAGE_SOURCE) {
      const n = await runTimelineTriage(env, spec);
      await closeAudit(env.DB, handle, "success", { rowsWritten: n });
      return { sourceId: spec.sourceId, status: "success", rows: n };
    }

    const cap = await captureSource(env, spec, opts);
    if (cap === "unchanged") {
      await closeAudit(env.DB, handle, "unchanged", { payloadHash: null });
      return { sourceId: spec.sourceId, status: "unchanged", rows: 0 };
    }

    const extraction = await extractFromArtifact(env, spec, cap);
    const verification = await verifyExtraction(env, spec, cap, extraction);

    let rows = 0;
    if (isEditorialKind(spec.kind)) {
      await decideAndPersist(env, spec, buildEditorialRow(spec, cap, extraction), verification);
      rows = 1;
    } else {
      for (const val of extraction.values) {
        await decideAndPersist(env, spec, buildObservationRow(spec, cap, val, extraction), verification);
        rows++;
      }
    }
    await closeAudit(env.DB, handle, "success", { rowsWritten: rows, payloadHash: `ai:${cap.contentSha256}` });
    return { sourceId: spec.sourceId, status: "success", rows };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await closeAudit(env.DB, handle, "failure", { error: message }).catch(() => undefined);
    console.warn(`curator sweep: spec '${spec.sourceId}' failed: ${message}`);
    return { sourceId: spec.sourceId, status: "failure", rows: 0, error: message };
  }
}

function buildObservationRow(
  spec: CaptureSpec,
  cap: { fetchedAt: string; url: string; contentSha256: string; rawR2Key: string },
  val: ExtractionResult["values"][number],
  extraction: ExtractionResult,
): CaptureRow {
  return {
    sourceId: spec.sourceId,
    indicatorId: val.indicatorId,
    kind: spec.kind,
    capturedAt: cap.fetchedAt,
    sourceUrl: cap.url,
    contentSha256: cap.contentSha256,
    rawR2Key: cap.rawR2Key,
    observedAt: val.observedAt,
    releasedAt: extraction.releasedAt,
    value: val.value,
    payload: JSON.stringify({ unit: val.unit }),
    quote: val.quote,
    confidence: null,
    verification: null,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    publishedObservationKey: null,
    modelId: spec.modelId,
    promptVersion: spec.promptVersion,
  };
}

function buildEditorialRow(
  spec: CaptureSpec,
  cap: { fetchedAt: string; url: string; contentSha256: string; rawR2Key: string },
  extraction: ExtractionResult,
): CaptureRow {
  const draft = extraction.draft ?? {};
  const indicatorId = typeof draft.indicatorId === "string" ? draft.indicatorId : null;
  const quote = typeof draft.quote === "string" ? draft.quote : null;
  return {
    sourceId: spec.sourceId,
    indicatorId,
    kind: spec.kind,
    capturedAt: cap.fetchedAt,
    sourceUrl: cap.url,
    contentSha256: cap.contentSha256,
    rawR2Key: cap.rawR2Key,
    observedAt: null,
    releasedAt: extraction.releasedAt,
    value: null,
    payload: JSON.stringify(draft),
    quote,
    confidence: null,
    verification: null,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    publishedObservationKey: null,
    modelId: spec.modelId,
    promptVersion: spec.promptVersion,
  };
}

/**
 * Timeline triage: an AI relevance pass over the gov.uk candidates the ingest
 * worker stages into curator_captures (source_id='gov_uk', kind='timeline_event',
 * status='pending'). Dedupe already happened at stage time. Here we ask the
 * model whether each candidate is a material timeline event; irrelevant ones
 * are auto-rejected (decided_by 'auto:triage'), relevant ones are enriched with
 * the drafted fields and left pending for a human. Bounded per run so the daily
 * poll's AI spend stays predictable.
 */
export async function runTimelineTriage(env: Env, spec: CaptureSpec): Promise<number> {
  const pending = await listPending(env.DB, "timeline_event", "gov_uk", TIMELINE_TRIAGE_LIMIT);
  let processed = 0;
  for (const cap of pending) {
    const candidate = cap.payload ? safeParse(cap.payload) : null;
    const text = candidateText(candidate);
    if (!text) continue;
    let draft: Record<string, unknown> | null = null;
    try {
      const res = await runExtraction(env, spec, text, "primary");
      draft = res.draft;
    } catch (err) {
      console.warn(`timeline triage extract failed for capture ${cap.id}: ${(err as Error)?.message ?? String(err)}`);
      continue;
    }
    processed++;
    const relevant = draft?.relevant !== false; // default keep unless explicitly false
    if (!relevant) {
      await setCaptureDecision(env.DB, cap.id, "rejected", { decidedBy: "auto:triage(not-material)" });
    } else if (draft) {
      // Merge the AI draft over the raw candidate so the reviewer sees both.
      await updatePayload(env.DB, cap.id, JSON.stringify({ ...(candidate ?? {}), draft }));
    }
  }
  return processed;
}

function candidateText(candidate: Record<string, unknown> | null): string {
  if (!candidate) return "";
  const title = typeof candidate.title === "string" ? candidate.title : "";
  const summary = typeof candidate.summary === "string" ? candidate.summary : "";
  const link = typeof candidate.link === "string" ? candidate.link : "";
  const published = typeof candidate.publishedAt === "string" ? candidate.publishedAt : "";
  return [title, summary, `Published: ${published}`, `Link: ${link}`].filter(Boolean).join("\n");
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
