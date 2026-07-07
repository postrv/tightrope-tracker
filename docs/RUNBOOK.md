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
6. Resolved: OG worker `CompileError` on Cloudflare
7. Data freshness — the curator queue, quarantine triage, and the fixture fallback
8. Cloudflare dashboard hardening checklist (SEC-2 & SEC-4)

---

## Resolved: OG worker `CompileError` on Cloudflare (fixed 2026-07-03)

Share cards used to 500 with `render failed` and, in the worker tail log,
`RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): Wasm code
generation disallowed by embedder)`. Satori's Yoga layout step instantiated
its wasm module from raw bytes at runtime, which the Workers runtime forbids
(only pre-compiled `WebAssembly.Module` imports are allowed). Swapping the
resvg side to `@cf-wasm/resvg` did not help because the ban originated in
Yoga, not resvg.

**Fix (option 1 from the original triage).** `apps/og` now renders through
[`workers-og`](https://github.com/kvnang/workers-og), which bundles a
pre-compiled satori/yoga/resvg and imports each `.wasm` as a module. The
`CompiledWasm` rule in `apps/og/wrangler.toml` resolves those imports to
`WebAssembly.Module` values, so the runtime only ever uses the allowed
module-import instantiation path. Routes, card layouts, caching headers, the
in-worker rate limit, and the render-timeout wrapper are all unchanged — only
`apps/og/src/lib/render.ts` swapped rendering engines. Verified end-to-end
under `wrangler dev` (local workerd enforces the same wasm ban): every
`/og/*.png` route returns `200` `image/png`.

Operational note: workers-og re-runs resvg's one-shot `initWasm()` on every
render, so warm isolates log a harmless `Error: Already initialized` trace.
It is swallowed inside the library (the render still succeeds with the
already-initialised resvg) and can be ignored in `wrangler tail`.

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

## 7. Data freshness — the curator queue, quarantine triage, and the fixture fallback

The non-API sources (OBR EFO PDF, MHCLG live tables, PMI / consumer-confidence
/ RICS press releases, ONS DD failure rate, delivery milestones, timeline
events) used to be hand-refreshed JSON fixtures. **`apps/curator` now owns
their freshness**: a daily poll hashes each source, extracts on change,
verifies against deterministic gates, and either auto-publishes (numeric
series, once signed off) or queues the candidate for human review. The
fixtures still exist, but their role has shifted — they are the **dev/seed
fallback tier**, not the live freshness path (see §7.6).

Everything below assumes the curator is deployed and `ADMIN_TOKEN` (curator's,
distinct from ingest's) and `CURATOR_PUBLIC_URL` are set. Until a source is
flipped `live`, it runs in **shadow mode**: verified and recorded, published
nothing (§7.4).

### 7.1 Reviewing the curator queue

curl + jq is the review UI. The queue lives at `CURATOR_PUBLIC_URL`
(`https://curator.tightropetracker.uk`); the token is the curator worker's
`ADMIN_TOKEN`.

```bash
# List everything awaiting review (also: status=quarantined, shadow, auto_published).
curl -H "x-admin-token: $ADMIN_TOKEN" \
  "https://curator.tightropetracker.uk/admin/captures?status=pending" | jq '.captures[] | {id, sourceId, indicatorId, value, confidence}'

# Full detail for one capture: the anchoring quote, gate-by-gate results, and
# the diff against the currently-published value.
curl -H "x-admin-token: $ADMIN_TOKEN" \
  "https://curator.tightropetracker.uk/admin/captures/123" | jq '{quote: .capture.quote, gates: .gates, diff: .diff}'

# Approve → runs the publish path (observation write / commitment patch /
# timeline insert, dispatched by kind). The Tue/Wed digest emits this exact
# curl pre-filled for every pending row.
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  "https://curator.tightropetracker.uk/admin/captures/123/approve"

# Reject with a recorded reason.
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"reason":"wrong period — this is the May print, not June"}' \
  "https://curator.tightropetracker.uk/admin/captures/123/reject"
```

Editorial kinds (`delivery_milestone`, `delivery_commitment`, `timeline_event`)
are **never** auto-published — they always land as `pending`. Only numeric
statistical series are auto-publish eligible, and only after shadow sign-off.

### 7.2 Quarantine triage

A `quarantined` capture is a value that failed the plausibility range gate
(G3) or the max-delta gate (G4) — from either the curator sweep or the ingest
`writeObservations` plausibility gate (`AUTOMATION_PLAN.md` §2.2). The value is
**withheld** from `indicator_observations`; a webhook alert fires immediately
(even under shadow, because a plausibility breach is worth surfacing).

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" \
  "https://curator.tightropetracker.uk/admin/captures?status=quarantined" | jq '.captures'
```

Triage:

1. Open the detail view and read the failing gate's `detail` and the anchoring
   quote. Confirm against the source URL in the row.
2. **If the value is genuinely correct** (a real regime shift the bounds didn't
   anticipate — e.g. a legitimate large revision), widen the bound in
   `packages/shared/src/plausibility.ts` (and the mirrored `min`/`max`/`maxDelta`
   in `apps/curator/src/sources/registry.ts` — they must not diverge), ship the
   change, then `approve` the capture to publish it.
3. **If the value is wrong** (extraction picked up the wrong figure, a unit
   shift bps↔%, or an upstream typo), `reject` it with the reason. The gate did
   its job.

Never hand-widen a bound just to clear the queue — the 2026-04-29 denominator
class of bugs is exactly what these gates exist to catch.

### 7.3 Shadow-mode comparison procedure

Before a source is flipped to auto-publish it runs two full weekly cycles in
shadow. Shadow mode gates the **publish action for numeric observations**, not
the review queue for editorial drafts:

- **Observation** captures are recorded with `status='shadow'` and
  `decided_by='auto:shadow(intended=...)'` — verified, gate-scored, and
  recorded, but nothing is written to `indicator_observations`. The intended
  (pre-shadow) decision is preserved so you can see what *would* have happened.
- **Editorial** captures (`delivery_milestone`, `delivery_commitment`,
  `timeline_event`) are recorded at their intended `status='pending'` and reach
  the review queue exactly as they would in live mode — human approval is itself
  the safeguard, and they can never auto-publish regardless of `CURATOR_MODE`.
  Review them with `?status=pending`, not `?status=shadow`.

Compare shadow captures against the hand-verified fixture value:

```bash
# What did the curator capture (and would it have auto-published)?
curl -H "x-admin-token: $ADMIN_TOKEN" \
  "https://curator.tightropetracker.uk/admin/captures?status=shadow" \
  | jq '.captures[] | {id, sourceId, indicatorId, value, observedAt: .observedAt, confidence}'

# What is currently published for that indicator (from the fixture / prior run)?
curl -s https://api.tightropetracker.uk/api/v1/score \
  | jq '.pillars[].indicators[] | select(.id=="services_pmi") | {value, observedAt}'
```

Sign-off criteria for a source: across both cycles the shadow value matches the
independently hand-verified figure (same number, same `observed_at`), every
gate passed, and the anchoring quote is verbatim-correct. A single mismatch
resets the clock — investigate the prompt / extraction before flipping.
Flipping is two steps, per source: set `allowAutoPublish: true` for that spec
in `apps/curator/src/sources/registry.ts`, then flip `CURATOR_MODE` to `live`
(see `AUTOMATION_PLAN.md` §6e rollout order).

### 7.4 Corrections discipline for AI revisions

Publishing a value that differs from an already-published value for the same
`(indicator, observed_at)` **must** append a public `corrections` row — this is
non-negotiable and the publish path does it automatically (`publish.ts` →
`insertCorrection`, id prefix `c_ai_`). The reason string names the indicator,
period, old→new values, the source URL, and the anchoring quote.

When you `approve` a revision, confirm the correction landed:

```bash
curl -s https://api.tightropetracker.uk/api/v1/timeline | jq '.corrections[0]'
```

If a human decision reverses an auto-published value, that reversal is itself a
correction — reject-then-republish still routes through the same corrections
append. Never edit a published number in D1 by hand to avoid the corrections
trail; that is the one thing the whole pipeline exists to prevent.

### 7.5 When hand-editing a fixture is still correct

The fixture files (`packages/data-sources/src/fixtures/*.json`) remain the
seed/fallback tier. Hand-edit one when:

- **Seed parity.** After the curator auto-publishes or you approve a
  milestone/housing capture, the live D1 value is fresh but the fixture (which
  seeds a *fresh* deployment) is stale. The Tue/Wed digest reminds you which
  approved values to fold back. This is at-leisure housekeeping — publishing
  never depends on it — but a fresh preview/prod rebuild seeds wrong until you
  do. Follow the refresh procedure below.
- **Curator outage / a source not yet on the curator.** If the curator is down
  or a source has not been onboarded, refresh its fixture by hand exactly as
  before so the fallback path stays fresh.

**Refresh procedure** (unchanged from the pre-curator playbook):

1. Edit the fixture JSON in place. Keep the `_comment` field honest about which
   vintage is shipping.
2. Run the affected adapter tests: `pnpm --filter @tightrope/data-sources test <adapter-name>`.
3. Regenerate the seed: `pnpm tsx db/seed/generate.ts > db/seed/seed.sql`.
4. Re-run the seed-artifact guards: `pnpm --filter @tightrope/shared test seedArtifact`.
   Run `pnpm --filter @tightrope/shared test seedArtifact` after any
   seed-adjacent change.
5. Commit naming the upstream release, e.g. "Refresh OBR EFO fixture for
   2026-03-26 Spring Statement (headroom 23.6bn)".
6. After deploy, trigger a recompute so KV picks up the new values:
   `curl -H "x-admin-token: $ADMIN_TOKEN" https://ingest.tightropetracker.uk/admin/run?source=recompute`.

**Detecting silent staleness.** Fixtures still carry a `published` date;
`assertFixtureFresh` throws `AdapterError` with `ingestion_audit.status =
'failure'` past the max-age threshold. But the primary signal is now the
cadence-state registry (`evaluateCadenceState`): amber = an upstream release
should exist but we haven't ingested it, red = a guard tripped. Check
`/admin/health` for red chips and the daily 07:00 staleness monitor's alerts;
the two-tier selector guarantees a fresher `ai:%` curator row always wins over
a stale fixture-fallback write, so a fixture going stale under a healthy
curator degrades the *fallback*, not the live number.

### 7.6 BoE relay (the Actions network leg)

Since 2026-06-10 the BoE IADB CSV endpoint returns HTTP 500 to Cloudflare
Workers egress IPs — an ASN block, not a header/UA issue (identical requests
succeed from GitHub Actions runners and residential IPs). The four BoE adapters
(`boe_yields`, `boe_fx`, `boe_breakevens`, `boe_mortgage_rates`) therefore run
their **network leg on GitHub Actions**: `relay-boe.yml` (cron `30 9 * * 1-5`
UTC) fetches each raw IADB CSV on a runner and POSTs it to `POST /admin/relay`,
which replays it through the standard adapter machinery. Parse, plausibility
gate, audit, and DLQ are identical to a live run — only the fetch moved off
Cloudflare.

**A red BoE chip on `/admin/health` now means something different.** Triage in
order:

1. **The relay workflow first.** `gh run list --workflow=relay-boe.yml` — did
   the last scheduled run pass? A failed run opens/updates the "BoE relay
   failed" issue. Re-run with `gh workflow run relay-boe.yml`.
2. **Then the probe.** If the relay is failing on the *fetch*, the weekly
   `probe-adapters.yml` run says whether the IADB is reachable from a runner at
   all (upstream drift/outage) versus the ingest `/admin/relay` POST being what
   rejects.
3. **Then the ingest side.** Fetch OK but POST rejected → auth/token or
   plausibility; inspect the ingest audit rows and logs as in §1.

Manual dispatch: `gh workflow run relay-boe.yml`. The workflow reads the ingest
admin token from the **`INGEST_ADMIN_TOKEN` GitHub Actions secret**, which must
equal the ingest worker's `ADMIN_TOKEN` — rotating `ADMIN_TOKEN` (§5) means
updating that Actions secret too. Dry-run the fetch locally without touching
production: `node --import tsx scripts/relay-boe.mjs --dry`.

### 7.7 Triggering a curator job by hand

The curator's four jobs (below) run on cron, but there is no way to *force* one
outside its schedule — e.g. to re-run a sweep after fixing a spec, or to send
the readiness digest early. `POST /admin/run?job=…` does exactly that, running
the **same** code the cron does (per-spec `ingestion_audit` rows and all;
`poll` also fires the dead-man heartbeat on success). It is gated by the
curator's `ADMIN_TOKEN` behind the same constant-time + per-IP backoff as the
review endpoints.

```bash
# Force a full re-capture + verify of every spec (ignores the hash short-circuit).
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  "https://curator.tightropetracker.uk/admin/run?job=sweep" | jq '{ran, results: [.results[] | {sourceId, status, rows}]}'

# Daily change-detection poll (extract only on change) + heartbeat.
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" "https://curator.tightropetracker.uk/admin/run?job=poll"

# Send the editorial readiness digest now (does not wait for Tue/Wed 06:30).
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" "https://curator.tightropetracker.uk/admin/run?job=digest"

# Re-evaluate cadence state + fire any amber→red alerts.
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" "https://curator.tightropetracker.uk/admin/run?job=staleness"
```

`?job=` accepts only `sweep | poll | digest | staleness`; anything else is a
400. A `sweep`/`poll` returns `ok:true` even when individual specs fail (per-spec
isolation) — inspect `.results[]` for the per-source `status`. A relay-backed
spec (`obr_efo`, `ons_dd_failure`) reports `unchanged` here because the Worker
does not fetch it; its data path is the artefact relay (§7.8).

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
