import type { D1Database } from "@cloudflare/workers-types";
import { DELIVERY_COMMITMENTS_SEED, INDICATORS } from "@tightrope/shared";
import { curatorPublicUrl, type Env } from "../env";
import { isEditorialKind, type CaptureRow, type CaptureSpec, type CaptureStatus, type VerificationReport } from "../types";
import { insertCapture, setCaptureDecision, supersedeOlderUnpublished, type CaptureDetail } from "../lib/captures";
import {
  insertCorrection,
  publishObservation,
  readPublishedValueAt,
} from "../lib/observations";
import { postAlert } from "../lib/alert";

const TIMELINE_CACHE_KEY = "timeline:latest";

/** Shadow mode is default-ON: anything other than an explicit "live" stays shadow. */
export function isShadowMode(env: Pick<Env, "CURATOR_MODE">): boolean {
  return (env.CURATOR_MODE ?? "shadow").toLowerCase() !== "live";
}

/**
 * Stage 4 — decide + persist + (maybe) publish, for ONE capture row produced by
 * the sweep. Contract in the original stub header (AUTOMATION_PLAN Phase 3).
 *
 * Decision (before the shadow override):
 *   - editorial kind                                   → 'pending'
 *   - observation, G3 or G4 failed                     → 'quarantined' (+ alert)
 *   - observation, verification.passed ∧ allowAutoPublish → 'auto_published'
 *   - observation, otherwise                           → 'pending'
 *
 * Shadow gate (rule 6, F1): shadow mode gates the PUBLISH ACTION for
 * OBSERVATIONS, not the review queue for editorial drafts. While CURATOR_MODE ≠
 * "live":
 *   - an OBSERVATION's persisted status is forced to 'shadow' and NOTHING
 *     publishes (its intended decision is recorded in decided_by), but a
 *     would-be quarantine still fires its alert because a plausibility breach is
 *     worth surfacing during the shadow-comparison window;
 *   - an EDITORIAL draft is persisted at its intended status ('pending') and
 *     reaches the review queue exactly as it would in live mode — human
 *     approval is itself the safeguard, so shadow mode never withholds
 *     editorial drafts from a reviewer (they can never auto-publish anyway).
 */
export async function decideAndPersist(
  env: Env,
  spec: CaptureSpec,
  row: CaptureRow,
  verification: VerificationReport,
): Promise<CaptureRow> {
  const intended = decideStatus(spec, verification);
  const shadow = isShadowMode(env);
  const editorial = isEditorialKind(spec.kind);
  // Vacuous-draft gate: an editorial draft that could never be approved (no
  // extractable milestone, a field patch with a null/unknown commitment id)
  // is auto-rejected with the reason recorded, instead of queuing for a human
  // to reject by hand. The 2026-07-14 triage found 15 such rows — every
  // delivery draft in the queue — including model rationales that literally
  // said "No milestones mentioned in the text".
  const vacuous = editorial ? vacuousEditorialReason(spec, row) : null;
  // Only observations are shadowed; editorial drafts always reach the queue.
  const finalStatus: CaptureStatus = vacuous ? "rejected" : shadow && !editorial ? "shadow" : intended;
  const willPublish = finalStatus === "auto_published";

  // Deterministic observation key (indicator|observed_at) when this row can publish.
  const canKey = row.indicatorId && row.observedAt;
  const observationKey = canKey ? `${row.indicatorId}|${row.observedAt}` : null;

  const shadowed = finalStatus === "shadow";
  const decidedBy = vacuous
    ? `auto:triage(vacuous-draft: ${vacuous})`
    : shadowed
      ? `auto:shadow(intended=${intended})`
      : "auto";
  const persisted: CaptureRow = {
    ...row,
    status: finalStatus,
    confidence: verification.confidence,
    verification: JSON.stringify(verification.gates),
    decidedBy,
    decidedAt: new Date().toISOString(),
    publishedObservationKey: willPublish ? observationKey : null,
  };
  const id = await insertCapture(env.DB, persisted);
  persisted.id = id;

  // A would-be quarantine alerts even under shadow.
  if (intended === "quarantined") {
    await alertQuarantine(env, spec, row, verification);
  }

  if (willPublish && row.indicatorId && row.observedAt && row.value !== null) {
    await publishCapturedObservation(env.DB, {
      indicatorId: row.indicatorId,
      observedAt: row.observedAt,
      value: row.value,
      contentSha256: row.contentSha256,
      releasedAt: row.releasedAt,
      sourceUrl: row.sourceUrl,
      quote: row.quote,
      exceptCaptureId: id,
    });
  }

  return persisted;
}

function decideStatus(spec: CaptureSpec, verification: VerificationReport): CaptureStatus {
  if (isEditorialKind(spec.kind)) return "pending";
  const failed = (id: string) => verification.gates.some((g) => g.gate === id && !g.passed);
  if (failed("G3") || failed("G4")) return "quarantined";
  if (verification.passed && spec.allowAutoPublish) return "auto_published";
  return "pending";
}

/** The model's honest "there is nothing here" phrasings, verbatim from production rows. */
const VACUOUS_RATIONALE =
  /\bno (?:specific )?(?:delivery )?milestones?\b|\binsufficient information\b|\bno specific .* mentioned\b/i;

/**
 * Reason an editorial draft is unapprovable-by-construction, or null when it
 * deserves the review queue. Deliberately narrow: it rejects only drafts the
 * APPROVE PATH itself would refuse (or that name entities that don't exist) —
 * editorial judgment about borderline-but-valid drafts stays with the human.
 */
function vacuousEditorialReason(spec: CaptureSpec, row: CaptureRow): string | null {
  const draft = row.payload ? safeParse(row.payload) : null;
  if (!draft) return "no parseable draft payload";

  if (row.kind === "delivery_milestone") {
    const indicatorId = typeof draft.indicatorId === "string" ? draft.indicatorId : null;
    if (!indicatorId || !spec.indicatorIds.includes(indicatorId)) {
      return `milestone indicatorId '${indicatorId ?? "missing"}' is not one the spec declares`;
    }
    const rationale = typeof draft.rationale === "string" ? draft.rationale : "";
    if (VACUOUS_RATIONALE.test(rationale)) {
      return "rationale states no extractable milestone";
    }
    const quote = typeof draft.quote === "string" ? draft.quote.trim() : "";
    if (quote.length === 0) return "draft has no anchoring quote";
    return null;
  }

  if (row.kind === "delivery_commitment") {
    const patch = extractCommitmentPatch(draft);
    if (!patch) return "field patch has no id / no updatable fields (approve would refuse it)";
    if (!DELIVERY_COMMITMENTS_SEED.some((c) => c.id === patch.id)) {
      return `commitment id '${patch.id}' does not exist on the delivery scorecard`;
    }
    return null;
  }

  // timeline_event relevance belongs to the triage pass, not this gate.
  return null;
}

interface PublishArgs {
  indicatorId: string;
  observedAt: string;
  value: number;
  contentSha256: string;
  releasedAt: string | null;
  sourceUrl: string;
  quote: string | null;
  exceptCaptureId: number;
}

/**
 * Publish one observation into the LIVE tier and reconcile the review queue.
 * Shared by auto-publish (decide) and human approve. Writes a public
 * corrections row when this revises a DIFFERENT previously-published value for
 * the same (indicator, observed_at). Returns the observation key.
 */
export async function publishCapturedObservation(db: D1Database, args: PublishArgs): Promise<string> {
  // The published observation carries the indicator's CANONICAL source id (e.g.
  // 'mhclg', 'ons_rti') so it slots into the same source lineage / cadence the
  // adapters use — not the capture spec's provenance id.
  const sourceId = INDICATORS[args.indicatorId]?.sourceId ?? "curator";
  const prev = await readPublishedValueAt(db, args.indicatorId, args.observedAt);

  if (prev !== null && prev !== args.value) {
    const sha8 = args.contentSha256.slice(0, 8);
    const period = args.observedAt.slice(0, 10);
    await insertCorrection(db, {
      id: `c_ai_${args.indicatorId}_${period}_${sha8}`,
      publishedAt: new Date().toISOString(),
      affectedIndicator: args.indicatorId,
      originalValue: String(prev),
      correctedValue: String(args.value),
      reason:
        `Automated curation revised ${args.indicatorId} for ${period} from ${prev} to ${args.value} after ` +
        `re-reading the primary source and re-running the verification gates. Source: ${args.sourceUrl}.` +
        (args.quote ? ` Anchoring quote: "${truncate(args.quote, 300)}".` : ""),
    });
  }

  await publishObservation(db, {
    indicatorId: args.indicatorId,
    observedAt: args.observedAt,
    value: args.value,
    sourceId,
    payloadHash: `ai:${args.contentSha256}`,
    releasedAt: args.releasedAt,
  });

  const key = `${args.indicatorId}|${args.observedAt}`;
  await supersedeOlderUnpublished(db, args.indicatorId, args.observedAt, args.exceptCaptureId);
  return key;
}

async function alertQuarantine(env: Env, spec: CaptureSpec, row: CaptureRow, verification: VerificationReport): Promise<void> {
  const failing = verification.gates.filter((g) => (g.gate === "G3" || g.gate === "G4") && !g.passed);
  const text = [
    `*Tightrope curator quarantine* (${new Date().toISOString().slice(0, 16).replace("T", " ")}Z)`,
    `Source \`${spec.sourceId}\` indicator \`${row.indicatorId}\` = ${row.value} @ ${row.observedAt?.slice(0, 10) ?? "?"} withheld from indicator_observations:`,
    ...failing.map((g) => `• ${g.gate}: ${g.detail}`),
    `Review: \`curl -H "x-admin-token: $ADMIN_TOKEN" "${curatorPublicUrl(env)}/admin/captures?status=quarantined"\``,
  ].join("\n");
  await postAlert(env, text);
}

/**
 * Human-approve path for a pending/quarantined capture (the /admin/captures/:id/approve
 * endpoint). Dispatches by kind:
 *   - observation / delivery_milestone → publish the observation (with correction on revision)
 *   - delivery_commitment              → POST the field patch to the ingest admin surface
 *   - timeline_event                   → INSERT timeline_events + purge timeline:latest
 * Returns a human-readable note (surfaced to the reviewer + digest).
 */
export async function approveCapture(env: Env, detail: CaptureDetail, reviewer: string): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  const draft = detail.payload ? safeParse(detail.payload) : null;

  if (detail.kind === "observation" || detail.kind === "delivery_milestone") {
    const target = resolveObservation(detail, draft);
    if (!target) return { ok: false, error: "capture lacks indicatorId/observedAt/value to publish" };
    const key = await publishCapturedObservation(env.DB, {
      indicatorId: target.indicatorId,
      observedAt: target.observedAt,
      value: target.value,
      contentSha256: detail.contentSha256,
      releasedAt: detail.releasedAt,
      sourceUrl: detail.sourceUrl,
      quote: detail.quote,
      exceptCaptureId: detail.id,
    });
    await setCaptureDecision(env.DB, detail.id, "approved", { decidedBy: reviewer, publishedObservationKey: key });
    const note =
      detail.kind === "delivery_milestone"
        ? `Published ${target.indicatorId} = ${target.value}. Fold the value back into delivery-milestones.json for seed parity.`
        : `Published ${target.indicatorId} = ${target.value} @ ${target.observedAt.slice(0, 10)}.`;
    return { ok: true, note };
  }

  if (detail.kind === "delivery_commitment") {
    const patch = extractCommitmentPatch(draft);
    if (!patch) return { ok: false, error: "commitment draft missing an `id` / updatable fields" };
    const res = await postDeliveryCommitment(env, patch);
    if (!res.ok) return { ok: false, error: res.error };
    await setCaptureDecision(env.DB, detail.id, "approved", { decidedBy: reviewer });
    return { ok: true, note: `Patched delivery commitment ${patch.id} via ingest admin.` };
  }

  if (detail.kind === "timeline_event") {
    const ev = extractTimelineEvent(draft);
    if (!ev) return { ok: false, error: "timeline draft missing title/eventDate" };
    await env.DB
      .prepare(
        `INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url, score_delta)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(globalThis.crypto.randomUUID(), ev.eventDate, ev.title, ev.summary, ev.category, ev.sourceLabel, ev.sourceUrl)
      .run();
    await env.KV.delete(TIMELINE_CACHE_KEY).catch(() => undefined);
    await setCaptureDecision(env.DB, detail.id, "approved", { decidedBy: reviewer });
    return { ok: true, note: `Inserted timeline event "${ev.title}" and purged timeline:latest.` };
  }

  return { ok: false, error: `unsupported kind '${detail.kind}'` };
}

function resolveObservation(
  detail: CaptureDetail,
  draft: Record<string, unknown> | null,
): { indicatorId: string; observedAt: string; value: number } | null {
  // Prefer the structured columns; a milestone draft may carry proposedValue.
  const indicatorId = detail.indicatorId ?? (typeof draft?.indicatorId === "string" ? draft.indicatorId : null);
  const value =
    detail.value ?? (typeof draft?.proposedValue === "number" ? (draft.proposedValue as number) : null);
  const observedAt = detail.observedAt ?? new Date().toISOString();
  if (!indicatorId || value === null || !Number.isFinite(value)) return null;
  return { indicatorId, observedAt, value };
}

export interface DeliveryCommitmentPatch {
  id: string;
  latest?: string;
  status?: string;
  notes?: string;
  source_url?: string;
  source_label?: string;
}

function extractCommitmentPatch(draft: Record<string, unknown> | null): DeliveryCommitmentPatch | null {
  if (!draft || typeof draft.id !== "string" || draft.id.trim().length === 0) return null;
  const patch: DeliveryCommitmentPatch = { id: draft.id };
  for (const f of ["latest", "status", "notes", "source_url", "source_label"] as const) {
    if (typeof draft[f] === "string") patch[f] = draft[f] as string;
  }
  // At least one updatable field beyond id.
  if (Object.keys(patch).length < 2) return null;
  return patch;
}

async function postDeliveryCommitment(env: Env, patch: DeliveryCommitmentPatch): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = env.INGEST_ADMIN_URL;
  const token = env.INGEST_ADMIN_TOKEN;
  if (!base || !token) return { ok: false, error: "INGEST_ADMIN_URL / INGEST_ADMIN_TOKEN not configured" };
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/admin/delivery-commitment`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": token },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { ok: false, error: `ingest admin returned HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `ingest admin call failed: ${(err as Error)?.message ?? String(err)}` };
  }
}

interface TimelineEventDraft {
  eventDate: string;
  title: string;
  summary: string;
  category: string;
  sourceLabel: string;
  sourceUrl: string;
}

function extractTimelineEvent(draft: Record<string, unknown> | null): TimelineEventDraft | null {
  if (!draft) return null;
  const eventDate = typeof draft.eventDate === "string" ? draft.eventDate : null;
  const title = typeof draft.title === "string" ? draft.title : null;
  if (!eventDate || !title) return null;
  return {
    eventDate,
    title,
    summary: typeof draft.summary === "string" ? draft.summary : "",
    category: typeof draft.category === "string" ? draft.category : "delivery",
    sourceLabel: typeof draft.sourceLabel === "string" ? draft.sourceLabel : "gov.uk",
    sourceUrl: typeof draft.sourceUrl === "string" ? draft.sourceUrl : "",
  };
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
