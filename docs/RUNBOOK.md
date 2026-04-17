# Incident runbook

Operational playbook for the Tightrope Tracker stack. Focused on the failure
modes we've seen or actively designed against; update when a new class of
incident emerges.

## Table of contents

1. Stale-score recovery (ingest cron stalled)
2. MP lookup 502 triage
3. Seed rebuild
4. DLQ drain procedure
5. Rotating `ADMIN_TOKEN`
6. Known issue: OG worker `CompileError` on Cloudflare

---

## Known issue: OG image render fails with "Wasm code generation disallowed"

**Symptoms**

- `GET og.tightropetracker.uk/og/*.png` returns 500 with body `render failed`
- Worker tail log: `RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): Wasm code generation disallowed by embedder)`

**Cause**

Satori and its Yoga-layout dependency trigger a runtime `WebAssembly.instantiate(bytes, ...)` call when laying out text. Cloudflare Workers forbid dynamic wasm compilation at runtime — only pre-compiled `WebAssembly.Module` imports are allowed. We tried swapping `@resvg/resvg-wasm` for `@cf-wasm/resvg` to move the resvg side of the pipeline off the dynamic-compile path; the error persists because it originates in Yoga, not resvg.

**Fix path**

Three viable options, none drop-in:

1. Swap the pipeline for [`workers-og`](https://github.com/kvnang/workers-og) — bundles a pre-compiled satori/yoga/resvg for Workers.
2. Move OG rendering to Cloudflare Browser Rendering (a separate service; different auth/pricing).
3. Render OG images at build time into R2 and serve statically.

Until one of these lands, social-card meta tags pointing at `og.tightropetracker.uk` will 500. Consider temporarily pointing `og:image` at a static image on the Pages site.

---

## 1. Stale-score recovery (cron stalled, force recompute)

**Symptoms**

- The homepage shows a "Stale data" chip next to the headline band, or a
  pillar tile shows "stale".
- `GET https://api.tightropetracker.uk/v1/score` returns
  `503 NOT_SEEDED` or a snapshot whose `updatedAt` is hours old.
- `ingestion_audit` rows stop arriving for one or more sources.

**Diagnose**

```bash
# Inspect the last few audit rows.
wrangler d1 execute tightrope_db --remote \
  --command="SELECT source_id, started_at, status, error FROM ingestion_audit ORDER BY started_at DESC LIMIT 20;"

# Check the ingest Worker logs for the last hour.
wrangler tail tightrope-ingest
```

Look for `recompute: pillar 'X' stale` warnings -- they call out which
indicators are missing and why.

**Recover**

```bash
# Manually trigger an ingest + recompute. Substitute the correct source.
curl -H "x-admin-token: $ADMIN_TOKEN" \
  "https://ingest.tightropetracker.uk/admin/run?source=market"
curl -H "x-admin-token: $ADMIN_TOKEN" \
  "https://ingest.tightropetracker.uk/admin/run?source=recompute"
```

If the cron itself has stopped firing (Cloudflare platform incident or
wrangler misconfiguration), re-deploy the ingest Worker:

```bash
cd apps/ingest && pnpm deploy
```

After recovery, verify the headline snapshot KV:

```bash
wrangler kv key get --binding=KV score:latest --remote | jq .headline.updatedAt
```

---

## 2. MP lookup 502 triage

**Symptoms**

- `/api/v1/mp?postcode=...` returns 502.
- `/api/v1/health` reports `mp_lookup: degraded`.

**Diagnose**

The Parliament members API (`members.parliament.uk`) is the most common
failure point. Confirm upstream status:

```bash
curl -sv "https://members-api.parliament.uk/api/Location/Constituency/Search?searchText=SW1A"
```

If the upstream returns 5xx, we're downstream of a third-party incident;
fall back is a cached response from `mp_lookup_cache` -- good for most
postcodes users will actually try. If the upstream returns 200 but our API
returns 502, check `wrangler tail tightrope-api` for a parser or schema
change.

**Recover**

Short-term: advise users to retry later; the API serves cached rows where it
can. Long-term: if the upstream contract has shifted, update the adapter in
`apps/api/src/handlers/mp.ts` and ship.

---

## 3. Seed rebuild

Used when D1 has been wiped (disaster recovery) or we're spinning up a fresh
preview environment.

```bash
# Apply the full schema then seed.
pnpm db:migrate:remote
pnpm db:seed:remote

# Verify row counts.
wrangler d1 execute tightrope_db --remote \
  --command="SELECT 'headline' AS t, COUNT(*) FROM headline_scores
             UNION ALL SELECT 'pillars', COUNT(*) FROM pillar_scores
             UNION ALL SELECT 'indicators', COUNT(*) FROM indicator_observations
             UNION ALL SELECT 'delivery', COUNT(*) FROM delivery_commitments
             UNION ALL SELECT 'timeline', COUNT(*) FROM timeline_events;"
```

Then force a recompute so KV is primed from fresh data rather than the
seed's placeholder scores:

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" \
  "https://ingest.tightropetracker.uk/admin/run?source=recompute"
```

---

## 4. DLQ drain procedure

The ingest Worker consumes its own DLQ: failed adapter runs are logged and
recorded to `ingestion_audit` with `status = 'dlq'`. The consumer acks the
batch, so there's no re-queue loop.

**Inspect the queue**

```bash
wrangler queues list
# Depth spiking? Drill into the audit rows it produced.
wrangler d1 execute tightrope_db --remote \
  --command="SELECT source_id, started_at, error FROM ingestion_audit
             WHERE status = 'dlq' ORDER BY started_at DESC LIMIT 20;"
```

**Replay a failed ingest manually**

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" \
  "https://ingest.tightropetracker.uk/admin/run?source=<source>"
```

If the same source is producing new `dlq` rows every cron tick, stop there
and investigate the adapter -- replaying will just re-DLQ.

---

## 5. Rotating `ADMIN_TOKEN`

Rotate the shared admin token quarterly or immediately on suspected leak.

```bash
# Generate a new 32-byte URL-safe token.
openssl rand -base64 32

# Update the ingest worker's secret binding.
wrangler secret put ADMIN_TOKEN --name tightrope-ingest
# Paste the new token when prompted.

# Update any automation that calls /admin/run (CI, local dev .env).
```

The `admin.ts` handler does a constant-time compare, so a brute-force
attempt on a rotated token remains unfeasible -- but rotate anyway if the
old value was ever written to a shared channel.

---

See also: [DEPLOYMENT.md](./DEPLOYMENT.md) for one-time provisioning steps
and the CI pipeline overview.
