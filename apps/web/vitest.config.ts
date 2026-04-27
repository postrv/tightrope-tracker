/**
 * Vitest config for apps/web.
 *
 * `getViteConfig` from astro/config registers Astro's vite plugin so
 * `.astro` files transform correctly when imported from tests (the chart
 * + composite-view component tests rely on this). We then graft vitest's
 * `test` options onto the resulting config. `configFile: false` is
 * passed so the production astro.config.mjs (with its Cloudflare
 * adapter and platform proxy) doesn't load — adapter state is
 * irrelevant to component testing and complicates the runtime.
 *
 * Component / page / DOM tests run under happy-dom; pure logic tests
 * (under src/lib/) run under node. The `environmentMatchGlobs` pattern
 * keeps the right runtime per file without per-test boilerplate.
 *
 * The async wrapper is required because `getViteConfig` returns a
 * function that resolves Astro's vite settings at call time. We invoke
 * it once with vitest-shaped command/mode and merge in the test config.
 */
import { getViteConfig } from "astro/config";
import { fileURLToPath } from "node:url";

export default async () => {
  const astroViteFn = getViteConfig(
    {},
    {
      configFile: false,
      output: "static",
      site: "https://tightropetracker.uk",
      integrations: [],
    },
  );
  const astroVite = await astroViteFn({ mode: "test", command: "serve" });

  return {
    ...astroVite,
    resolve: {
      ...(astroVite.resolve ?? {}),
      alias: {
        ...((astroVite.resolve?.alias as Record<string, string> | undefined) ?? {}),
        "~": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    test: {
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      environment: "node",
      environmentMatchGlobs: [
        // Component / page / DOM tests opt into happy-dom by glob.
        // Pure-logic lib tests stay on node for speed.
        ["src/components/**/*.test.ts", "happy-dom"],
        ["src/components/**/*.test.tsx", "happy-dom"],
        ["src/pages/**/*.test.ts", "happy-dom"],
      ],
    },
  };
};
