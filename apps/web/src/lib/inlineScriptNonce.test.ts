/**
 * SEC-10 follow-up: every executable `<script>` block in an .astro source
 * file must end up either external (matched by `script-src 'self'`) or inline
 * with a per-request nonce — never inline-without-nonce.
 *
 * The original SEC-10 migration tagged every `is:inline` script with the
 * Astro.locals.cspNonce, but it missed bare `<script>` tags. Astro processes
 * those: scripts that contain `import`/`export` get bundled to a separate
 * `_astro/<hash>.js` file and emitted as `<script type="module" src="...">`
 * (which `script-src 'self'` covers); scripts that are tiny and standalone
 * get bundled and INLINED into the HTML as `<script type="module">…</script>`
 * — and those inline blocks need a nonce. Production CSP was blocking all
 * four inlined-bundled scripts (TopNav menu, Hero score animation,
 * TightropeWalker sway, AnnotatedHeadlineChart tooltips) until this rule
 * was enforced.
 *
 * The check is deliberately conservative: we require every bare `<script>`
 * to either be marked `is:inline` + nonce, or contain an `import` statement
 * (which guarantees Astro externalises it). False positives are easy to
 * fix; false negatives let the regression back in.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (entry.endsWith(".astro")) out.push(p);
  }
  return out;
}

interface ScriptBlock {
  file: string;
  /** 1-indexed line where the opening `<script` tag starts. */
  line: number;
  /** Full opening tag, e.g. `<script is:inline nonce={Astro.locals.cspNonce}>`. */
  openTag: string;
  /** Body between the opening and closing tag. */
  body: string;
}

/**
 * Find every `<script ...>...</script>` block in a single .astro file. The
 * regex is intentionally simple — .astro markup doesn't allow nested
 * `<script>` tags, so a non-greedy scan is enough.
 */
function findScripts(file: string, src: string): ScriptBlock[] {
  const out: ScriptBlock[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(0, m.index);
    const line = before.split("\n").length;
    out.push({ file, line, openTag: `<script${m[1]}>`, body: m[2] ?? "" });
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  openTag: string;
  reason: string;
}

function classify(block: ScriptBlock): Violation | null {
  const tag = block.openTag;

  // Non-executable data blocks: CSP doesn't apply.
  if (/\btype\s*=\s*["']application\/(?:json|ld\+json)["']/.test(tag)) return null;

  // External scripts (src=...): matched by `script-src 'self'`. The nonce
  // is still added defensively in some places but isn't required.
  if (/\bsrc\s*=/.test(tag)) return null;

  const isInline = /\bis:inline\b/.test(tag);
  const hasNonce = /\bnonce\s*=\s*\{Astro\.locals\.cspNonce\}/.test(tag);

  if (isInline) {
    if (!hasNonce) {
      return {
        file: block.file,
        line: block.line,
        openTag: tag,
        reason: "is:inline script must include nonce={Astro.locals.cspNonce}",
      };
    }
    return null;
  }

  // Bare `<script>`: Astro will bundle it. If the body has any import/export
  // statement, Astro externalises it as a module file (script-src 'self'
  // covers that). Otherwise Astro may inline the bundled output, and the
  // emitted inline tag won't carry our per-request nonce.
  const bodyHasModuleStatement = /(^|\n|;)\s*(import|export)\s/.test(block.body);
  if (bodyHasModuleStatement) return null;

  return {
    file: block.file,
    line: block.line,
    openTag: tag,
    reason:
      "bare <script> with no import/export — Astro may inline it without a nonce. " +
      "Either add an import (forces external bundle) or convert to " +
      "`<script is:inline nonce={Astro.locals.cspNonce}>` and write plain JS.",
  };
}

describe("inline-script CSP nonce contract across .astro sources", () => {
  const files = walk(SRC_ROOT);

  it("finds at least one .astro file (smoke check on the walker itself)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every executable inline <script> in .astro files is either external, module-bundled, or carries the per-request nonce", () => {
    const violations: Violation[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const block of findScripts(f, src)) {
        const v = classify(block);
        if (v) violations.push(v);
      }
    }
    if (violations.length > 0) {
      const lines = violations.map(
        (v) => `  ${v.file}:${v.line}\n    ${v.openTag}\n    → ${v.reason}`,
      );
      throw new Error(
        `Found ${violations.length} script(s) without CSP-nonce coverage:\n${lines.join("\n\n")}`,
      );
    }
  });
});
