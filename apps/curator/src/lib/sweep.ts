import type { Env } from "../env";
import { isEditorialKind, isRelaySpec, type CaptureRow, type CaptureSpec, type ExtractionResult } from "../types";
import { CAPTURE_SPECS } from "../sources/registry";
import { captureSource } from "../pipeline/capture";
import { extractFromArtifact, runExtraction } from "../pipeline/extract";
import { verifyExtraction } from "../pipeline/verify";
import { decideAndPersist } from "../pipeline/publish";
import { closeAudit, type CuratorAuditStatus, type CloseAuditOpts, openAudit } from "./audit";
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

/**
 * Run one spec through the pipeline, guaranteeing the audit invariant.
 *
 * AUDIT INVARIANT (the timeline_triage defect fix). Every opened `ingestion_audit`
 * row is closed EXACTLY ONCE, on every exit path, from a single `finally` — no
 * success/catch pair that can double-write or, worse, skip the close and leave a
 * dangling `started` row. The outcome (success / unchanged / skipped / failure)
 * is resolved inside the try/catch into `audit`; the finally performs the one
 * close. If the close itself fails (a real D1 outage, the only remaining way a
 * row can dangle) we log LOUDLY rather than swallowing it silently — the old
 * `.catch(() => undefined)` on the failure-close is exactly what turned a
 * mid-sweep hiccup into an invisible `started` row.
 *
 * `fetchVia:"relay"` specs are NOT fetched here — the Worker's egress is
 * upstream-WAF-blocked for them (obr_efo → HTTP 403). Their ingestion path is
 * the GitHub Actions relay (POST /admin/relay-artefact). The sweep records an
 * honest 'unchanged' audit note with a comment instead of a guaranteed 403
 * failure, so /admin/health does not light up red for a source that is being
 * fed out-of-band.
 */
async function runSpec(env: Env, spec: CaptureSpec, opts: { force: boolean }): Promise<SpecResult> {
  const auditUrl = spec.urls[0] ?? `curator:${spec.sourceId}`;
  const handle = await openAudit(env.DB, spec.sourceId, auditUrl);
  // Default to failure so an unexpected early exit is honest, never a dangling row.
  let audit: { status: CuratorAuditStatus; opts: CloseAuditOpts } = {
    status: "failure",
    opts: { error: "spec did not complete" },
  };
  let result: SpecResult = { sourceId: spec.sourceId, status: "failure", rows: 0, error: "spec did not complete" };

  try {
    if (spec.sourceId === TIMELINE_TRIAGE_SOURCE) {
      const n = await runTimelineTriage(env, spec);
      audit = { status: "success", opts: { rowsWritten: n } };
      result = { sourceId: spec.sourceId, status: "success", rows: n };
    } else if (isRelaySpec(spec)) {
      // Worker egress is WAF-blocked for this source; the relay endpoint owns
      // ingestion. Skip the (guaranteed-failing) fetch and record it honestly.
      audit = { status: "unchanged", opts: { payloadHash: null, error: "skipped: fetchVia=relay (ingested via /admin/relay-artefact)" } };
      result = { sourceId: spec.sourceId, status: "unchanged", rows: 0 };
    } else {
      const cap = await captureSource(env, spec, opts);
      if (cap === "unchanged") {
        audit = { status: "unchanged", opts: { payloadHash: null } };
        result = { sourceId: spec.sourceId, status: "unchanged", rows: 0 };
      } else {
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
        audit = { status: "success", opts: { rowsWritten: rows, payloadHash: `ai:${cap.contentSha256}` } };
        result = { sourceId: spec.sourceId, status: "success", rows };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    audit = { status: "failure", opts: { error: message } };
    result = { sourceId: spec.sourceId, status: "failure", rows: 0, error: message };
    console.warn(`curator sweep: spec '${spec.sourceId}' failed: ${message}`);
  } finally {
    // Exactly one close, on every path. A throw HERE is the only remaining way a
    // row can be left 'started', so surface it loudly instead of hiding it.
    try {
      await closeAudit(env.DB, handle, audit.status, audit.opts);
    } catch (closeErr) {
      console.error(
        `curator sweep: FAILED to close audit row for '${spec.sourceId}' — row left 'started': ${(closeErr as Error)?.message ?? String(closeErr)}`,
      );
    }
  }

  return result;
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
    // PER-CANDIDATE ISOLATION — the underlying crash fix. Previously only the
    // extraction was wrapped; the follow-up decision writes (setCaptureDecision
    // / updatePayload) sat OUTSIDE the try, so a single candidate's write
    // failure threw out of the whole triage job, dropping every remaining
    // candidate and (once the audit close was compromised) leaving the sweep's
    // audit row dangling at 'started'. The entire per-candidate unit is now
    // self-contained — one bad row is logged and skipped, the batch continues
    // (matching ingest's best-effort-per-item stageTimelineCandidates idiom).
    try {
      const candidate = cap.payload ? safeParse(cap.payload) : null;
      const text = candidateText(candidate);
      if (!text) continue;
      const res = await runExtraction(env, spec, text, "primary");
      const draft = res.draft;
      processed++;
      const relevant = draft?.relevant !== false; // default keep unless explicitly false
      if (!relevant) {
        await setCaptureDecision(env.DB, cap.id, "rejected", { decidedBy: "auto:triage(not-material)" });
      } else if (draft) {
        // Merge the AI draft over the raw candidate so the reviewer sees both.
        await updatePayload(env.DB, cap.id, JSON.stringify({ ...(candidate ?? {}), draft }));
      }
    } catch (err) {
      console.warn(`timeline triage: candidate ${cap.id} failed: ${(err as Error)?.message ?? String(err)}`);
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
