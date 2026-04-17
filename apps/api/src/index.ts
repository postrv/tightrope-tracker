/**
 * Tightrope public API worker.
 *
 * Endpoints are documented in AGENT_CONTRACTS.md. All responses set a star
 * CORS origin — this is a civic data API, readable by anyone.
 */
import { Router, json, preflight } from "./lib/router.js";
import { clientIp, enforceRateLimit } from "./lib/rateLimit.js";
import { handleScore, handleScoreHistory } from "./handlers/score.js";
import { handleDelivery } from "./handlers/delivery.js";
import { handleTimeline } from "./handlers/timeline.js";
import { handleMp } from "./handlers/mp.js";
import { handleHealth } from "./handlers/health.js";

const router = new Router()
  .get("/api/v1/score", handleScore)
  .get("/api/v1/score/history", handleScoreHistory)
  .get("/api/v1/delivery", handleDelivery)
  .get("/api/v1/timeline", handleTimeline)
  .get("/api/v1/mp", (req, env) => handleMp(req, env))
  .get("/api/v1/health", (req, env) => handleHealth(req, env));

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Fast path for any preflight — headers don't care about paths.
    if (req.method === "OPTIONS") return preflight();

    // Rate limit all non-OPTIONS requests. We skip /health so uptime monitors
    // don't burn budget.
    const url = new URL(req.url);
    if (url.pathname !== "/api/v1/health") {
      const ip = clientIp(req);
      const rl = await enforceRateLimit(env, ip).catch(() => null);
      if (rl && !rl.allowed) {
        return json({ error: "rate limit exceeded", code: "RATE_LIMITED" }, 429, {
          "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
          "X-RateLimit-Limit": String(rl.limit),
          "X-RateLimit-Remaining": "0",
        });
      }
    }

    try {
      return await router.handle(req, env, ctx);
    } catch (err) {
      // Never leak stack traces. Log the full error for observability.
      console.error("unhandled", err);
      return json({ error: "internal error", code: "INTERNAL" }, 500);
    }
  },
};
