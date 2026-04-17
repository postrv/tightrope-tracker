/**
 * Shared data accessor for OG cards. Reads the score snapshot from KV; on miss
 * falls back to a minimal D1 read. Matches the pattern in apps/api/src/lib/db.ts
 * but is trimmed to just the fields a card actually needs.
 */
import type { PillarId, ScoreSnapshot, PillarScore, HeadlineScore, Iso8601 } from "@tightrope/shared";
import { PILLAR_ORDER, PILLARS, bandFor } from "@tightrope/shared";

export async function loadSnapshot(env: Env): Promise<ScoreSnapshot> {
  const cached = await env.KV.get<ScoreSnapshot>("score:latest", "json");
  if (cached && cached.schemaVersion === 1) return cached;
  return buildFromD1(env);
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

  const pillars = {} as Record<PillarId, PillarScore>;
  for (const p of PILLAR_ORDER) {
    const row = pillarsLatest.results.find((r) => r.id === p);
    const value = row?.value ?? 0;
    pillars[p] = {
      pillar: p,
      value,
      band: (row?.band as PillarScore["band"]) ?? bandFor(value).id,
      weight: PILLARS[p].weight,
      contributions: [],
      trend7d: "flat",
      delta7d: 0,
      sparkline30d: [],
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
  };

  return { headline, pillars, schemaVersion: 1 };
}
