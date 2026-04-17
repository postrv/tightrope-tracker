/** SHA-256 hex digest using the Web Crypto API. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i++) out += view[i]!.toString(16).padStart(2, "0");
  return out;
}

/** Combine multiple hashes into a single deterministic string. */
export function combineHashes(hashes: readonly string[]): string {
  if (hashes.length === 0) return "";
  if (hashes.length === 1) return hashes[0]!;
  return [...hashes].sort().join("|");
}
