import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { RawObservation } from "@tightrope/data-sources";
import { historicalPayloadHash as sharedHistoricalPayloadHash } from "@tightrope/data-sources";
import { SOURCES, checkPlausibility, type PlausibilityResult } from "@tightrope/shared";
import type { Env } from "../env.js";
import { postAlert } from "./alertWebhook.js";
import { sha256Hex } from "./hash.js";

/** Re-export so the ingest worker can reach it via a single import path. */
export const historicalPayloadHash = sharedHistoricalPayloadHash;

/** Bindings writeObservations needs: D1 for the write + quarantine, webhook for the alert. */
type WriteEnv = Pick<Env, "DB" | "ALERT_WEBHOOK_URL">;

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
 * Returns the number of observations actually written (quarantined rows are
 * excluded from the count, so the audit's rows_written reflects reality).
 */
export async function writeObservations(
  env: WriteEnv,
  observations: readonly RawObservation[],
): Promise<number> {
  if (observations.length === 0) return 0;

  // Previous live value per indicator, for the max-jump check (the value
  // already on file BEFORE this write).
  const previous = await readPreviousLive(env.DB, observations.map((o) => o.indicatorId));

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
    await quarantineViolations(env, violations);
  }

  return toWrite.length;
}

interface QuarantineCandidate {
  observation: RawObservation;
  result: PlausibilityResult;
}

/**
 * Latest live value per indicator among `indicatorIds` — the "previous"
 * reading the jump gate compares against. Live tier only (excludes hist:/seed
 * rows) and filtered to just the batch's indicators, so it stays cheap
 * relative to the full two-tier snapshot selector.
 */
async function readPreviousLive(
  db: D1Database,
  indicatorIds: readonly string[],
): Promise<Map<string, { value: number; observedAt: string }>> {
  const unique = [...new Set(indicatorIds)];
  const out = new Map<string, { value: number; observedAt: string }>();
  if (unique.length === 0) return out;
  const placeholders = unique.map(() => "?").join(", ");
  const res = await db
    .prepare(
      `SELECT indicator_id, value, observed_at FROM (
         SELECT indicator_id, value, observed_at,
                ROW_NUMBER() OVER (PARTITION BY indicator_id ORDER BY ingested_at DESC) AS rn
         FROM indicator_observations
         WHERE indicator_id IN (${placeholders})
           AND (payload_hash IS NULL
                OR (payload_hash NOT LIKE 'hist:%' AND payload_hash NOT LIKE 'seed%'))
       ) ranked WHERE rn = 1`,
    )
    .bind(...unique)
    .all<{ indicator_id: string; value: number; observed_at: string }>();
  for (const r of res.results ?? []) {
    out.set(r.indicator_id, { value: r.value, observedAt: r.observed_at });
  }
  return out;
}

/**
 * Insert a `curator_captures` quarantine row for each violating observation
 * and fire one alert for the batch of newly-quarantined values.
 *
 * Dedupe mirrors the timeline-candidate path: a quarantine keyed on
 * (source_id, content_sha256) that already exists is skipped, so a stuck bad
 * value re-emitted every 5-minute tick pages once, not forever. The webhook
 * only names values that were actually inserted this run.
 */
async function quarantineViolations(env: WriteEnv, violations: readonly QuarantineCandidate[]): Promise<void> {
  const capturedAt = new Date().toISOString();
  const alerted: QuarantineCandidate[] = [];

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
    const contentSha256 = await sha256Hex(
      JSON.stringify({ o, bound: result.bound }),
    );
    const existing = await env.DB
      .prepare("SELECT 1 AS one FROM curator_captures WHERE source_id = ? AND content_sha256 = ? LIMIT 1")
      .bind(o.sourceId, contentSha256)
      .first<{ one: number }>();
    if (existing) continue;

    const sourceUrl = SOURCES[o.sourceId]?.homepage ?? `adapter:${o.sourceId}`;
    await env.DB
      .prepare(
        `INSERT INTO curator_captures
           (source_id, indicator_id, kind, status, captured_at, source_url, content_sha256,
            observed_at, value, payload, verification)
         VALUES (?, ?, 'observation', 'quarantined', ?, ?, ?, ?, ?, ?, ?)`,
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
    alerted.push({ observation: o, result });
  }

  if (alerted.length === 0) return;

  const lines = alerted.map(
    ({ observation: o, result }) =>
      `• \`${o.indicatorId}\` = ${o.value} @ ${o.observedAt.slice(0, 10)} — tripped ${result.bound} (${result.detail})`,
  );
  const text = [
    `*Tightrope plausibility quarantine* (${capturedAt.slice(0, 16).replace("T", " ")}Z)`,
    `${alerted.length} observation${alerted.length === 1 ? "" : "s"} withheld from indicator_observations:`,
    ...lines,
    `Review: \`curl -H "x-admin-token: $ADMIN_TOKEN" "https://curator.tightropetracker.uk/admin/captures?status=quarantined"\``,
  ].join("\n");
  await postAlert(env, text);
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
