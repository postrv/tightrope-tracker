import {
  deliveryMilestonesAdapter,
  fetchGovUkCandidates,
  mhclgHousingAdapter,
  type TimelineEventCandidate,
} from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { closeAuditFailure, closeAuditSuccess, openAudit } from "../lib/audit.js";
import { sha256Hex } from "../lib/hash.js";
import { stageTimelineCandidates, type StageTimelineResult } from "../lib/timelineCaptures.js";
import { runAdapterSafe } from "./runAdapter.js";

export async function ingestDelivery(
  env: Env,
): Promise<{ housingRows: number; candidates: number; timelineStaged: number; timelineSkipped: number }> {
  const housing = await runAdapterSafe(env, mhclgHousingAdapter);
  // Editorial delivery-milestone indicators (new_towns_milestones,
  // bics_rollout, industrial_strategy, smr_programme) live in a
  // fixture with a 90-day freshness guard. Run under runAdapterSafe so
  // a stale fixture audits as a failure without taking out the rest of
  // the pipeline.
  await runAdapterSafe(env, deliveryMilestonesAdapter);

  // gov.uk feed is separate -- it produces timeline event candidates, not
  // observations. We manage the audit row ourselves so the DB still has a
  // record of the fetch attempt. A failure here is logged and audited but
  // does not propagate -- the rest of the scheduled run must still complete.
  const handle = await openAudit(env.DB, { sourceId: "gov_uk", sourceUrl: "https://www.gov.uk/search/news-and-communications.atom" });
  let candidates: TimelineEventCandidate[] = [];
  let staged: StageTimelineResult = { inserted: 0, skipped: 0 };
  try {
    const result = await fetchGovUkCandidates(globalThis.fetch);
    candidates = result.candidates;
    const payloadHash = await sha256Hex(JSON.stringify(candidates.map((c) => c.id).sort()));
    // gov.uk RSS legitimately returns zero observations — it harvests
    // timeline-event candidates via the side-channel above. Mark
    // emitsNoObservations so the audit closer keeps this as 'success'
    // rather than downgrading to 'partial' on rows_written === 0.
    await closeAuditSuccess(env.DB, handle, { rowsWritten: 0, payloadHash, emitsNoObservations: true });
    // Stage candidates into curator_captures for human review instead of
    // pushing to the DLQ (whose consumer just logs + acks — effectively a
    // discard). Best-effort, in its own guard, so a staging DB hiccup can't
    // flip the already-closed fetch audit row to failure. Dedupe lives in
    // stageTimelineCandidates.
    if (candidates.length > 0) {
      try {
        staged = await stageTimelineCandidates(env.DB, candidates);
      } catch (err) {
        console.warn(`ingestDelivery: staging gov.uk candidates failed -- ${(err as Error)?.message ?? String(err)}`);
      }
    }
  } catch (err) {
    await closeAuditFailure(env.DB, handle, err);
    console.warn(`ingestDelivery: gov.uk candidates failed -- ${(err as Error)?.message ?? String(err)}`);
  }

  return {
    housingRows: housing?.observations.length ?? 0,
    candidates: candidates.length,
    timelineStaged: staged.inserted,
    timelineSkipped: staged.skipped,
  };
}
