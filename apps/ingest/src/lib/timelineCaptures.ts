import type { D1Database } from "@cloudflare/workers-types";
import type { TimelineEventCandidate } from "@tightrope/data-sources";
import { sanitizeForLog } from "@tightrope/shared";
import { sha256Hex } from "./hash.js";

const SOURCE_ID = "gov_uk";
const FEED_URL = "https://www.gov.uk/search/news-and-communications.atom";

export interface StageTimelineResult {
  inserted: number;
  skipped: number;
}

/**
 * Stage gov.uk timeline-event candidates into `curator_captures` for human
 * review (kind='timeline_event', status='pending').
 *
 * These candidates used to be pushed to the DLQ, whose consumer only logs and
 * acks — so they were effectively discarded unless an operator read Worker
 * logs. Routing them into the review queue (migration 0011) makes them
 * durable and actionable; approval flows through the Phase 3 admin endpoints.
 *
 * Dedupe: a candidate whose (source_id, content_sha256) already exists is
 * skipped, so re-polling the feed every delivery cron doesn't pile up
 * duplicate pending rows. content_sha256 is taken over the candidate's stable
 * content (id/title/link/publishedAt/summary/category), so a materially
 * edited announcement produces a fresh capture worth re-reviewing while an
 * unchanged repoll is ignored. An in-run guard also collapses two identical
 * candidates within a single fetch, and the INSERT uses `ON CONFLICT DO
 * NOTHING` against the partial UNIQUE index (migration 0012) to close the
 * check-then-act race (C7).
 *
 * Telemetry is counted AS WE GO: `inserted`/`skipped` are incremented inside
 * the loop, and any mid-loop DB failure is caught so the caller still receives
 * the true count of what was staged before the failure (C7) rather than losing
 * all progress to a thrown exception.
 */
export async function stageTimelineCandidates(
  db: D1Database,
  candidates: readonly TimelineEventCandidate[],
): Promise<StageTimelineResult> {
  const capturedAt = new Date().toISOString();
  const seenThisRun = new Set<string>();
  let inserted = 0;
  let skipped = 0;

  try {
    for (const candidate of candidates) {
      const contentSha256 = await sha256Hex(candidateContent(candidate));
      if (seenThisRun.has(contentSha256)) {
        skipped++;
        continue;
      }
      seenThisRun.add(contentSha256);

      const existing = await db
        .prepare("SELECT 1 AS one FROM curator_captures WHERE source_id = ? AND content_sha256 = ? LIMIT 1")
        .bind(SOURCE_ID, contentSha256)
        .first<{ one: number }>();
      if (existing) {
        skipped++;
        continue;
      }

      await db
        .prepare(
          `INSERT INTO curator_captures
             (source_id, kind, status, captured_at, source_url, content_sha256, payload)
           VALUES (?, 'timeline_event', 'pending', ?, ?, ?, ?)
           ON CONFLICT (source_id, content_sha256) WHERE model_id IS NULL DO NOTHING`,
        )
        .bind(SOURCE_ID, capturedAt, candidate.link || FEED_URL, contentSha256, JSON.stringify(candidate))
        .run();
      inserted++;
    }
  } catch (err) {
    // Best-effort staging: a mid-loop DB failure returns the true count staged
    // so far instead of discarding it (the caller treats staging as best-effort
    // and only logs). The already-inserted rows remain durable.
    console.warn(
      `stageTimelineCandidates: staging failed after ${inserted} inserted / ${skipped} skipped -- ${sanitizeForLog((err as Error)?.message ?? String(err))}`,
    );
  }

  return { inserted, skipped };
}

/** Stable content string for the dedupe hash — fixed field order. */
function candidateContent(c: TimelineEventCandidate): string {
  return [c.id, c.title, c.link, c.publishedAt, c.summary, c.categorySlug ?? ""].join("\n");
}
