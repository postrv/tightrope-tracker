import { fetchOrThrow } from "@tightrope/data-sources";
import type { Env } from "../env";
import type { CaptureArtifact, CaptureSpec } from "../types";
import { latestCaptureSha } from "../lib/captures";
import { sha256HexBytes } from "../lib/hash";
import { pdfToMarkdown } from "../lib/ai";

/**
 * Stage 1 — capture. Contract in the original stub header (AUTOMATION_PLAN
 * Phase 3), realised here:
 *
 * - Fetch every spec URL with the data-sources UA discipline (`fetchOrThrow`
 *   sets the same browser-ish User-Agent adapters use; several UK upstreams
 *   403 an empty UA).
 * - sha256 the raw artefact BYTES (not a decoded string — binary-safe for
 *   PDFs). For a multi-URL spec (e.g. MHCLG housing + planning) the hash is
 *   over the length-delimited concatenation of every part, so the dedupe key
 *   moves iff ANY part moves.
 * - Dedupe: if the hash equals the source's latest capture row's
 *   content_sha256 and `force` is false → "unchanged" (no extraction, no AI
 *   spend). `force` (the pre-deadline sweep) always re-extracts.
 * - Archive the raw bytes to R2 at curator/{sourceId}/{yyyy-mm-dd}-{sha8}.{ext}.
 * - Produce the model's text: HTML → hand-rolled tag strip (repo idiom, no
 *   cheerio); PDF → markdown via env.AI.toMarkdown (verified present in the
 *   local @cloudflare/workers-types); Atom → same tag strip as HTML.
 *
 * Failure mode: throw. The sweep runner wraps each spec so one source's
 * failure never aborts the run, and records a failed audit row.
 */
export async function captureSource(
  env: Env,
  spec: CaptureSpec,
  opts: { force: boolean },
): Promise<CaptureArtifact | "unchanged"> {
  const fetchedAt = new Date().toISOString();
  const parts: Array<{ url: string; bytes: Uint8Array }> = [];
  for (const url of spec.urls) {
    const res = await fetchOrThrow(fetch, spec.sourceId, url);
    parts.push({ url, bytes: new Uint8Array(await res.arrayBuffer()) });
  }

  const contentSha256 = await sha256HexBytes(concatParts(parts.map((p) => p.bytes)));

  if (!opts.force) {
    const prev = await latestCaptureSha(env.DB, spec.sourceId);
    if (prev !== null && prev === contentSha256) return "unchanged";
  }

  const rawR2Key = archiveKey(spec, fetchedAt, contentSha256);
  // Archive is best-effort provenance; a bucket hiccup must not lose the
  // capture, but it must be visible, so we log rather than swallow silently.
  try {
    await env.ARCHIVE.put(rawR2Key, concatParts(parts.map((p) => p.bytes)));
  } catch (err) {
    console.warn(`curator archive put failed for ${rawR2Key}: ${(err as Error)?.message ?? String(err)}`);
  }

  const text = await toText(env, spec, parts);

  return { spec, url: spec.urls[0] ?? "", fetchedAt, contentSha256, rawR2Key, text };
}

/** Length-delimited concatenation so distinct parts can't hash-collide by shifting a boundary. */
function concatParts(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  let total = 0;
  for (const p of parts) total += p.length + 8;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    // 8-byte big-endian length prefix.
    const len = p.length;
    out[off + 4] = (len >>> 24) & 0xff;
    out[off + 5] = (len >>> 16) & 0xff;
    out[off + 6] = (len >>> 8) & 0xff;
    out[off + 7] = len & 0xff;
    off += 8;
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function archiveKey(spec: CaptureSpec, fetchedAt: string, sha: string): string {
  const day = fetchedAt.slice(0, 10);
  const ext = spec.format === "pdf" ? "pdf" : spec.format === "atom" ? "xml" : "html";
  return `curator/${spec.sourceId}/${day}-${sha.slice(0, 8)}.${ext}`;
}

async function toText(env: Env, spec: CaptureSpec, parts: Array<{ url: string; bytes: Uint8Array }>): Promise<string> {
  const sections: string[] = [];
  for (const p of parts) {
    if (spec.format === "pdf") {
      sections.push(await pdfToMarkdown(env, `${spec.sourceId}.pdf`, p.bytes.buffer as ArrayBuffer));
    } else {
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(p.bytes);
      sections.push(htmlToText(raw));
    }
  }
  if (sections.length === 1) return sections[0]!;
  // Multi-URL: label each section by its URL so the model can attribute values.
  return parts.map((p, i) => `=== SOURCE: ${p.url} ===\n${sections[i]}`).join("\n\n");
}

/**
 * Hand-rolled HTML → text (repo idiom — the codebase hand-rolls CSV and XML
 * parsers rather than pull cheerio). Drops <script>/<style>/<head> content
 * entirely, strips remaining tags, decodes the common named + numeric
 * entities, and collapses whitespace. Not a full HTML parser — a robust text
 * projection good enough for a language model to read a statistical release.
 */
export function htmlToText(html: string): string {
  let s = html;
  // Remove whole non-content blocks (script/style/head/noscript/svg) including content.
  s = s.replace(/<(script|style|head|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Turn block-closers into newlines so sentences don't glue together.
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|thead|tbody)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Strip all remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  // Decode entities.
  s = decodeEntities(s);
  // Collapse whitespace: trim each line, drop blank runs.
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return s;
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    pound: "£",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    ldquo: "“",
    rdquo: "”",
    percnt: "%",
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (m, name: string) => named[name] ?? m);
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}
