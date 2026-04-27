import type { DeliveryCommitment } from "@tightrope/shared";
import { json, notSeeded } from "../lib/router.js";
import { readThroughStamped } from "../lib/cache.js";
import { getDeliveryCommitments } from "../lib/db.js";

export async function handleDelivery(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  for (const key of url.searchParams.keys()) {
    return json({ error: `unknown query parameter: ${key}`, code: "BAD_QUERY" }, 400);
  }
  try {
    const commitments = await readThroughStamped<DeliveryCommitment[]>(
      env,
      "delivery:latest",
      () => getDeliveryCommitments(env),
      ctx,
    );
    // Empty delivery means the commitment table has never been seeded -- there
    // is no degenerate "empty but valid" state for this endpoint.
    if (commitments.length === 0) return notSeeded();
    return json(commitments);
  } catch (err) {
    // SEC-8: opaque INTERNAL discriminator only.
    console.error("delivery load failed", err);
    return json({ error: "failed to load delivery commitments", code: "INTERNAL" }, 500);
  }
}
