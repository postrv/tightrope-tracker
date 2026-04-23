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
 */
import type { PillarId } from "@tightrope/shared";
import { PILLAR_ORDER } from "@tightrope/shared";
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

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
  });
}

function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return preflight();
    if (req.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: { Allow: "GET, OPTIONS" } });
    }

    const url = new URL(req.url);
    try {
      return await route(url, env);
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
  },
};

async function route(url: URL, env: Env): Promise<Response> {
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
  const snapshot = await loadSnapshot(env);
  const fonts = await loadFonts(env);
  // Illustrative default — real number is editorially curated (AGENT_CONTRACTS.md)
  // and will be wired to an indicator observation as the ingest worker matures.
  const png = await renderPng(
    FiscalHeadroomCard({ valueGbpBn: 23.6, updatedAt: snapshot.headline.updatedAt }),
    { width: CARD_W, height: CARD_H, fonts },
  );
  return pngResponse(png);
}

async function renderInactivity(env: Env): Promise<Response> {
  const snapshot = await loadSnapshot(env);
  const fonts = await loadFonts(env);
  const png = await renderPng(
    InactivityCard({
      valueMillions: 9.00,
      ratePercent: 20.7,
      above2019Thousands: 800,
      updatedAt: snapshot.headline.updatedAt,
      window: "Nov 2025 → Jan 2026",
    }),
    { width: CARD_W, height: CARD_H, fonts },
  );
  return pngResponse(png);
}

const MORTGAGE_BASELINE_PCT = 5.18;
const MORTGAGE_CURRENT_PCT = 5.84;

function mortgageExtra(baselinePct: number, currentPct: number, principal = 250_000, termYears = 25): number {
  const monthly = (p: number, r: number, n: number) => {
    const mr = r / 100 / 12;
    return mr === 0 ? p / n : (p * mr) / (1 - Math.pow(1 + mr, -n));
  };
  const n = termYears * 12;
  return Math.round(monthly(principal, currentPct, n) - monthly(principal, baselinePct, n));
}

async function renderMortgage(env: Env): Promise<Response> {
  const snapshot = await loadSnapshot(env);
  const fonts = await loadFonts(env);
  const extra = mortgageExtra(MORTGAGE_BASELINE_PCT, MORTGAGE_CURRENT_PCT);
  const spreadBp = Math.round((MORTGAGE_CURRENT_PCT - MORTGAGE_BASELINE_PCT) * 100);
  const png = await renderPng(
    MortgagePressureCard({
      extraPerMonth: extra,
      twoYearFixPct: MORTGAGE_CURRENT_PCT,
      spreadBp,
      updatedAt: snapshot.headline.updatedAt,
    }),
    { width: CARD_W, height: CARD_H, fonts },
  );
  return pngResponse(png);
}

async function renderGilt30y(env: Env): Promise<Response> {
  const [snapshot, indicators, fonts] = await Promise.all([
    loadSnapshot(env), loadCardIndicators(env), loadFonts(env),
  ]);
  const png = await renderPng(
    Gilt30yCard({ yieldPct: indicators.gilt30y ?? 5.73, updatedAt: snapshot.headline.updatedAt }),
    { width: CARD_W, height: CARD_H, fonts },
  );
  return pngResponse(png);
}

async function renderDeliveryHousing(env: Env): Promise<Response> {
  const snapshot = await loadSnapshot(env);
  const fonts = await loadFonts(env);
  const png = await renderPng(
    DeliveryHousingCard({ currentThousands: 221, targetThousands: 305, updatedAt: snapshot.headline.updatedAt }),
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
