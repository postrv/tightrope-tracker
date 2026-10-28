import type { RawObservation } from "@tightrope/data-sources";
import { BASELINE_START_ISO, INDICATORS } from "@tightrope/shared";

export interface ExistingBaselineRow {
  indicator_id: string; observed_at: string; value: number; source_id: string;
  payload_hash: string | null; released_at: string | null;
}

/** Enforce the reviewed missing-leading-history scope before a backfill. An
 * exact already-inserted candidate is allowed for resumability/idempotence;
 * an extra timestamp on an existing reference day is never a missing day. */
export function guardLeadingBaselineBackfill(
  existing: readonly ExistingBaselineRow[],
  candidates: readonly RawObservation[],
  originalFirstDay: Readonly<Record<string, string>>,
): { missing: number; alreadyPresent: number } {
  const key = (id: string, date: string) => `${id}|${date}`;
  const byKey = new Map<string, RawObservation>();
  const byDay = new Map<string, ExistingBaselineRow[]>();
  const candidateDays = new Set<string>();
  for (const c of candidates) {
    const def = INDICATORS[c.indicatorId];
    const cutoff = originalFirstDay[c.indicatorId];
    const date = c.observedAt.slice(0, 10);
    if (!def || c.sourceId !== def.sourceId || !cutoff || !c.payloadHash.startsWith("hist:")
      || !Number.isFinite(Date.parse(c.observedAt)) || c.observedAt < BASELINE_START_ISO
      || date >= cutoff || !Number.isFinite(c.value)) throw new Error(`Candidate outside reviewed leading scope: ${c.indicatorId} ${c.observedAt}`);
    if (candidateDays.has(key(c.indicatorId, date))) throw new Error(`Duplicate candidate reference day: ${c.indicatorId} ${date}`);
    candidateDays.add(key(c.indicatorId, date));
    byKey.set(key(c.indicatorId, c.observedAt), c);
  }
  const matches = (r: ExistingBaselineRow, c: RawObservation) => r.value === c.value && r.source_id === c.sourceId
    && r.payload_hash === c.payloadHash && (r.released_at ?? null) === (c.releasedAt ?? null);
  for (const r of existing) {
    const cutoff = originalFirstDay[r.indicator_id];
    if (!cutoff) continue;
    const dayKey = key(r.indicator_id, r.observed_at.slice(0, 10));
    byDay.set(dayKey, [...(byDay.get(dayKey) ?? []), r]);
    if (r.observed_at.slice(0, 10) < cutoff) {
      const approved = byKey.get(key(r.indicator_id, r.observed_at));
      if (!approved || !matches(r, approved)) throw new Error(`Unreviewed earlier history now exists: ${r.indicator_id} ${r.observed_at}`);
    }
  }
  let alreadyPresent = 0;
  for (const c of candidates) {
    const rows = byDay.get(key(c.indicatorId, c.observedAt.slice(0, 10))) ?? [];
    if (rows.length === 0) continue;
    if (rows.length !== 1 || rows[0]!.observed_at !== c.observedAt || !matches(rows[0]!, c)) {
      throw new Error(`Existing reference day would be duplicated or contradicted: ${c.indicatorId} ${c.observedAt}`);
    }
    alreadyPresent++;
  }
  return { missing: candidates.length - alreadyPresent, alreadyPresent };
}
