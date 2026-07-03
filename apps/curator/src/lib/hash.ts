import { sha256Hex } from "@tightrope/data-sources";

/**
 * Re-export the shared string hasher so callers have one import path. Used for
 * content-string dedupe (editorial candidates) where the "artefact" is a
 * derived string rather than raw bytes.
 */
export { sha256Hex };

/**
 * SHA-256 hex digest of raw artefact BYTES.
 *
 * The shared `sha256Hex` hashes a `string` (TextEncoder round-trip), which is
 * lossy for binary artefacts — a PDF's bytes must be hashed as-is so the
 * content dedupe key and the R2 archive suffix are stable and honest. This is
 * the byte-oriented sibling; same Web Crypto primitive, available in both
 * Workers and Node >=20, so it unit-tests under vitest and runs in production
 * unchanged.
 */
export async function sha256HexBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  // Copy into a freshly-allocated ArrayBuffer-backed view. This both normalises
  // the input (ArrayBuffer or Uint8Array) and sidesteps the ArrayBufferLike /
  // SharedArrayBuffer variance the strict lib flags on a raw digest arg.
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buf = new Uint8Array(src.length);
  buf.set(src);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buf);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i]!.toString(16).padStart(2, "0");
  }
  return out;
}
