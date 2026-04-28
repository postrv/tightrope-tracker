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
    /** LFG ingestion endpoint (Zapier webhook fronting Brevo). Secret. */
    LFG_SIGNUP_API_URL: string;
    /** Brevo list ID for general Tightrope-sourced LFG signups (no digest opt-in). */
    BREVO_LIST_NUMBER: string;
    /** Brevo list ID for signups who opted in to the weekly AI digest. Distinct from
     *  BREVO_LIST_NUMBER so a single Brevo campaign can target the digest segment
     *  directly without filtering by attribute. */
    BREVO_WEEKLY_LIST_NUMBER: string;
    /** Cloudflare Turnstile secret key (paired with PUBLIC_TURNSTILE_SITE_KEY on the web side). Secret. */
    TURNSTILE_SECRET_KEY: string;
    /** Brevo direct-API key. Reserved for future direct integration; not used by the Zapier proxy path today. Secret. */
    LFG_API_KEY: string;
  }
}
