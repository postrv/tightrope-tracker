export {};

declare global {
  interface Env {
    DB: D1Database;
    KV: KVNamespace;
    /**
     * R2 bucket holding our TTF fonts. The bucket is optional in dev — if the
     * binding is undefined we fall back to fetching from the web on first use.
     */
    FONTS: R2Bucket | undefined;
    ENVIRONMENT: "production" | "preview" | "development";
  }
}
