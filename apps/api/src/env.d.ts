// Ambient worker environment. Mirrors the bindings declared in wrangler.toml.
// Keep in sync with apps/web/src/env.d.ts (same binding names contract).
export {};

declare global {
  interface Env {
    DB: D1Database;
    KV: KVNamespace;
    ARCHIVE: R2Bucket;
    ENVIRONMENT: "production" | "preview" | "development";
    PARLIAMENT_API_BASE: string;
  }
}
