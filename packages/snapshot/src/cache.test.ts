/**
 * Tests for the single-writer cache primers. These two functions are the
 * ONLY code paths permitted to write `score:latest` / `score:history:90d`.
 */
import { describe, expect, it } from "vitest";
import type { ScoreHistory, ScoreSnapshot } from "@tightrope/shared";
import {
  HISTORY_CACHE_KEY,
  HISTORY_CACHE_TTL_SECONDS,
  SNAPSHOT_CACHE_KEY,
  SNAPSHOT_CACHE_TTL_SECONDS,
  primeHistoryCache,
  primeSnapshotCache,
  type KvWriter,
} from "./cache.js";

interface Put {
  key: string;
  body: string;
  opts?: { expirationTtl?: number };
}

function makeKv(puts: Put[]): KvWriter {
  return {
    put: async (key: string, body: string, opts?: { expirationTtl?: number }) => {
      puts.push({ key, body, ...(opts ? { opts } : {}) });
    },
  };
}

const SNAPSHOT: ScoreSnapshot = {
  headline: {
    value: 52,
    band: "strained",
    editorial: "…",
    updatedAt: "2026-07-03T00:00:00Z" as ScoreSnapshot["headline"]["updatedAt"],
    dominantPillar: "market",
    sparkline90d: [50, 52],
    delta24h: 0,
    delta30d: 0,
    deltaYtd: 0,
  },
  pillars: {} as ScoreSnapshot["pillars"],
  scoreDirection: "higher_is_better",
  schemaVersion: 2,
};

const HISTORY: ScoreHistory = {
  points: [
    { timestamp: "2026-07-03T00:00:00Z" as ScoreHistory["points"][number]["timestamp"], headline: 52, pillars: { market: 52, fiscal: 52, labour: 52, delivery: 52 } },
  ],
  rangeDays: 90,
  scoreDirection: "higher_is_better",
  schemaVersion: 2,
};

describe("primeSnapshotCache", () => {
  it("writes the snapshot JSON to score:latest with the 6h TTL", async () => {
    const puts: Put[] = [];
    await primeSnapshotCache(makeKv(puts), SNAPSHOT);

    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(SNAPSHOT_CACHE_KEY);
    expect(puts[0]!.key).toBe("score:latest");
    expect(JSON.parse(puts[0]!.body)).toEqual(SNAPSHOT);
    expect(puts[0]!.opts?.expirationTtl).toBe(SNAPSHOT_CACHE_TTL_SECONDS);
    expect(SNAPSHOT_CACHE_TTL_SECONDS).toBe(60 * 60 * 6);
  });
});

describe("primeHistoryCache", () => {
  it("writes the history JSON to score:history:90d with the 6h TTL", async () => {
    const puts: Put[] = [];
    await primeHistoryCache(makeKv(puts), HISTORY);

    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(HISTORY_CACHE_KEY);
    expect(puts[0]!.key).toBe("score:history:90d");
    expect(JSON.parse(puts[0]!.body)).toEqual(HISTORY);
    expect(puts[0]!.opts?.expirationTtl).toBe(HISTORY_CACHE_TTL_SECONDS);
    expect(HISTORY_CACHE_TTL_SECONDS).toBe(60 * 60 * 6);
  });
});
