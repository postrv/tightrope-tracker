import { describe, expect, it, vi } from "vitest";
import { readLatestObservations } from "@tightrope/snapshot";
import type { Env } from "../env.js";

vi.mock("@tightrope/snapshot", () => ({
  readLatestObservations: vi.fn(async () => []),
}));
vi.mock("../lib/adminBackoff.js", () => ({
  adminAuthGate: vi.fn(async () => ({ ok: true })),
}));

const { handleAdminHealth } = await import("../health.js");

const ATTEMPT_AT = "2026-10-13T09:00:00.000Z";
const SUCCESS_AT = "2026-10-13T08:00:00.000Z";

function makeEnv(
  statuses: readonly string[],
  sourceIds: readonly string[] = statuses.map((_, index) => `source_${index}`),
  errors: readonly (string | null)[] = [],
): Env {
  const attempts = statuses.map((status, index) => ({
    source_id: sourceIds[index],
    started_at: ATTEMPT_AT,
    status,
    rows_written: 1,
    error: errors[index] ?? null,
  }));
  const successes = statuses.map((_, index) => ({
    source_id: sourceIds[index],
    last_success: SUCCESS_AT,
  }));
  return {
    ADMIN_TOKEN: "test-token",
    DB: {
      prepare: (sql: string) => ({
        all: async () => ({ results: sql.includes("AS last_success") ? successes : attempts }),
      }),
    },
  } as unknown as Env;
}

async function readHealth(
  statuses: readonly string[],
  sourceIds?: readonly string[],
  errors?: readonly (string | null)[],
) {
  const response = await handleAdminHealth(
    new Request("https://ingest.test/admin/health", { headers: { "x-admin-token": "test-token" } }),
    makeEnv(statuses, sourceIds, errors),
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    ok: boolean;
    adapters: Array<{
      sourceId: string;
      lastAttemptStatus: string;
      lastSuccessAt: string | null;
      cadenceState: string | null;
    }>;
  }>;
}

describe("admin ingestion health", () => {
  it("treats an unchanged fetch as healthy alongside a new-value success", async () => {
    const health = await readHealth(["success", "unchanged"]);
    expect(health.ok).toBe(true);
    expect(health.adapters.map((a) => a.lastAttemptStatus)).toEqual(["success", "unchanged"]);
    expect(health.adapters[1]?.lastSuccessAt).toBe(SUCCESS_AT);
  });

  it.each(["failure", "partial", "dlq"])("remains unhealthy after a %s attempt", async (status) => {
    const health = await readHealth(["success", status]);
    expect(health.ok).toBe(false);
  });

  it("keeps an old unknown DLQ and historical backfill failure visible without failing active health", async () => {
    const health = await readHealth(
      ["dlq", "failure", "success"],
      ["unknown", "eia_brent:historical", "growth_sentiment"],
    );
    expect(health.ok).toBe(true);
    expect(health.adapters).toHaveLength(3);
  });

  it("suppresses stale cadence only for an explicitly disabled curator skip", async () => {
    const oldObservation = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(readLatestObservations).mockResolvedValueOnce([
      { indicator_id: "rics_price_balance", source_id: "rics_rms", observed_at: oldObservation, released_at: null, value: -20, ingested_at: ATTEMPT_AT },
      { indicator_id: "housing_trajectory", source_id: "mhclg", observed_at: oldObservation, released_at: null, value: 45, ingested_at: ATTEMPT_AT },
    ]);

    const health = await readHealth(
      ["unchanged", "unchanged"],
      ["rics_rms", "mhclg"],
      ["skipped: disabled — RICS curator fetch is disabled", null],
    );

    expect(health.ok).toBe(true);
    expect(health.adapters.find((a) => a.sourceId === "rics_rms")?.cadenceState).toBeNull();
    expect(health.adapters.find((a) => a.sourceId === "mhclg")?.cadenceState).toBe("red");
  });
});
