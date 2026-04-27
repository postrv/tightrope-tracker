/**
 * Shared data accessor for OG cards. Reads the score snapshot from KV; on miss
 * falls back to a minimal D1 read. Matches the pattern in apps/api/src/lib/db.ts
 * but is trimmed to just the fields a card actually needs.
 */
import type { PillarId, ScoreSnapshot, PillarScore, HeadlineScore, Iso8601 } from "@tightrope/shared";
import { PILLAR_ORDER, PILLARS, bandFor } from "@tightrope/shared";

/**
 * KV snapshot is only trusted if at most this old. The api and web
 * workers use the same threshold; without it OG cards would render an
 * out-of-date headline number for up to 6 hours (the KV TTL) when
 * recompute pauses or breaks. 30 minutes is conservative — recompute
 * runs on a 5-minute cron, so a 30-min-old snapshot already means six
 * consecutive failed cycles.
 */
const KV_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

export async function loadSnapshot(env: Env): Promise<ScoreSnapshot> {
  const cached = await env.KV.get<ScoreSnapshot>("score:latest", "json");
  if (cached && cached.schemaVersion === 1 && isFresh(cached)) return cached;
  return buildFromD1(env);
}

function isFresh(snapshot: ScoreSnapshot): boolean {
  const ts = Date.parse(snapshot.headline.updatedAt);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < KV_SNAPSHOT_MAX_AGE_MS;
}

export interface CardIndicators {
  gilt30y: number | null;
}

export async function loadCardIndicators(env: Env): Promise<CardIndicators> {
  // Latest *live* gilt_30y reading. Same selector logic as the API and
  // ingest layers: pick by MAX(ingested_at) over rows whose payload_hash
  // is neither 'hist:*' nor 'seed*' so an editorial fixture with an
  // earlier observed_at can't lock the OG card onto a stale value.
  const row = await env.DB.prepare(
    `SELECT value FROM indicator_observations
     WHERE indicator_id = 'gilt_30y'
       AND (payload_hash IS NULL
            OR (payload_hash NOT LIKE 'hist:%' AND payload_hash NOT LIKE 'seed%'))
     ORDER BY ingested_at DESC LIMIT 1`,
  ).first<{ value: number }>();
  return { gilt30y: row?.value ?? null };
}

async function buildFromD1(env: Env): Promise<ScoreSnapshot> {
  const [headlineRow, pillarsLatest] = await Promise.all([
    env.DB.prepare(
      "SELECT observed_at, value, band, dominant, editorial FROM headline_scores ORDER BY observed_at DESC LIMIT 1",
    ).first<{ observed_at: string; value: number; band: string; dominant: string; editorial: string }>(),
    env.DB.prepare(
      `SELECT p.pillar_id AS id, p.value, p.band, p.observed_at
       FROM pillar_scores p
       JOIN (
         SELECT pillar_id, MAX(observed_at) AS ts FROM pillar_scores GROUP BY pillar_id
       ) m ON p.pillar_id = m.pillar_id AND p.observed_at = m.ts`,
    ).all<{ id: PillarId; value: number; band: string; observed_at: string }>(),
  ]);

  // The cold-cache fallback stamps `stale: true` on every level when the
  // underlying D1 row is past the same 30-min freshness window the live KV
  // gate uses. Without it the OG renderer would happily emit a card with a
  // five-minute-old timestamp showing zeroed deltas and an empty sparkline,
  // misreading as "today's market is flat" rather than "data is loading".
  const now = Date.now();
  const headlineAgeMs = headlineRow ? now - Date.parse(headlineRow.observed_at) : Number.POSITIVE_INFINITY;
  const isStaleFallback = !Number.isFinite(headlineAgeMs) || headlineAgeMs >= KV_SNAPSHOT_MAX_AGE_MS;

  const pillars = {} as Record<PillarId, PillarScore>;
  for (const p of PILLAR_ORDER) {
    const row = pillarsLatest.results.find((r) => r.id === p);
    const value = row?.value ?? 0;
    pillars[p] = {
      pillar: p,
      label: PILLARS[p].shortTitle,
      value,
      band: (row?.band as PillarScore["band"]) ?? bandFor(value).id,
      weight: PILLARS[p].weight,
      contributions: [],
      trend7d: "flat",
      delta7d: 0,
      trend30d: "flat",
      delta30d: 0,
      sparkline30d: [],
      ...(isStaleFallback ? { stale: true } : {}),
    };
  }

  const hValue = headlineRow?.value ?? 0;
  const headline: HeadlineScore = {
    value: hValue,
    band: (headlineRow?.band as HeadlineScore["band"]) ?? bandFor(hValue).id,
    editorial: headlineRow?.editorial ?? "",
    updatedAt: (headlineRow?.observed_at as Iso8601) ?? new Date().toISOString(),
    dominantPillar: (headlineRow?.dominant as PillarId) ?? "market",
    sparkline90d: [],
    delta24h: 0,
    delta30d: 0,
    deltaYtd: 0,
    ...(isStaleFallback ? { stale: true } : {}),
  };

  return { headline, pillars, schemaVersion: 1 };
}
