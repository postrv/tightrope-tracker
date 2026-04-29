/**
 * Tightrope OG share-card worker.
 *
 * Routes (documented in AGENT_CONTRACTS.md):
 *   GET /og/headline-score.png
 *   GET /og/fiscal-headroom.png
 *   GET /og/inactivity-9m.png
 *   GET /og/mortgage-pressure.png
 *   GET /og/gilt-30y-high.png
 *   GET /og/delivery-housing.png
 *   GET /og/pillar/:pillarId.png
 *
 * Every response is a 1200×630 PNG with a long edge cache.
 *
 * Defence-in-depth (SEC-1; see `lib/handler.ts` + tests for the full flow):
 *   1. Cache API normalisation strips the query string before key lookup,
 *      so `?nonce=$RANDOM` cannot bust the edge cache and force fresh
 *      WASM renders.
 *   2. KV-backed per-IP rate limit (60/min) trips on the cache-miss path.
 *   3. wrangler.toml [limits] cpu_ms cap kills any single render that runs
 *      away (Satori layout pathology, resvg infinite loop).
 */
import type { PillarId } from "@tightrope/shared";
import { OBR_LATEST_VINTAGE_LABEL, OBR_TARGET_YEAR_LABEL, PILLAR_ORDER } from "@tightrope/shared";
import { loadFonts } from "./lib/fonts.js";
import { loadSnapshot, loadCardIndicators } from "./lib/data.js";
import { OgRenderTimeoutError, pngResponse, renderPng, renderTimeoutResponse } from "./lib/render.js";
import { CARD_H, CARD_W } from "./templates/components.js";
import { HeadlineCard } from "./templates/headline.js";
import { FiscalHeadroomCard } from "./templates/fiscal-headroom.js";
import { InactivityCard } from "./templates/inactivity-9m.js";
import { MortgagePressureCard } from "./templates/mortgage-pressure.js";
import { Gilt30yCard } from "./templates/gilt-30y-high.js";
import { DeliveryHousingCard } from "./templates/delivery-housing.js";
import { PillarCard } from "./templates/pillar.js";
import { handleOgRequest, type OgRouter } from "./lib/handler.js";

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
  });
}

const router: OgRouter = async ({ url, env }) => {
  try {
    return await dispatch(url, env);
  } catch (err) {
    if (err instanceof OgRenderTimeoutError) {
      console.error("og render timed out", url.pathname);
      return renderTimeoutResponse();
    }
    console.error("og render failed", err);
    return new Response("render failed", {
      status: 500,
      headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
    });
  }
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleOgRequest(req, env, ctx, router, { cache: caches.default });
  },
};

async function dispatch(url: URL, env: Env): Promise<Response> {
  const p = url.pathname;

  // Match /og/pillar/:id.png first; generic routes below.
  const pillarMatch = p.match(/^\/og\/pillar\/([a-z]+)\.png$/);
  if (pillarMatch) {
    const pillarId = pillarMatch[1] as PillarId;
    if (!PILLAR_ORDER.includes(pillarId)) return notFound();
    return renderPillar(env, pillarId);
  }

  switch (p) {
    case "/og/headline-score.png":  return renderHeadline(env);
    case "/og/fiscal-headroom.png": return renderFiscalHeadroom(env);
    case "/og/inactivity-9m.png":   return renderInactivity(env);
    case "/og/mortgage-pressure.png": return renderMortgage(env);
    case "/og/gilt-30y-high.png":   return renderGilt30y(env);
    case "/og/delivery-housing.png": return renderDeliveryHousing(env);
    default: return notFound();
  }
}

async function renderHeadline(env: Env): Promise<Response> {
  const snapshot = await loadSnapshot(env);
  const fonts = await loadFonts(env);
  const png = await renderPng(HeadlineCard(snapshot.headline), { width: CARD_W, height: CARD_H, fonts });
  return pngResponse(png);
}

async function renderFiscalHeadroom(env: Env): Promise<Response> {
  const [snapshot, indicators, fonts] = await Promise.all([
    loadSnapshot(env), loadCardIndicators(env), loadFonts(env),
  ]);
  // OBR forecast for the stability-rule target year. Read from the latest
  // cb_headroom observation in D1 (written by the obrEfo adapter). If D1
  // is empty (cold cache), fall back to the seed value rather than emitting
  // a card with "£0bn"; the seed matches the OBR Spring Forecast 2026 head.
  const valueGbpBn = indicators.cbHeadroom?.value ?? 23.6;
  // Stamp the card with the OBR vintage observed_at, not the recompute
  // heartbeat — readers care about when OBR last revised the figure.
  const vintageAt = indicators.cbHeadroom?.observedAt ?? snapshot.headline.updatedAt;
  const png = await renderPng(
    FiscalHeadroomCard({
      valueGbpBn,
      updatedAt: vintageAt,
      targetYearLabel: OBR_TARGET_YEAR_LABEL,
      vintageLabel: OBR_LATEST_VINTAGE_LABEL,
    }),
    { width: CARD_W, height: CARD_H, fonts },
  );
  return pngResponse(png);
}

async function renderInactivity(env: Env): Promise<Response> {
  const [snapshot, indicators, fonts] = await Promise.all([
    loadSnapshot(env), loadCardIndicators(env), loadFonts(env),
  ]);
  const reading = indicators.inactivityRate;
  const ratePercent = reading?.value ?? 21.0;
  const updatedAt = reading?.observedAt ?? snapshot.headline.updatedAt;
  const png = await renderPng(
    InactivityCard({ ratePercent, updatedAt }),
    { width: CARD_W, height: CARD_H, fonts },
  );
  return pngResponse(png);
}

/**
 * Editorial baseline: BoE IADB IUMBV34 monthly print for March 2025 (the
 * month of the Spring Statement 2025). Must stay in lockstep with
 * MORTGAGE_BUDGET_BASELINE_PCT in apps/web/src/lib/mortgage.ts — both anchor
 * the same "since the Spring Statement" delta and a unit-mismatch flips the
 * sign of the headline £/month figure.
 */
const MORTGAGE_BASELINE_PCT = 4.54;
const MORTGAGE_BASELINE_LABEL = "Spring Statement 2025";

function mortgageExtra(baselinePct: number, currentPct: number, principal = 250_000, termYears = 25): number {
  const monthly = (p: number, r: number, n: number) => {
    const mr = r / 100 / 12;
    return mr === 0 ? p / n : (p * mr) / (1 - Math.pow(1 + mr, -n));
  };
  const n = termYears * 12;
  return Math.round(monthly(principal, currentPct, n) - monthly(principal, baselinePct, n));
}

async function renderMortgage(env: Env): Promise<Response> {
  const [snapshot, indicators, fonts] = await Promise.all([
    loadSnapshot(env), loadCardIndicators(env), loadFonts(env),
  ]);
  const reading = indicators.mortgage2y;
  const currentPct = reading?.value ?? MORTGAGE_BASELINE_PCT;
  const updatedAt = reading?.observedAt ?? snapshot.headline.updatedAt;
  const extra = mortgageExtra(MORTGAGE_BASELINE_PCT, currentPct);
  const spreadBp = Math.round((currentPct - MORTGAGE_BASELINE_PCT) * 100);
  const png = await renderPng(
    MortgagePressureCard({
      extraPerMonth: extra,
      twoYearFixPct: currentPct,
      spreadBp,
      updatedAt,
      baselineLabel: MORTGAGE_BASELINE_LABEL,
    }),
    { width: CARD_W, height: CARD_H, fonts },
  );
  return pngResponse(png);
}

async function renderGilt30y(env: Env): Promise<Response> {
  const [snapshot, indicators, fonts] = await Promise.all([
    loadSnapshot(env), loadCardIndicators(env), loadFonts(env),
  ]);
  const reading = indicators.gilt30y;
  const yieldPct = reading?.value ?? 5.73;
  const updatedAt = reading?.observedAt ?? snapshot.headline.updatedAt;
  const png = await renderPng(
    Gilt30yCard({ yieldPct, updatedAt }),
    { width: CARD_W, height: CARD_H, fonts },
  );
  return pngResponse(png);
}

/**
 * `housing_trajectory` is computed as annualised completions ÷ 300k OBR
 * working assumption × 100. The card uses the same 300k denominator so
 * the headline percentage and the indicator value match exactly (audit
 * 2026-04-29). Labour's 305k political pledge is surfaced on the
 * homepage delivery-commitment card prose, where both denominators are
 * explained side by side; on a single OG card we prefer arithmetic
 * coherence over political-headline framing — a viewer punching the
 * displayed numbers into a calculator must land on the same percentage.
 */
const HOUSING_TARGET_THOUSANDS = 300;

async function renderDeliveryHousing(env: Env): Promise<Response> {
  const [snapshot, indicators, fonts] = await Promise.all([
    loadSnapshot(env), loadCardIndicators(env), loadFonts(env),
  ]);
  const reading = indicators.housingTrajectory;
  // housing_trajectory = annualised completions ÷ 300k * 100 (see fixture
  // _comment for the formula). To recover annualised completions in
  // thousands: rawValue / 100 * 300. Same 300k anchor flows through to
  // the card's percentage by using HOUSING_TARGET_THOUSANDS as the
  // denominator below — no rounding round-trip drift.
  const currentThousands = reading ? Math.round((reading.value / 100) * 300) : 147;
  const updatedAt = reading?.observedAt ?? snapshot.headline.updatedAt;
  const png = await renderPng(
    DeliveryHousingCard({
      currentThousands,
      targetThousands: HOUSING_TARGET_THOUSANDS,
      updatedAt,
    }),
    { width: CARD_W, height: CARD_H, fonts },
  );
  return pngResponse(png);
}

async function renderPillar(env: Env, pillarId: PillarId): Promise<Response> {
  const snapshot = await loadSnapshot(env);
  const fonts = await loadFonts(env);
  const score = snapshot.pillars[pillarId];
  const png = await renderPng(
    PillarCard({ pillar: pillarId, score, updatedAt: snapshot.headline.updatedAt }),
    { width: CARD_W, height: CARD_H, fonts },
  );
  return pngResponse(png);
}
