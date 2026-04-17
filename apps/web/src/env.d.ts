/// <reference path="../.astro/types.d.ts" />

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ARCHIVE: R2Bucket;
  ENVIRONMENT: "production" | "preview" | "development";
}

declare namespace App {
  interface Locals extends Runtime {}
}
