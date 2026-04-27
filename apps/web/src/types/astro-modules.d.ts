/**
 * Module declaration for `.astro` files imported in `.ts` test files.
 *
 * Astro's official typecheck path is `@astrojs/check`, which runs a
 * language-server pass that knows about `.astro` SFC types. Plain tsc,
 * which we use in `pnpm typecheck`, doesn't — so a top-level Component
 * type stub is enough to keep the typechecker happy when a test file
 * imports an `.astro` component module.
 *
 * The runtime types are still verified at vitest time: vitest renders
 * the component via Astro's vite plugin, which catches genuine prop /
 * shape errors in the component.
 */
declare module "*.astro" {
  import type { AstroComponentFactory } from "astro/runtime/server/index.js";
  const Component: AstroComponentFactory;
  export default Component;
}
