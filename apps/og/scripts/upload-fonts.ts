/**
 * Fetch the three OG typefaces and upload them to the R2 FONTS bucket.
 *
 * Usage:
 *   pnpm tsx apps/og/scripts/upload-fonts.ts            # uploads to prod bucket
 *   pnpm tsx apps/og/scripts/upload-fonts.ts --local    # uploads to local R2
 *
 * Reads the same manifest the worker uses (apps/og/src/lib/fonts.ts) so the
 * keys stay in sync. Writes each file to a /tmp staging directory then shells
 * out to `wrangler r2 object put` — wrangler handles auth and chunking.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FONT_R2_MANIFEST } from "../src/lib/fonts.js";

const BUCKET = "tightrope-og-fonts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const local = args.includes("--local");
  const dir = mkdtempSync(join(tmpdir(), "tr-fonts-"));
  console.log(`staging fonts in ${dir}`);

  for (const { r2Key, fallbackUrl } of FONT_R2_MANIFEST) {
    console.log(`-> ${r2Key}  <-  ${fallbackUrl}`);
    const res = await fetch(fallbackUrl);
    if (!res.ok) throw new Error(`download ${fallbackUrl} -> ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const filePath = join(dir, r2Key.replace(/[/\\]/g, "_"));
    writeFileSync(filePath, bytes);

    const wranglerArgs = [
      "wrangler", "r2", "object", "put",
      `${BUCKET}/${r2Key}`,
      "--file", filePath,
      "--content-type", "font/woff",
    ];
    // Modern wrangler defaults R2 object ops to `--local`; be explicit either way.
    wranglerArgs.push(local ? "--local" : "--remote");

    console.log(`   ${wranglerArgs.slice(0, 5).join(" ")} ...`);
    execFileSync("pnpm", ["--filter", "@tightrope/og", "exec", ...wranglerArgs], {
      stdio: "inherit",
    });
  }

  console.log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
