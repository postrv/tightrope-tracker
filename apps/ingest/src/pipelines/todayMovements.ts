import type { D1PreparedStatement } from "@cloudflare/workers-types";
import {
  INDICATORS,
  PILLARS,
  type TodayMovement,
  type Trend,
} from "@tightrope/shared";
import type { Env } from "../env.js";

const KV_TTL_6H = 60 * 60 * 6;
const SPARKLINE_POINTS = 14;

/** Compute the homepage "what moved today" cards from the latest market-pillar observations. */
export async function updateTodayMovements(env: Env): Promise<TodayMovement[]> {
  const marketIds = Object.values(INDICATORS)
    .filter((i) => i.pillar === "market")
    .map((i) => i.id);
  const movements: TodayMovement[] = [];

  for (const id of marketIds) {
    const rows = await env.DB
      .prepare(
        `SELECT value, observed_at FROM indicator_observations
         WHERE indicator_id = ?
         ORDER BY observed_at DESC
         LIMIT ?`,
      )
      .bind(id, SPARKLINE_POINTS)
      .all<{ value: number; observed_at: string }>();
    const series = (rows.results ?? []).slice().reverse();
    if (series.length === 0) continue;
    const latest = series[series.length - 1]!;
    const prior = series.length > 1 ? series[series.length - 2]! : latest;
    const def = INDICATORS[id]!;
    const change = latest.value - prior.value;
    // Near-zero priors blow up the ratio: e.g. 0.01 -> 0.02 is a "+100%" that
    // no human reader would accept. Suppress changePct below a 0.1-unit floor;
    // the web layer hides the % label in that case.
    const changePct = Math.abs(prior.value) < 0.1 ? null : (change / prior.value) * 100;
    const direction: Trend = change > 0 ? "up" : change < 0 ? "down" : "flat";
    const worsening = (def.risingIsBad && change > 0) || (!def.risingIsBad && change < 0);
    const gloss = glossFor(def.id, change);
    const displayValue = def.formatDisplay(latest.value);
    const changeDisplay = formatChangeDisplay(def.id, change);
    movements.push({
      indicatorId: id,
      label: def.shortLabel,
      unit: def.unit,
      latestValue: latest.value,
      displayValue,
      change,
      changePct,
      changeDisplay,
      direction,
      worsening,
      sparkline: series.map((s) => s.value),
      gloss,
      sourceId: def.sourceId,
      observedAt: latest.observed_at,
    });
  }

  await persistMovements(env, movements);
  await env.KV.put("movements:today", JSON.stringify(movements), { expirationTtl: KV_TTL_6H });
  // Silence the unused-imports linter while keeping PILLARS importable for future pillars.
  void PILLARS;
  return movements;
}

async function persistMovements(env: Env, movements: readonly TodayMovement[]): Promise<void> {
  if (movements.length === 0) return;
  const stmts: D1PreparedStatement[] = movements.map((m) =>
    env.DB
      .prepare(
        `INSERT OR REPLACE INTO today_movements
           (indicator_id, label, latest_value, display_value, change, change_pct, change_display, direction, worsening, sparkline, gloss, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        m.indicatorId,
        m.label,
        m.latestValue,
        m.displayValue,
        m.change,
        m.changePct,
        m.changeDisplay,
        m.direction,
        m.worsening ? 1 : 0,
        JSON.stringify(m.sparkline),
        m.gloss,
        m.observedAt,
      ),
  );
  await env.DB.batch(stmts);
}

function glossFor(indicatorId: string, change: number): string {
  const def = INDICATORS[indicatorId]!;
  if (change === 0) return `${def.label}: unchanged on the session.`;
  const dir = change > 0 ? "up" : "down";
  const mag = Math.abs(change).toFixed(2);
  return `${def.label}: ${dir} ${mag} on the session.`;
}

function formatChangeDisplay(indicatorId: string, change: number): string {
  const def = INDICATORS[indicatorId]!;
  const sign = change > 0 ? "+" : change < 0 ? "-" : "";
  const abs = Math.abs(change);
  // For percent-style indicators we quote in basis points so small moves read clean.
  if (def.unit === "%") {
    const bp = Math.round(abs * 100);
    return `${sign}${bp}bp`;
  }
  if (def.unit === "ccy") return `${sign}${abs.toFixed(4)}`;
  if (def.unit === "index") return `${sign}${abs.toFixed(2)}`;
  return `${sign}${abs.toFixed(2)}`;
}
