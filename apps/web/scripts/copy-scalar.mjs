#!/usr/bin/env node
/**
 * Copy Scalar's standalone browser bundle from node_modules into
 * apps/web/public/vendor/ so the /docs page can load it same-origin
 * without loosening CSP.
 *
 * Source of truth for the Scalar version is package.json devDependencies;
 * the copied file is gitignored (see repo-level .gitignore). Runs before
 * `astro dev` and `astro build` — see apps/web/package.json scripts.
 *
 * Fails loudly if the source file is missing or its SHA-384 digest does
 * not match the pinned value. Update EXPECTED_SHA384 when bumping the
 * @scalar/api-reference version.
 */
import { mkdirSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// SRI digest for @scalar/api-reference@1.52.3 standalone bundle.
// Not a secret — this is a public subresource integrity hash.
// Update when bumping the pinned version in package.json.
const EXPECTED_SHA384 =
  "a6lVW8cVFPoDBh+KvKGb0wNyPe0VM9D9bJU8yZeenFroXKmRAdunHuClYMKFe56L";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, "..");
const repoRoot = resolve(webRoot, "..", "..");

const SOURCE = resolve(
  webRoot,
  "node_modules/@scalar/api-reference/dist/browser/standalone.js",
);
const TARGET_DIR = resolve(webRoot, "public/vendor");
const TARGET = resolve(TARGET_DIR, "scalar.js");

function readScalarVersion() {
  const pkgPath = resolve(
    webRoot,
    "node_modules/@scalar/api-reference/package.json",
  );
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

if (!existsSync(SOURCE)) {
  console.error(
    `[copy-scalar] Source bundle missing: ${SOURCE}\n` +
      `Is @scalar/api-reference installed? Run \`pnpm install\` from the repo root.`,
  );
  process.exit(1);
}

const sourceBytes = readFileSync(SOURCE);
const actualHash = createHash("sha384").update(sourceBytes).digest("base64");

if (actualHash !== EXPECTED_SHA384) {
  console.error(
    `[copy-scalar] SHA-384 mismatch for ${SOURCE}\n` +
      `  expected: ${EXPECTED_SHA384}\n` +
      `  got:      ${actualHash}\n` +
      `If you bumped @scalar/api-reference, update EXPECTED_SHA384 in this script.`,
  );
  process.exit(1);
}

mkdirSync(TARGET_DIR, { recursive: true });
copyFileSync(SOURCE, TARGET);

const version = readScalarVersion();
const rel = (p) => p.replace(repoRoot + "/", "");
console.log(`[copy-scalar] ${rel(SOURCE)} → ${rel(TARGET)} (v${version}, sha384 ✓)`);
