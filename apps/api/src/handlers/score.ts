import type { ScoreHistory, ScoreSnapshot } from "@tightrope/shared";
import { PILLAR_ORDER } from "@tightrope/shared";
import { json, notSeeded } from "../lib/router.js";
import { kvGetJson, kvPutJson, readThrough } from "../lib/cache.js";
import { buildHistoryFromD1, buildSnapshotFromD1 } from "../lib/db.js";

/** KV snapshot is only trusted if at most this old. Beyond, we re-read from D1. */
const SNAPSHOT_MAX_AGE_MS = 30 * 60_000;
/** Same threshold for the 90-day history KV slice. */
const HISTORY_MAX_AGE_MS = 30 * 60_000;

function snapshotIsFresh(snapshot: ScoreSnapshot): boolean {
  const ts = Date.parse(snapshot.headline.updatedAt);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < SNAPSHOT_MAX_AGE_MS;
}

/**
 * A cached snapshot from an older recompute pipeline can carry empty
 * `contributions` arrays even when the headline + pillar values are fine.
 * The /explore simulator and source-health surfaces depend on populated
 * contributions; treat an empty-contributions cache as cold.
 */
function snapshotHasContributions(snapshot: ScoreSnapshot): boolean {
  for (const p of PILLAR_ORDER) {
    if ((snapshot.pillars[p]?.contributions?.length ?? 0) > 0) return true;
  }
  return false;
}

/**
 * The cached 90-day slice is fresh if its newest point is within
 * `HISTORY_MAX_AGE_MS`. Empty/degenerate cache → not fresh, force a
 * rebuild. Wrong schema version → not fresh.
 */
function historyIsFresh(history: ScoreHistory): boolean {
  if (history.schemaVersion !== 1) return false;
  if (history.points.length === 0) return false;
  const last = history.points[history.points.length - 1]!.timestamp;
  const ts = Date.parse(last);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < HISTORY_MAX_AGE_MS;
}

/**
 * True when a snapshot is an empty-seed placeholder: either the headline row
 * is missing (we default updatedAt to `new Date()` in that case, but the value
 * is 0 for every pillar) or we're still looking at unix-epoch-dated zeros.
 */
function looksUnseeded(snapshot: ScoreSnapshot): boolean {
  const { headline, pillars } = snapshot;
  const allPillarsZero = Object.values(pillars).every((p) => p.value === 0);
  if (!allPillarsZero) return false;
  if (headline.value !== 0) return false;
  if (!headline.updatedAt) return true;
  const tsMs = Date.parse(headline.updatedAt);
  // Epoch dates indicate we constructed a placeholder rather than read a real row.
  return !Number.isFinite(tsMs) || tsMs < Date.UTC(2000, 0, 1);
}

const ALLOWED_SCORE_PARAMS = new Set<string>([]);
const ALLOWED_HISTORY_PARAMS = new Set<string>(["days"]);

export async function handleScore(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const unknown = unknownParams(url, ALLOWED_SCORE_PARAMS);
  if (unknown) return json({ error: `unknown query parameter: ${unknown}`, code: "BAD_QUERY" }, 400);

  try {
    const cached = await kvGetJson<ScoreSnapshot>(env, "score:latest");
    let snapshot: ScoreSnapshot;
    if (cached && cached.schemaVersion === 1 && snapshotIsFresh(cached) && snapshotHasContributions(cached)) {
      snapshot = cached;
    } else {
      snapshot = await buildSnapshotFromD1(env);
      // Re-prime KV so the next reader within the freshness window can skip D1.
      ctx.waitUntil(kvPutJson(env, "score:latest", snapshot));
    }
    if (looksUnseeded(snapshot)) return notSeeded();
    return json(snapshot);
  } catch (err) {
    console.error("score snapshot failed", err);
    return json({ error: "failed to load score snapshot", code: "DB_ERROR" }, 500);
  }
}

export async function handleScoreHistory(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const unknown = unknownParams(url, ALLOWED_HISTORY_PARAMS);
  if (unknown) return json({ error: `unknown query parameter: ${unknown}`, code: "BAD_QUERY" }, 400);

  const raw = url.searchParams.get("days") ?? "30";
  const days = Number.parseInt(raw, 10);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return json({ error: "days must be an integer between 1 and 365", code: "BAD_QUERY" }, 400);
  }

  try {
    // 90d is the only bucket we cache in KV (per AGENT_CONTRACTS.md). Other
    // ranges go direct to D1; they are comparatively rare. The freshness
    // predicate guards against serving a six-hour-old slice that survived
    // a recompute outage — without it the consumer would believe the
    // dashboard had stopped moving.
    if (days === 90) {
      const history = await readThrough<ScoreHistory>(
        env,
        "score:history:90d",
        () => buildHistoryFromD1(env, 90),
        ctx,
        historyIsFresh,
      );
      return json(history);
    }
    const history = await buildHistoryFromD1(env, days);
    // Best-effort cache of 90d slice on the side if we just computed a wider one.
    if (days > 90) {
      const trimmed: ScoreHistory = {
        ...history,
        points: history.points.slice(-90),
        rangeDays: 90,
      };
      ctx.waitUntil(kvPutJson(env, "score:history:90d", trimmed));
    }
    return json(history);
  } catch (err) {
    console.error("score history failed", err);
    return json({ error: "failed to load score history", code: "DB_ERROR" }, 500);
  }
}

function unknownParams(url: URL, allowed: Set<string>): string | null {
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) return key;
  return null;
}
