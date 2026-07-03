import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { RawObservation } from "@tightrope/data-sources";
import { historicalPayloadHash as sharedHistoricalPayloadHash } from "@tightrope/data-sources";
import { SOURCES, checkPlausibility, sanitizeForLog, type PlausibilityResult } from "@tightrope/shared";
import type { Env } from "../env.js";
import { postAlert } from "./alertWebhook.js";
import { sha256Hex } from "./hash.js";

/** Re-export so the ingest worker can reach it via a single import path. */
export const historicalPayloadHash = sharedHistoricalPayloadHash;

/** Bindings writeObservations needs: D1 for the write + quarantine, KV for the alert dedupe, webhook for the alert. */
type WriteEnv = Pick<Env, "DB" | "KV" | "ALERT_WEBHOOK_URL" | "CURATOR_PUBLIC_URL">;

/** Alert re-page window for a stuck quarantine (pattern: the alert:source: keys). */
const QUARANTINE_ALERT_TTL_SEC = 24 * 60 * 60;

/** Default curator host for the quarantine-review curl (C2: overridable via CURATOR_PUBLIC_URL). */
const DEFAULT_CURATOR_PUBLIC_URL = "https://curator.tightropetracker.uk";

/** The result of one writeObservations batch: what landed vs what was withheld. */
export interface WriteObservationsResult {
  /** The observations actually written to indicator_observations (survivors). */
  written: RawObservation[];
  /** How many observations the plausibility gate withheld (quarantined). */
  quarantined: number;
}

/**
 * Write a batch of LIVE raw observations with `INSERT OR REPLACE` semantics so
 * a re-run of the same ingest (same indicator + observed_at) overwrites the
 * previous value idempotently. `released_at` is persisted when the adapter
 * supplies it (ONS family) and left NULL otherwise (daily BoE/FX, fixtures
 * where reference period == publication date).
 *
 * Plausibility gate (AUTOMATION_PLAN.md §2.2): every observation is checked
 * against the shared per-indicator bounds before it is written. A violating
 * observation is NOT written to `indicator_observations`; instead it lands in
 * `curator_captures` as a `quarantined` row and an alert fires. Non-violating
 * siblings in the same batch still write — one bad value never blocks its
 * peers. (Historical writes keep their own guardrails in
 * `writeHistoricalObservations`; this gate is live-only.)
 *
 * Returns the observations that actually landed (`written`) plus the count the
 * gate withheld (`quarantined`), so the caller can hash only the written rows
 * for the audit payload and mark a mixed batch as 'partial' (F5).
 */
export async function writeObservations(
  env: WriteEnv,
  observations: readonly RawObservation[],
): Promise<WriteObservationsResult> {
  if (observations.length === 0) return { written: [], quarantined: 0 };

  // Previous live value per indicator, for the max-jump check (the value
  // already on file BEFORE this write, strictly older than this reading).
  const previous = await readPreviousLive(env.DB, observations);

  const toWrite: RawObservation[] = [];
  const violations: QuarantineCandidate[] = [];
  for (const o of observations) {
    const prev = previous.get(o.indicatorId);
    const result = checkPlausibility({
      indicatorId: o.indicatorId,
      value: o.value,
      observedAt: o.observedAt,
      ...(prev ? { previous: prev } : {}),
    });
    if (result.ok) toWrite.push(o);
    else violations.push({ observation: o, result });
  }

  if (toWrite.length > 0) {
    const stmt = env.DB.prepare(
      `INSERT OR REPLACE INTO indicator_observations
         (indicator_id, observed_at, value, source_id, ingested_at, payload_hash, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    const batch: D1PreparedStatement[] = toWrite.map((o) =>
      stmt.bind(o.indicatorId, o.observedAt, o.value, o.sourceId, now, o.payloadHash, o.releasedAt ?? null),
    );
    await env.DB.batch(batch);
  }

  if (violations.length > 0) {
    // F7: the survivors are already committed. A failure on the quarantine path
    // (curator_captures insert, alert, KV) must NOT fail the adapter run or lose
    // the written count — log a warning and carry on.
    try {
      await quarantineViolations(env, violations);
    } catch (err) {
      console.warn(
        `writeObservations: quarantine path failed (survivors committed): ${sanitizeForLog((err as Error)?.message ?? String(err))}`,
      );
    }
  }

  return { written: toWrite, quarantined: violations.length };
}

interface QuarantineCandidate {
  observation: RawObservation;
  result: PlausibilityResult;
}

/**
 * The "previous" live reading the jump gate compares against, per indicator:
 * the latest live row whose `observed_at` is STRICTLY OLDER than the incoming
 * observation's `observed_at` (F2). This is the fix for same-period revisions —
 * re-ingesting a revised value for a period already on file must not be
 * jump-gated against the very row it replaces (that would compute a Δ over a
 * zero-day gap and quarantine a legitimate correction). With no strictly-older
 * row the jump gate is skipped (the range gate still applies).
 *
 * Live tier only (excludes hist:/seed rows). The batch can carry a different
 * observed_at per indicator; the threshold per indicator is that indicator's
 * freshest incoming observed_at (one reading per indicator is the norm). Kept
 * batched via a window function partitioned by indicator over the strictly-
 * older rows, so it stays cheap relative to the full snapshot selector.
 */
async function readPreviousLive(
  db: D1Database,
  observations: readonly RawObservation[],
): Promise<Map<string, { value: number; observedAt: string }>> {
  const out = new Map<string, { value: number; observedAt: string }>();
  // Per indicator, the freshest incoming observed_at is the strictly-older cutoff.
  const threshold = new Map<string, string>();
  for (const o of observations) {
    const cur = threshold.get(o.indicatorId);
    if (cur === undefined || o.observedAt > cur) threshold.set(o.indicatorId, o.observedAt);
  }
  if (threshold.size === 0) return out;

  const pairs = [...threshold.entries()];
  const predicate = pairs.map(() => "(indicator_id = ? AND observed_at < ?)").join(" OR ");
  const binds: unknown[] = [];
  for (const [indicatorId, cutoff] of pairs) binds.push(indicatorId, cutoff);

  const res = await db
    .prepare(
      `SELECT indicator_id, value, observed_at FROM (
         SELECT indicator_id, value, observed_at,
                ROW_NUMBER() OVER (PARTITION BY indicator_id ORDER BY observed_at DESC, ingested_at DESC) AS rn
         FROM indicator_observations
         WHERE (payload_hash IS NULL
                OR (payload_hash NOT LIKE 'hist:%' AND payload_hash NOT LIKE 'seed%'))
           AND (${predicate})
       ) ranked WHERE rn = 1`,
    )
    .bind(...binds)
    .all<{ indicator_id: string; value: number; observed_at: string }>();
  for (const r of res.results ?? []) {
    out.set(r.indicator_id, { value: r.value, observedAt: r.observed_at });
  }
  return out;
}

/**
 * Insert a `curator_captures` quarantine row for each violating observation and
 * fire one alert for the values that are due to page this run.
 *
 * TWO independent dedupe layers (F5c):
 *   - Row-insert dedupe is PERMANENT: the UNIQUE(source_id, content_sha256)
 *     partial index (migration 0012, scoped to model_id IS NULL) + ON CONFLICT
 *     DO NOTHING means a stuck bad value re-emitted every 5-minute tick never
 *     piles up duplicate rows.
 *   - Alert dedupe is a 24h KV WINDOW (pattern: the alert:source: keys): a
 *     persistent quarantine re-pages once a day instead of paging once and then
 *     going silent forever, so an unresolved breach keeps nagging until fixed.
 */
async function quarantineViolations(env: WriteEnv, violations: readonly QuarantineCandidate[]): Promise<void> {
  const capturedAt = new Date().toISOString();
  const toAlert: QuarantineCandidate[] = [];

  for (const { observation: o, result } of violations) {
    const verification = JSON.stringify({
      gate: "plausibility",
      bound: result.bound,
      detail: result.detail,
      applied: result.applied,
    });
    // Content hash over the raw observation + which bound tripped, so an
    // identical repoll of the same bad value dedupes but a different bad value
    // (or a different bound) is a fresh quarantine worth paging on.
    const contentSha256 = await sha256Hex(JSON.stringify({ o, bound: result.bound }));

    const sourceUrl = SOURCES[o.sourceId]?.homepage ?? `adapter:${o.sourceId}`;
    // model_id is left NULL (this is an ingest-staged, non-AI row), so it falls
    // under the partial UNIQUE index and ON CONFLICT DO NOTHING dedupes it.
    await env.DB
      .prepare(
        `INSERT INTO curator_captures
           (source_id, indicator_id, kind, status, captured_at, source_url, content_sha256,
            observed_at, value, payload, verification)
         VALUES (?, ?, 'observation', 'quarantined', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, content_sha256) WHERE model_id IS NULL DO NOTHING`,
      )
      .bind(
        o.sourceId,
        o.indicatorId,
        capturedAt,
        sourceUrl,
        contentSha256,
        o.observedAt,
        o.value,
        JSON.stringify(o),
        verification,
      )
      .run();

    // Alert dedupe: page once per 24h window per stuck value.
    const alertKey = `alert:quarantine:${o.sourceId}:${contentSha256}`;
    if (!(await kvGet(env, alertKey))) {
      toAlert.push({ observation: o, result });
      await kvPut(env, alertKey, capturedAt, QUARANTINE_ALERT_TTL_SEC);
    }
  }

  if (toAlert.length === 0) return;

  const lines = toAlert.map(
    ({ observation: o, result }) =>
      `• \`${o.indicatorId}\` = ${o.value} @ ${o.observedAt.slice(0, 10)} — tripped ${result.bound} (${result.detail})`,
  );
  const reviewUrl = `${(env.CURATOR_PUBLIC_URL ?? DEFAULT_CURATOR_PUBLIC_URL).replace(/\/$/, "")}/admin/captures?status=quarantined`;
  const text = [
    `*Tightrope plausibility quarantine* (${capturedAt.slice(0, 16).replace("T", " ")}Z)`,
    `${toAlert.length} observation${toAlert.length === 1 ? "" : "s"} withheld from indicator_observations:`,
    ...lines,
    `Review: \`curl -H "x-admin-token: $ADMIN_TOKEN" "${reviewUrl}"\``,
  ].join("\n");
  await postAlert(env, text);
}

/** Best-effort KV read for the alert-dedupe window (missing/erroring KV never blocks the alert). */
async function kvGet(env: WriteEnv, key: string): Promise<string | null> {
  try {
    return env.KV ? await env.KV.get(key) : null;
  } catch {
    return null;
  }
}

/** Best-effort KV write for the alert-dedupe window. */
async function kvPut(env: WriteEnv, key: string, value: string, ttlSec: number): Promise<void> {
  try {
    if (env.KV) await env.KV.put(key, value, { expirationTtl: ttlSec });
  } catch {
    /* best-effort dedupe mark */
  }
}

export interface HistoricalWriteRejection {
  reason: string;
  indicatorId: string;
  observedAt: string;
  value: number;
}

export interface HistoricalWriteResult {
  attempted: number;
  written: number;
  rejected: HistoricalWriteRejection[];
  dryRun: boolean;
}

/**
 * Write historical observations with defensive guardrails:
 *
 *   - refuses rows dated today-UTC or later (live path owns today);
 *   - refuses NaN / ±Infinity values;
 *   - refuses rows whose `payloadHash` is missing the `hist:` prefix, so the
 *     writer can never be tricked into emitting a row that SQL treats as live;
 *   - batches writes at `HIST_BATCH_SIZE` to stay comfortably under D1's
 *     100-statement batch limit;
 *   - supports dry-run: returns the rejection list and a preview count
 *     without issuing any SQL.
 *
 * `overwrite` controls the verb: `true` → `INSERT OR REPLACE` (default, for
 * idempotent reruns); `false` → `INSERT OR IGNORE` (freeze a vintage, reject
 * later upstream revisions).
 */
const HIST_BATCH_SIZE = 50;

export async function writeHistoricalObservations(
  db: D1Database,
  observations: readonly RawObservation[],
  opts: { dryRun: boolean; overwrite: boolean },
): Promise<HistoricalWriteResult> {
  const rejected: HistoricalWriteRejection[] = [];
  const filtered: RawObservation[] = [];
  const today = new Date();
  const todayUtcStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  for (const o of observations) {
    const ts = Date.parse(o.observedAt);
    if (!Number.isFinite(ts)) {
      rejected.push({ reason: "invalid observed_at", indicatorId: o.indicatorId, observedAt: o.observedAt, value: o.value });
      continue;
    }
    if (ts >= todayUtcStart) {
      rejected.push({ reason: "observed_at is today-UTC or later", indicatorId: o.indicatorId, observedAt: o.observedAt, value: o.value });
      continue;
    }
    if (!Number.isFinite(o.value)) {
      rejected.push({ reason: "non-finite value", indicatorId: o.indicatorId, observedAt: o.observedAt, value: o.value });
      continue;
    }
    if (!o.payloadHash.startsWith("hist:")) {
      rejected.push({ reason: "payload_hash missing 'hist:' prefix", indicatorId: o.indicatorId, observedAt: o.observedAt, value: o.value });
      continue;
    }
    filtered.push(o);
  }

  if (opts.dryRun || filtered.length === 0) {
    return { attempted: observations.length, written: 0, rejected, dryRun: opts.dryRun };
  }

  const verb = opts.overwrite ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
  const stmt = db.prepare(
    `${verb} INTO indicator_observations
       (indicator_id, observed_at, value, source_id, ingested_at, payload_hash, released_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  let written = 0;
  for (let i = 0; i < filtered.length; i += HIST_BATCH_SIZE) {
    const slice = filtered.slice(i, i + HIST_BATCH_SIZE);
    const batch: D1PreparedStatement[] = slice.map((o) =>
      stmt.bind(o.indicatorId, o.observedAt, o.value, o.sourceId, now, o.payloadHash, o.releasedAt ?? null),
    );
    await db.batch(batch);
    written += slice.length;
  }
  return { attempted: observations.length, written, rejected, dryRun: false };
}
