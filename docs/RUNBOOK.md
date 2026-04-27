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
7. Fixture-refresh playbook (hand-curated data sources)
8. Cloudflare dashboard hardening checklist (SEC-2 & SEC-4)

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

## 7. Fixture-refresh playbook (hand-curated data sources)

Several indicators are fed by on-disk JSON fixtures rather than live
adapters, because the upstream publisher either doesn't expose a machine
-addressable API (OBR's EFO arrives as a PDF) or is behind a bot-check
(DMO's D2.1E issuance report). Fixtures must be refreshed by hand on the
upstream's publication cadence; stale fixtures are the worst-case credibility
hit because the Auto / fresh chip lies silently.

**Fixture inventory** (as of 2026-04):

| Fixture | Source | Cadence | Where | Indicator(s) |
|---|---|---|---|---|
| `obr-efo.json` | OBR Economic & Fiscal Outlook | Twice a year (Spring/Autumn) | `packages/data-sources/src/fixtures/` | `cb_headroom`, `psnfl_trajectory` |
| `housing-history.json` | MHCLG quarterly planning-consents series | Quarterly | same | `housing_trajectory`, `planning_consents` |
| `delivery-milestones.json` | Hand-coded editorial read of departmental milestones | Quarterly | same | `new_towns_milestones`, `bics_rollout`, `industrial_strategy`, `smr_programme` |
| `ftse-250.json` | LSEG FTSE 250 close | Weekly (editorial) | same | `ftse_250` |

**When to refresh**

- OBR EFO: within 24h of each Spring Statement / Autumn Budget publication.
  The `published` date and every value must be updated together — never
  advance the date without refreshing the figures. The `obrEfo.test.ts`
  regression test will fail if the fixture lands with the 2025-03 crunch
  figure of 9.9bn paired with a 2026+ date.
- MHCLG housing: within a week of each ONS live-tables update. The 2019
  baseline denominator (11,500) is an estimate and documented as such on
  /methodology — replace it with the true ONS 2019 average once we have
  a reliable extraction.
- Delivery milestones: on each ministerial milestone statement. Bump
  `observed_at` even if the underlying state hasn't moved — this is how
  we record that the editorial assessment was revisited.
- ICE / LSEG fixtures: every 7 days. The `assertFixtureFresh` helper in
  `packages/data-sources/src/lib/fixtureFreshness.ts` enforces a 14-day
  hard stop — if a fixture is older than that, the live adapter throws
  `AdapterError` and the source-health chip goes red.

**How to refresh**

1. Edit the fixture JSON in place. Keep the `_comment` field honest about
   which vintage is shipping.
2. Run the affected adapter tests: `pnpm --filter @tightrope/data-sources test <adapter-name>`.
3. Regenerate the seed (for SSG / fresh-database cases):
   `pnpm tsx db/seed/generate.ts > db/seed/seed.sql`.
4. Re-run the seed-artifact guards: `pnpm --filter @tightrope/shared test seedArtifact`.
5. Commit with a message naming the upstream release, e.g. "Refresh OBR
   EFO fixture for 2026-03-26 Spring Statement (headroom 23.6bn)".
6. After deploy, trigger a recompute so KV picks up the new values:
   `curl -H "x-admin-token: $ADMIN_TOKEN" https://ingest.tightropetracker.uk/admin/run?source=recompute`.

**Detecting silent staleness**

Each fixture carries a `published` date. The `assertFixtureFresh` helper
compares that to `Date.now()` and throws `AdapterError` with
`ingestion_audit.status = 'failure'` when the fixture crosses its
max-age threshold. Check `/admin/health` for red chips; the methodology
page's "Last successful ingestion" table will also surface the failure.
Because the audit now distinguishes `success` (content changed) from
`unchanged` (payload byte-identical), a fixture being polled against an
unchanged upstream will show `unchanged`, not a false `success`.

---

## 8. Cloudflare dashboard hardening checklist (SEC-2 & SEC-4)

The code-side security hardening is done in the repo (SEC-1, SEC-3, SEC-5
through SEC-14 — see commit history); the items below are dashboard-only
configuration that can't be expressed in `wrangler.toml`. Run the list once,
then re-verify before any expected traffic spike (TV airtime, press
coverage, social-network virality). Each step lists the exact UI path and
the value to set.

### SEC-2: rate-limit `/admin/*` (defence-in-depth on top of `ADMIN_TOKEN`)

Path: **Cloudflare dashboard → tightropetracker.uk zone → Security → WAF → Rate-limiting rules → Create rule**

Rule body:

| Field        | Value                                                            |
|--------------|------------------------------------------------------------------|
| Rule name    | `admin-endpoints-rate-limit`                                     |
| Match        | `(http.host eq "ingest.tightropetracker.uk" and http.request.uri.path matches "^/admin/")` |
| Characteristics | IP source address                                             |
| Period       | 1 minute                                                         |
| Threshold    | 30 requests                                                      |
| Action       | Block — duration 10 minutes                                      |
| Response     | Default (429)                                                    |

Note: this layers on top of the per-IP exponential backoff in
`apps/ingest/src/lib/adminBackoff.ts` (SEC-13). The WAF rule absorbs
volumetric probing before it ever reaches the worker; the in-worker
backoff handles slow-and-low patterns where the WAF threshold isn't
reached.

### SEC-4: pre-spike Cloudflare configuration

Run the steps below in order. Each step lists the dashboard path and the
expected end state.

**1. Cache rule on the homepage** — absorb the bulk of read traffic at the edge.

Path: **Caching → Cache Rules → Create rule**

| Field      | Value                                                  |
|------------|--------------------------------------------------------|
| Rule name  | `homepage-edge-cache`                                  |
| Match      | `http.host eq "tightropetracker.uk" and http.request.uri.path eq "/"` |
| Cache eligibility | Eligible for cache                              |
| Edge TTL   | 60 seconds (override origin)                           |
| Browser TTL | Respect existing headers                              |

**2. Rate-limit `/api/v1/score/history`** — the heaviest API endpoint.

Path: **Security → WAF → Rate-limiting rules → Create rule**

| Field       | Value                                                |
|-------------|------------------------------------------------------|
| Rule name   | `api-history-rate-limit`                             |
| Match       | `http.host eq "api.tightropetracker.uk" and http.request.uri.path eq "/api/v1/score/history"` |
| Period      | 10 seconds                                           |
| Threshold   | 20 requests                                          |
| Action      | Managed challenge — duration 1 minute                |

**3. Rate-limit `og.tightropetracker.uk/og/*`** — defence-in-depth on top of the in-worker rate-limit (`apps/og/src/lib/rateLimit.ts`).

Path: **Security → WAF → Rate-limiting rules → Create rule**

| Field       | Value                                                |
|-------------|------------------------------------------------------|
| Rule name   | `og-card-rate-limit`                                 |
| Match       | `http.host eq "og.tightropetracker.uk" and starts_with(http.request.uri.path, "/og/")` |
| Period      | 1 minute                                             |
| Threshold   | 200 requests                                         |
| Action      | Block — duration 5 minutes                           |

**4. Bot Fight Mode → OFF (for all tightropetracker.uk hosts)**

Path: **Security → Bots → Bot Fight Mode**

Set **OFF**. Bot Fight Mode interferes with legitimate social-network
preview crawlers (Slackbot, X/Twitter, Facebook External Hit, Discord,
LinkedInBot) which ARE the audience for the OG cards. Cache + rate
limits do the work without false positives on share previews.

**5. DDoS sensitivity → Low**

Path: **Security → DDoS → Settings**

For a small civic site that legitimately receives traffic spikes from
TV / press, "High" sensitivity over-triggers on benign bursts and
challenges real users. "Low" still mitigates volumetric attacks but
gives more headroom before challenges fire. Re-evaluate post-spike.

**6. Tiered Cache → Smart Tiered Caching**

Path: **Caching → Tiered Cache → Smart Tiered Caching = ON**

Reduces origin (Pages function / Workers) hit rate during traffic
bursts by routing edge-PoP requests through a regional Tier-1 cache.
No cost change on the Free / Pro plans; large hit-rate improvement.

**7. Browser Cache TTL on `/_astro/*` (immutable hashed assets)**

Path: **Caching → Cache Rules → Create rule**

| Field      | Value                                              |
|------------|----------------------------------------------------|
| Rule name  | `astro-immutable-assets`                           |
| Match      | `starts_with(http.request.uri.path, "/_astro/")`   |
| Edge TTL   | 1 year                                             |
| Browser TTL | 1 year                                            |
| Headers    | Add response header `Cache-Control: public, max-age=31536000, immutable` |

Astro generates content-hashed filenames for everything under `/_astro/`,
so `immutable` is safe — a content change yields a new path.

**8. Always Online**

Path: **Caching → Configuration → Always Online = ON**

If Pages / origin Workers degrade during the spike, Always Online
serves the last successful cached version of each page. Avoids a
hard-fail headline visible at the worst possible moment.

**9. HTTP/3 (QUIC) → ON**

Path: **Network → HTTP/3 (with QUIC) = ON**

Reduces connection-setup latency on mobile networks, which are over-
represented in TV-driven traffic. No downside.

**10. Verify after configuration**

```bash
# Hit the homepage from a clean curl to confirm Cache-Control is set:
curl -sI https://tightropetracker.uk/ | grep -iE 'cf-cache-status|cache-control'

# Trigger the OG rate limit (should 429 after ~200/min):
for i in {1..210}; do curl -sI https://og.tightropetracker.uk/og/headline-score.png?$i &; done; wait

# Check WAF events arrived:
# Cloudflare dashboard → Security → Events
```

### Post-spike checklist

After the burst subsides:

- DDoS sensitivity → back to Medium / High
- Bot Fight Mode → optionally re-enable if abuse uptick observed
- Review Security → Events for false-positive challenges
- Confirm `Cache-Control: immutable` on `/_astro/*` is still in place
  (Cache Rules occasionally need re-anchoring after a Pages redeploy)

---

See also: [DEPLOYMENT.md](./DEPLOYMENT.md) for one-time provisioning steps
and the CI pipeline overview.
