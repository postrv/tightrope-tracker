import type { APIRoute } from "astro";
import { loadBudgetComparison } from "../lib/budget.js";

/** Downloadable evidence uses the same query and classification as the page. */
export const GET: APIRoute = async ({ locals }) => {
  const comparison = await loadBudgetComparison(locals);
  return new Response(JSON.stringify(comparison, null, 2), {
    status: comparison.unavailable ? 503 : 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
};
