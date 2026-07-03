# Deployment runbook

This document walks through provisioning the Cloudflare resources and deploying
the stack. Once the resources exist and the four `REPLACE_WITH_*` placeholders
in the `wrangler.toml` files are filled in, future deploys happen automatically
via GitHub Actions on every push to `main`.

## One-time setup

### 1. Cloudflare credentials

Create a scoped API token at
`https://dash.cloudflare.com/profile/api-tokens` with:

- **Account.Cloudflare Pages**: Edit
- **Account.Workers Scripts**: Edit
- **Account.Workers KV Storage**: Edit
- **Account.D1**: Edit
- **Account.Workers R2 Storage**: Edit
- **Zone.Zone**: Read (for `tightropetracker.uk`)
- **Zone.Workers Routes**: Edit (for `tightropetracker.uk`)

Add these secrets to the GitHub repo:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token above |
| `CLOUDFLARE_ACCOUNT_ID` | account id from the Cloudflare dashboard |

Locally: `wrangler login`.

### 2. Provision data stores

```bash
# D1 (production)
wrangler d1 create tightrope_db

# KV (production)
wrangler kv namespace create tightrope_kv

# R2 buckets
wrangler r2 bucket create tightrope-archive
wrangler r2 bucket create tightrope-fonts
```

Copy the returned ids into `apps/web/wrangler.toml`, `apps/api/wrangler.toml`,
`apps/og/wrangler.toml`, and `apps/ingest/wrangler.toml` -- replace every
`REPLACE_WITH_PROD_*` placeholder.

Optionally repeat the D1 + KV create step for a preview environment and fill
in the `REPLACE_WITH_PREVIEW_*` placeholders in `apps/web/wrangler.toml`.

### 3. Apply the schema and seed

```bash
pnpm db:migrate:remote
pnpm db:seed:remote       # first deploy only -- ingest worker takes over afterwards
```

### 4. Upload fonts to R2

Used by the OG image worker.

```bash
pnpm tsx apps/og/scripts/upload-fonts.ts
```

### 5. Create the ingestion dead-letter queue

```bash
wrangler queues create tightrope-ingest-dlq
```

### 6. Configure the domain

In the Cloudflare dashboard for `tightropetracker.uk`:

- Add a **Pages** custom domain for the web app (root + `www`)
- Add a Worker route for `api.tightropetracker.uk/*` -> `tightrope-api`
- Add a Worker route for `og.tightropetracker.uk/*` -> `tightrope-og`

The `ingest.tightropetracker.uk` and `curator.tightropetracker.uk` hosts are
declared as `custom_domain = true` routes in their `wrangler.toml` files, so
`wrangler deploy` provisions them automatically on the zone — no manual route
needed, but the zone must be active in this account first.

### 7. Set the ingest worker admin token

```bash
wrangler secret put ADMIN_TOKEN --name tightrope-ingest
```

### 8. Provision the curator worker (`tightrope-curator`)

The curator reuses the ingest worker's **production** D1 / KV / R2 by id — the
bindings in `apps/curator/wrangler.toml` already carry the same ids, so there
is nothing new to create for those. The `AI` binding is a Workers AI binding:
it needs **no resource creation**, only the binding declaration (already
present). The custom-domain route (`curator.tightropetracker.uk`) is
provisioned by `wrangler deploy` (see step 6).

Set the curator secrets (vars — `CURATOR_MODE`, `CURATOR_PUBLIC_URL`,
`INGEST_ADMIN_URL` — live in `wrangler.toml`, not here):

```bash
# The review-endpoint token. GENERATE FRESH — do not reuse ingest's.
openssl rand -base64 32
wrangler secret put ADMIN_TOKEN --name tightrope-curator

# Ingest's admin token, so the approve path can POST /admin/delivery-commitment.
# This is the SAME value you set in step 7 (ingest's ADMIN_TOKEN).
wrangler secret put INGEST_ADMIN_TOKEN --name tightrope-curator

# Same Slack-shaped webhook the ingest worker posts to (editorial digest +
# quarantine alerts). Optional — unset makes alerts a no-op.
wrangler secret put ALERT_WEBHOOK_URL --name tightrope-curator

# Dead-man switch (healthchecks.io-style). Optional. Use a DIFFERENT check
# from ingest's so the two heartbeats are independent signals.
wrangler secret put HEARTBEAT_URL --name tightrope-curator
```

The worker ships with `CURATOR_MODE = "shadow"`: it captures, verifies, and
records but publishes nothing. Flip it to `"live"` (and enable
`allowAutoPublish` per source) only after the two-cycle shadow sign-off — see
the rollout checklist in `AUTOMATION_PLAN.md`.

**Preview env.** Like the other workers, `apps/curator/wrangler.toml` has an
`[env.preview]` block with `REPLACE_WITH_PREVIEW_*` placeholders for a
preview-isolated D1 / KV / R2. Provision preview resources and fill them before
any `--env preview` remote-bound testing; there are no crons in preview.

## Ongoing deploys

```bash
git push origin main
```

GitHub Actions runs:

1. `migrate` -- applies any pending D1 migrations automatically (every file in
   `db/migrations/` newer than the last-applied migration is applied in order).
   New migrations therefore land with the next CI deploy; you do not need to
   run `wrangler d1 migrations apply` by hand unless backfilling a preview env.
2. `snapshot` -- exports the live D1 to a signed artifact for the nightly audit log
3. `deploy-api`, `deploy-og`, `deploy-ingest`, `deploy-curator` -- in parallel
   (all gated on `migrate`, so migration 0011's `curator_captures` table exists
   before the curator runs)
4. `deploy-web` -- gated on the three core workers

A failed migration halts the whole pipeline; workers don't deploy against a
stale schema.

## Rollback

Workers are versioned. In the Cloudflare dashboard, select a worker
-> **Deployments** -> "Rollback to" on the previous release. D1 migrations are
forward-only; to reverse, write a new migration.

## Local end-to-end

```bash
pnpm install
pnpm db:migrate:local
pnpm db:seed:local
pnpm dev               # http://localhost:4321
pnpm dev:api           # http://localhost:8787
pnpm dev:og            # http://localhost:8788
pnpm dev:ingest        # http://localhost:8789 -- supports /__scheduled?cron=...
pnpm dev:curator       # http://localhost:8790 -- --test-scheduled for cron jobs
```

## Incidents

For stale-score recovery, MP-lookup triage, seed rebuilds, DLQ drains, and
`ADMIN_TOKEN` rotation, see [RUNBOOK.md](./RUNBOOK.md).

## Troubleshooting

- **`database_id` missing**: the `REPLACE_WITH_*` placeholder is still in
  one of the `wrangler.toml` files. Search for the string and fix.
- **MP lookup returning 502**: the parliament.uk Members API is down. The
  API worker should degrade gracefully -- check `/api/v1/health`.
- **OG images returning 500**: fonts not in R2 yet. Run
  `pnpm tsx apps/og/scripts/upload-fonts.ts`.
- **Scores not updating**: check `SELECT * FROM ingestion_audit ORDER BY
  started_at DESC LIMIT 10;` via `wrangler d1 execute tightrope_db --remote
  --command="..."`.
