import { computeSourceCadence, type CadenceState } from "@tightrope/shared";
import { readLatestObservations } from "@tightrope/snapshot";
import type { Env } from "../env";
import { postAlert } from "../lib/alert";

/**
 * Staleness monitor (AUTOMATION_PLAN 2.1 / Phase 4 07:00 cron).
 *
 * Evaluates the release-cadence state of every source from the latest D1
 * observations, then alerts (deduped) on any source that has transitioned into
 * `red` from a non-red state since the last run. Previous states are tracked in
 * KV so a source that's been red for days pages once, not daily.
 */
const STATE_KEY = "curator:cadence:states";

export interface StalenessResult {
  evaluated: number;
  transitions: Array<{ sourceId: string; from: CadenceState | "unknown"; to: CadenceState }>;
}

export async function runStalenessMonitor(env: Env, now: Date = new Date()): Promise<StalenessResult> {
  const latest = await readLatestObservations(env.DB);
  const cadence = computeSourceCadence(
    latest.map((r) => ({ sourceId: r.source_id, observedAt: r.observed_at, releasedAt: r.released_at })),
    now,
  );

  const previous = await readPreviousStates(env);
  const nextStates: Record<string, CadenceState> = {};
  const transitions: StalenessResult["transitions"] = [];

  for (const entry of cadence) {
    nextStates[entry.sourceId] = entry.state;
    const prev = previous[entry.sourceId] ?? "unknown";
    // Alert on a fresh escalation INTO red (amber→red or green→red), not on a
    // source that was already red last run.
    if (entry.state === "red" && prev !== "red") {
      transitions.push({ sourceId: entry.sourceId, from: prev, to: "red" });
    }
  }

  if (transitions.length > 0) {
    const lines = transitions.map(
      (t) => `• \`${t.sourceId}\` ${t.from} → ${t.to} — a scheduled upstream release is now overdue past grace.`,
    );
    await postAlert(
      env,
      [
        `*Tightrope cadence escalation* (${now.toISOString().slice(0, 16).replace("T", " ")}Z)`,
        `${transitions.length} source${transitions.length === 1 ? "" : "s"} went red:`,
        ...lines,
      ].join("\n"),
    );
  }

  await env.KV.put(STATE_KEY, JSON.stringify(nextStates)).catch(() => undefined);
  return { evaluated: cadence.length, transitions };
}

async function readPreviousStates(env: Env): Promise<Record<string, CadenceState>> {
  try {
    const raw = await env.KV.get(STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, CadenceState>) : {};
  } catch {
    return {};
  }
}
