import type { TimelineEvent } from "@tightrope/shared";
import { json, notSeeded } from "../lib/router.js";
import { readThrough } from "../lib/cache.js";
import { getTimelineEvents } from "../lib/db.js";

const ALLOWED = new Set<string>(["limit"]);

export async function handleTimeline(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED.has(key)) return json({ error: `unknown query parameter: ${key}`, code: "BAD_QUERY" }, 400);
  }
  const rawLimit = url.searchParams.get("limit") ?? "40";
  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    return json({ error: "limit must be an integer between 1 and 200", code: "BAD_QUERY" }, 400);
  }

  try {
    // Only cache the default window. Custom limits go straight to D1.
    if (limit === 40) {
      const events = await readThrough<TimelineEvent[]>(
        env,
        "timeline:latest",
        () => getTimelineEvents(env, 40),
        ctx,
      );
      if (events.length === 0) return notSeeded();
      return json(events);
    }
    const events = await getTimelineEvents(env, limit);
    if (events.length === 0) return notSeeded();
    return json(events);
  } catch (err) {
    return json({ error: "failed to load timeline", code: "DB_ERROR" }, 500);
  }
}
