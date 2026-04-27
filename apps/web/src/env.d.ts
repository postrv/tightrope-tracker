/// <reference path="../.astro/types.d.ts" />

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ARCHIVE: R2Bucket;
  ENVIRONMENT: "production" | "preview" | "development";
}

declare namespace App {
  interface Locals extends Runtime {
    /**
     * SEC-10: per-request CSP nonce. Set by `src/middleware.ts` on every
     * request and consumed by every inline `<script nonce={...}>` in the
     * .astro templates so the CSP can drop `'unsafe-inline'` from
     * `script-src`.
     */
    cspNonce: string;
  }
}
