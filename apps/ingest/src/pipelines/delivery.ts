import {
  fetchGovUkCandidates,
  mhclgHousingAdapter,
  type TimelineEventCandidate,
} from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { closeAuditFailure, closeAuditSuccess, openAudit } from "../lib/audit.js";
import { sha256Hex } from "../lib/hash.js";
import { runAdapterSafe } from "./runAdapter.js";

export async function ingestDelivery(env: Env): Promise<{ housingRows: number; candidates: number }> {
  const housing = await runAdapterSafe(env, mhclgHousingAdapter);

  // gov.uk feed is separate -- it produces timeline event candidates, not
  // observations. We manage the audit row ourselves so the DB still has a
  // record of the fetch attempt. A failure here is logged and audited but
  // does not propagate -- the rest of the scheduled run must still complete.
  const handle = await openAudit(env.DB, { sourceId: "gov_uk", sourceUrl: "https://www.gov.uk/government/announcements.atom" });
  let candidates: TimelineEventCandidate[] = [];
  try {
    const result = await fetchGovUkCandidates(globalThis.fetch);
    candidates = result.candidates;
    const payloadHash = await sha256Hex(JSON.stringify(candidates.map((c) => c.id).sort()));
    await closeAuditSuccess(env.DB, handle, { rowsWritten: 0, payloadHash });
    if (env.DLQ && candidates.length > 0) {
      try {
        await env.DLQ.send({ kind: "timeline_candidates", candidates });
      } catch { /* best-effort */ }
    }
  } catch (err) {
    await closeAuditFailure(env.DB, handle, err);
    console.warn(`ingestDelivery: gov.uk candidates failed -- ${(err as Error)?.message ?? String(err)}`);
  }

  return { housingRows: housing?.observations.length ?? 0, candidates: candidates.length };
}
