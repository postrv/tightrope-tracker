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
