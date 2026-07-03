import { CADENCE_PERIOD_DAYS, computeSourceCadence, type ScoreSnapshot } from "@tightrope/shared";
import { readLatestObservations } from "@tightrope/snapshot";
import type { Env } from "../env";
import { postAlert } from "../lib/alert";
import { listCaptures } from "../lib/captures";

/**
 * Editorial readiness digest — Tue/Wed 06:30 UTC cron (AUTOMATION_PLAN Phase
 * 4). Posted to ALERT_WEBHOOK_URL. Sections:
 *   - headline + pillar scores with deltas (from score:latest in KV)
 *   - sources in amber/red cadence state (shared cadence helper over D1)
 *   - pending review-queue items, each with ready-to-paste approve/reject curls
 *   - upstream releases expected in the next 7 days (cadence registry)
 *   - values auto-published since the last digest (with quote + link)
 *   - approved delivery milestones awaiting fixture fold-back (seed parity)
 *
 * Copy is neutral — the schedule is referred to only as the "weekly editorial
 * deadline". Best-effort throughout: a missing section never aborts the digest.
 */
const CURATOR_ADMIN_BASE = "https://curator.tightropetracker.uk";
const LAST_DIGEST_KEY = "curator:digest:last";
const SNAPSHOT_KEY = "score:latest";
const DAY_MS = 24 * 60 * 60 * 1000;

export async function sendEditorialDigest(env: Env, now: Date = new Date()): Promise<void> {
  const sections: string[] = [
    `*Tightrope editorial readiness digest* (${now.toISOString().slice(0, 16).replace("T", " ")}Z)`,
    `Dataset status ahead of the weekly editorial deadline.`,
  ];

  sections.push(await scoreSection(env));
  sections.push(await cadenceSection(env, now));
  sections.push(await pendingSection(env));
  sections.push(await upcomingSection(env, now));
  const since = await readLastDigestAt(env);
  sections.push(await autoPublishedSection(env, since));
  sections.push(await milestoneParitySection(env, since));

  await postAlert(env, sections.filter(Boolean).join("\n\n"));
  await env.KV.put(LAST_DIGEST_KEY, now.toISOString()).catch(() => undefined);
}

async function scoreSection(env: Env): Promise<string> {
  const snap = await readSnapshot(env);
  if (!snap) return "*Scores:* score:latest unavailable.";
  const lines = [`*Headline:* ${round(snap.headline.value)} (${signed(snap.headline.delta30d)} 30d)`];
  for (const pid of Object.keys(snap.pillars)) {
    const p = snap.pillars[pid as keyof typeof snap.pillars];
    lines.push(`  • ${p.label}: ${round(p.value)} (${signed(p.delta7d)} 7d)${p.stale ? " ⚠︎stale" : ""}`);
  }
  return lines.join("\n");
}

async function cadenceSection(env: Env, now: Date): Promise<string> {
  const cadence = await cadenceEntries(env, now);
  const flagged = cadence.filter((c) => c.state !== "green");
  if (flagged.length === 0) return "*Cadence:* all sources green.";
  return ["*Cadence (amber/red):*", ...flagged.map((c) => `  • ${c.sourceId}: ${c.state} (last ${(c.latestReleasedAt ?? c.latestObservedAt).slice(0, 10)})`)].join("\n");
}

async function pendingSection(env: Env): Promise<string> {
  const pending = await listCaptures(env.DB, "pending", 50);
  if (pending.length === 0) return "*Pending review:* queue empty.";
  const lines = pending.map((c) => {
    const label = `${c.sourceId}/${c.indicatorId ?? c.kind} ${c.value ?? ""}`.trim();
    return [
      `  • #${c.id} ${label} (conf ${c.confidence ?? "n/a"})`,
      `    approve: curl -X POST -H "x-admin-token: $ADMIN_TOKEN" "${CURATOR_ADMIN_BASE}/admin/captures/${c.id}/approve"`,
      `    reject:  curl -X POST -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" -d '{"reason":"..."}' "${CURATOR_ADMIN_BASE}/admin/captures/${c.id}/reject"`,
    ].join("\n");
  });
  return [`*Pending review (${pending.length}):*`, ...lines].join("\n");
}

async function upcomingSection(env: Env, now: Date): Promise<string> {
  const cadence = await cadenceEntries(env, now);
  const soon: string[] = [];
  for (const c of cadence) {
    const period = CADENCE_PERIOD_DAYS[c.cadence];
    if (!Number.isFinite(period)) continue; // event cadence: no schedule
    const anchor = Date.parse(c.latestReleasedAt ?? c.latestObservedAt);
    if (!Number.isFinite(anchor)) continue;
    const nextExpected = anchor + period * DAY_MS;
    if (nextExpected >= now.getTime() && nextExpected <= now.getTime() + 7 * DAY_MS) {
      soon.push(`  • ${c.sourceId}: next release ~${new Date(nextExpected).toISOString().slice(0, 10)}`);
    }
  }
  if (soon.length === 0) return "*Expected next 7 days:* none scheduled.";
  return ["*Expected releases next 7 days:*", ...soon].join("\n");
}

async function autoPublishedSection(env: Env, since: string | null): Promise<string> {
  const rows = await env.DB
    .prepare(
      `SELECT id, source_id, indicator_id, value, observed_at, quote, source_url
         FROM curator_captures
        WHERE status = 'auto_published' ${since ? "AND created_at > ?" : ""}
        ORDER BY created_at DESC LIMIT 25`,
    )
    .bind(...(since ? [since] : []))
    .all<{ source_id: string; indicator_id: string; value: number; observed_at: string; quote: string; source_url: string }>();
  const list = rows.results ?? [];
  if (list.length === 0) return "*Auto-published since last digest:* none.";
  const lines = list.map(
    (r) => `  • ${r.indicator_id} = ${r.value} @ ${(r.observed_at ?? "").slice(0, 10)} — ${r.source_url}${r.quote ? `\n    "${truncate(r.quote, 200)}"` : ""}`,
  );
  return [`*Auto-published since last digest (${list.length}):*`, ...lines].join("\n");
}

async function milestoneParitySection(env: Env, since: string | null): Promise<string> {
  const rows = await env.DB
    .prepare(
      `SELECT indicator_id, value FROM curator_captures
        WHERE status = 'approved' AND kind = 'delivery_milestone' ${since ? "AND decided_at > ?" : ""}
        ORDER BY decided_at DESC LIMIT 25`,
    )
    .bind(...(since ? [since] : []))
    .all<{ indicator_id: string; value: number }>();
  const list = rows.results ?? [];
  if (list.length === 0) return "";
  const lines = list.map((r) => `  • ${r.indicator_id} = ${r.value}`);
  return ["*Fold back into delivery-milestones.json for seed parity:*", ...lines].join("\n");
}

// --- shared readers ---------------------------------------------------------

async function cadenceEntries(env: Env, now: Date) {
  const latest = await readLatestObservations(env.DB);
  return computeSourceCadence(
    latest.map((r) => ({ sourceId: r.source_id, observedAt: r.observed_at, releasedAt: r.released_at })),
    now,
  );
}

async function readSnapshot(env: Env): Promise<ScoreSnapshot | null> {
  try {
    const raw = await env.KV.get(SNAPSHOT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ScoreSnapshot;
  } catch {
    return null;
  }
}

async function readLastDigestAt(env: Env): Promise<string | null> {
  try {
    return (await env.KV.get(LAST_DIGEST_KEY)) ?? null;
  } catch {
    return null;
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
function signed(n: number): string {
  const r = round(n);
  return r >= 0 ? `+${r}` : `${r}`;
}
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
