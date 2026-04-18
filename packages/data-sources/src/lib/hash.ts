/**
 * SHA-256 hex digest of an input string. Uses the Web Crypto API that is
 * available in both Cloudflare Workers and modern Node (>=20) runtimes -- so
 * adapters can be unit-tested with vitest and run in production unchanged.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Deterministic payload_hash for a historical observation. Bound to the row's
 * logical identity (indicator + day + value), not the upstream payload.
 *
 *   - Idempotent reruns produce identical hashes iff the value is unchanged,
 *     so `ingestion_audit.payload_hash` only changes on genuine value deltas.
 *   - The `hist:` prefix distinguishes historical rows from live rows (raw
 *     sha256 hex) and seed rows (`seed*`), and crucially does NOT match the
 *     `payload_hash LIKE 'seed%'` filter used by purge-synthetic-history.
 */
export async function historicalPayloadHash(
  indicatorId: string,
  observedAt: string,
  value: number,
): Promise<string> {
  return `hist:${await sha256Hex(`${indicatorId}|${observedAt}|${value}`)}`;
}
