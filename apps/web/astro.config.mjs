import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  output: "server",
  adapter: cloudflare({
    platformProxy: {
      enabled: true,
      // Share local D1/KV/R2 state with the apps/* workers so seeded data
      // and cached snapshots are visible across all dev servers. Note the
      // `/v3` suffix: wrangler's CLI persists to `{path}/v3/<binding>/...`
      // but its platformProxy API persists to `{path}/<binding>/...` with
      // no version bump. We point the proxy one level deeper so both write
      // to the same on-disk location.
      persist: { path: "../../.wrangler/state/v3" },
    },
  }),
  site: "https://tightropetracker.uk",
  trailingSlash: "never",
  build: {
    format: "directory",
  },
  compressHTML: true,
  vite: {
    resolve: {
      // pnpm workspace source-mapping: let Vite transpile the TS in shared/methodology.
      // preserveSymlinks must be false for pnpm to resolve hoisted deps properly.
      preserveSymlinks: false,
    },
    ssr: {
      noExternal: ["@tightrope/shared", "@tightrope/methodology"],
    },
  },
  server: {
    port: 4321,
    host: true,
  },
  devToolbar: { enabled: false },
});
