/**
 * `/api/v1/methodology/baselines`
 *
 * Returns a compact quantile summary of every indicator's historical
 * baseline (2019-present minus the 2020 COVID outlier window). Designed
 * to be consumed by the in-browser /explore simulator so it can run the
 * real empirical-CDF normalisation rather than a linear approximation.
 *
 * Cached in KV at `methodology:baselines` with a 24h TTL: baselines drift
 * glacially -- a fresh BoE yield observation today moves the percentile
 * rank of any specific value by O(1/n), which for n ~ 1500 is invisible
 * at the UI's rounding resolution. We still re-read on cache miss so a
 * cold KV does not 503 the whole simulator.
 *
 * Schema is versioned via `schemaVersion` so a future change to the
 * summary structure can be detected by the client.
 */
import type { BaselineSummary } from "@tightrope/methodology";
import { summariseBaseline } from "@tightrope/methodology";
import {
  BASELINE_START_ISO,
  COVID_EXCLUDE_START_ISO,
  COVID_EXCLUDE_END_ISO,
} from "@tightrope/shared";
import { json } from "../lib/router.js";
import { kvGetJson, kvPutJson, readThrough } from "../lib/cache.js";

/** Public payload: every indicator with a non-empty baseline gets a summary. */
export interface MethodologyBaselinesPayload {
  schemaVersion: 1;
  /** ISO timestamp of when the summary was assembled. */
  generatedAt: string;
  /** Window the baseline is sourced from (mirrors ingest constants). */
  baselineStart: string;
  baselineEnd: string;
  /** COVID exclusion window applied. */
  excludeStart: string;
  excludeEnd: string;
  /** Map of indicator id to summary. Indicators with no historical rows are omitted. */
  baselines: Record<string, BaselineSummary>;
}

/**
 * If the cached payload's `generatedAt` is older than this, force a
 * rebuild. Twenty-four hours is a deliberate compromise: short enough
 * that a backfill rerun lands in the simulator the same day, long
 * enough that the recompute CRON's KV writes don't hammer D1.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const KV_KEY = "methodology:baselines";

interface BaselineRow {
  indicator_id: string;
  value: number;
}

function isFresh(payload: MethodologyBaselinesPayload): boolean {
  if (payload.schemaVersion !== 1) return false;
  const ts = Date.parse(payload.generatedAt);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < MAX_AGE_MS;
}

export async function handleMethodologyBaselines(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  for (const key of url.searchParams.keys()) {
    return json({ error: `unknown query parameter: ${key}`, code: "BAD_QUERY" }, 400);
  }
  try {
    const payload = await readThrough<MethodologyBaselinesPayload>(
      env,
      KV_KEY,
      () => buildBaselinesPayload(env),
      ctx,
      isFresh,
    );
    return json(payload);
  } catch (err) {
    // SEC-8: opaque INTERNAL discriminator only.
    console.error("methodology baselines failed", err);
    return json(
      { error: "failed to load methodology baselines", code: "INTERNAL" },
      500,
    );
  }
}

/**
 * Direct-from-D1 path. Exposed as well as wired into the handler so the
 * web app's loadBaselineSummaries fallback can call it without the KV
 * read-through wrapper if it wants to.
 */
export async function buildBaselinesPayload(env: Env): Promise<MethodologyBaselinesPayload> {
  const db = env.DB;
  const res = await db
    .prepare(
      `SELECT indicator_id, value
       FROM indicator_observations
       WHERE observed_at >= ?
         AND NOT (observed_at >= ? AND observed_at <= ?)
       ORDER BY indicator_id, observed_at ASC`,
    )
    .bind(BASELINE_START_ISO, COVID_EXCLUDE_START_ISO, COVID_EXCLUDE_END_ISO)
    .all<BaselineRow>();
  const rows = res.results ?? [];
  const byIndicator = new Map<string, number[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.value)) continue;
    const arr = byIndicator.get(row.indicator_id) ?? [];
    arr.push(row.value);
    byIndicator.set(row.indicator_id, arr);
  }
  const baselines: Record<string, BaselineSummary> = {};
  for (const [id, samples] of byIndicator) {
    if (samples.length === 0) continue;
    baselines[id] = summariseBaseline(samples);
  }
  const generatedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    generatedAt,
    baselineStart: BASELINE_START_ISO,
    baselineEnd: generatedAt,
    excludeStart: COVID_EXCLUDE_START_ISO,
    excludeEnd: COVID_EXCLUDE_END_ISO,
    baselines,
  };
}

/** Test-only: surface the cache helpers used by the handler. */
export const __testing = { isFresh, KV_KEY, kvGetJson, kvPutJson };
