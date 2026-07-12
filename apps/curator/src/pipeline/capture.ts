import { fetchOrThrow } from "@tightrope/data-sources";
import type { Env } from "../env";
import type { ArtefactFormat, CaptureArtifact, CaptureSpec, DiscoverConfig } from "../types";
import { latestCaptureSha } from "../lib/captures";
import { sha256HexBytes } from "../lib/hash";
import { docToMarkdown } from "../lib/ai";
import { biasForFormat, truncateForModel, MODEL_TEXT_BUDGET } from "../lib/artefactText";
import { discoverReleaseUrl } from "../lib/discover";

/** One fetched artefact part: raw bytes + the format to interpret them as. */
export interface ArtefactPart {
  url: string;
  bytes: Uint8Array;
  format: ArtefactFormat;
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
  const parts = await fetchArtefactParts(spec);
  return captureFromParts(env, spec, parts, opts);
}

/**
 * Fetch every artefact part for a spec, applying FOLLOW-LINK DISCOVERY where the
 * spec declares it: each `spec.urls` entry is fetched as a discovery page, the
 * newest matching release link is located (shared discover.ts), and THAT release
 * is fetched and handed on — so the model reads the release, not the landing
 * page. Without `discover` the URL is fetched directly. This is the exact
 * function the relay runner mirrors (it re-implements the fetch, but imports the
 * same discoverReleaseUrl), so a Worker capture and a relayed capture discover
 * identically.
 */
export async function fetchArtefactParts(spec: CaptureSpec): Promise<ArtefactPart[]> {
  const parts: ArtefactPart[] = [];
  for (const url of spec.urls) {
    parts.push(spec.discover ? await followDiscovery(spec, url, spec.discover) : await fetchPart(spec, url, spec.format));
  }
  return parts;
}

/** Fetch one URL as a raw part in the given format. */
async function fetchPart(spec: CaptureSpec, url: string, format: ArtefactFormat): Promise<ArtefactPart> {
  const res = await fetchOrThrow(fetch, spec.sourceId, url);
  return { url, bytes: new Uint8Array(await res.arrayBuffer()), format };
}

/**
 * Walk a discovery chain from `startUrl`: fetch each discovery page, pick the
 * newest matching link (shared discover.ts), follow `then` for a second hop
 * where the spec needs it (MHCLG: collection → release → full HTML doc), then
 * fetch the terminal artefact. The runner script re-implements the fetch but
 * imports the SAME discoverReleaseUrl, so the two can never disagree.
 */
async function followDiscovery(spec: CaptureSpec, startUrl: string, discover: DiscoverConfig): Promise<ArtefactPart> {
  let currentUrl = startUrl;
  let format = spec.format;
  let cfg: DiscoverConfig | undefined = discover;
  while (cfg) {
    const res = await fetchOrThrow(fetch, spec.sourceId, currentUrl);
    const html = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(await res.arrayBuffer()));
    const next = discoverReleaseUrl(html, currentUrl, cfg);
    if (!next) {
      throw new Error(`discovery found no release link on ${currentUrl} for ${spec.sourceId} (pattern ${cfg.linkPattern})`);
    }
    format = cfg.releaseFormat ?? format;
    currentUrl = next;
    cfg = cfg.then;
  }
  return fetchPart(spec, currentUrl, format);
}

/**
 * Hash → dedupe → archive → text, over already-fetched parts. Split out from
 * captureSource so the relay endpoint (POST /admin/relay-artefact) runs the
 * EXACT same capture stage over bytes a runner fetched on our behalf — same
 * dedupe short-circuit, same R2 archive, same text projection.
 */
export async function captureFromParts(
  env: Env,
  spec: CaptureSpec,
  parts: ArtefactPart[],
  opts: { force: boolean },
): Promise<CaptureArtifact | "unchanged"> {
  const fetchedAt = new Date().toISOString();
  const combined = concatParts(parts.map((p) => p.bytes));
  const contentSha256 = await sha256HexBytes(combined);

  if (!opts.force) {
    const prev = await latestCaptureSha(env.DB, spec.sourceId);
    if (prev !== null && prev === contentSha256) return "unchanged";
  }

  const rawR2Key = archiveKey(spec, parts, fetchedAt, contentSha256);
  // Archive is best-effort provenance; a bucket hiccup must not lose the
  // capture, but it must be visible, so we log rather than swallow silently.
  try {
    await env.ARCHIVE.put(rawR2Key, combined);
  } catch (err) {
    console.warn(`curator archive put failed for ${rawR2Key}: ${(err as Error)?.message ?? String(err)}`);
  }

  const text = await toText(env, spec, parts);

  return { spec, url: parts[0]?.url ?? spec.urls[0] ?? "", fetchedAt, contentSha256, rawR2Key, text };
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

function extFor(format: ArtefactFormat): string {
  switch (format) {
    case "pdf": return "pdf";
    case "xlsx": return "xlsx";
    case "atom": return "xml";
    default: return "html";
  }
}

function archiveKey(spec: CaptureSpec, parts: ArtefactPart[], fetchedAt: string, sha: string): string {
  const day = fetchedAt.slice(0, 10);
  const ext = extFor(parts[0]?.format ?? spec.format);
  return `curator/${spec.sourceId}/${day}-${sha.slice(0, 8)}.${ext}`;
}

/**
 * Project each part to text by ITS OWN format (a discovery follow can flip an
 * HTML spec to a PDF/XLSX release), truncate each to the documented model budget
 * so an over-long artefact does not trigger the Workers-AI 5024, then combine.
 * The combined result is capped again so a multi-URL spec (MHCLG) can't blow the
 * budget by summing two large sections.
 */
async function toText(env: Env, spec: CaptureSpec, parts: ArtefactPart[]): Promise<string> {
  const sections: string[] = [];
  for (const p of parts) {
    let section: string;
    if (p.format === "pdf") {
      section = await docToMarkdown(env, `${spec.sourceId}.pdf`, p.bytes.buffer as ArrayBuffer, "application/pdf");
    } else if (p.format === "xlsx") {
      section = await docToMarkdown(env, `${spec.sourceId}.xlsx`, p.bytes.buffer as ArrayBuffer, XLSX_MIME);
    } else {
      section = htmlToText(new TextDecoder("utf-8", { fatal: false }).decode(p.bytes));
    }
    // Bias per part: an xlsx is a newest-last time series, so over-budget
    // truncation must keep the tail or the current month never reaches the model.
    sections.push(truncateForModel(section, MODEL_TEXT_BUDGET, biasForFormat(p.format), spec.anchorTerms));
  }
  const combined =
    sections.length === 1
      ? sections[0]!
      : // Multi-URL: label each section by its URL so the model can attribute values.
        parts.map((p, i) => `=== SOURCE: ${p.url} ===\n${sections[i]}`).join("\n\n");
  // The combined truncation must carry the spec's anchors too. Without them
  // (the pre-2026-07-12 bug) two ~20k sections squeezed into one 20k budget
  // fill head-first by digit-relevance, and the SECOND section's headline
  // sentences never reach the model at all — mhclg_housing's planning
  // figures were silently absent from every extraction attempt while the
  // per-section truncation above dutifully anchored text that was then
  // thrown away here.
  return truncateForModel(combined, MODEL_TEXT_BUDGET, biasForFormat(spec.format), spec.anchorTerms);
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
