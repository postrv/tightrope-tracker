# Self-maintaining data pipeline — implementation plan

Status: **code-complete on `automation-overhaul` (Waves 1–6); pending
production rollout.** Prepared 2026-07-03. Phases 0–4 are implemented and
tested on the branch; Phase 5 below is the production rollout runbook and the
acceptance criteria track code-complete vs pending-production.

## Goals

1. **Recover data quality now** — several hand-curated fixtures have gone
   stale since the late-April audit; one freshness guard has already tripped
   and a second trips mid-July (see Phase 0 table).
2. **Fix the architectural debt** that makes staleness silent and changes
   risky (tri-writer snapshot cache, three copies of the latest-observation
   SQL, dead adapters, no runtime write path for editorial tables).
3. **Make the pipeline self-maintaining** — a new `apps/curator` Worker uses
   Cloudflare Workers AI to capture, extract, verify, and publish the
   non-API sources that are today refreshed by hand, with a human approval
   queue for anything editorial and hard deterministic gates on everything.
   Sweeps are timed so the dataset is verified-fresh ahead of the **weekly
   editorial deadline (Tuesday/Wednesday)**.

### Repo conventions the implementer must follow

- Media-partner and programme names must **never** appear in code, copy,
  comments, or commit messages. Use "weekly editorial deadline" in any
  scheduling copy.
- No new runtime dependencies without strong cause. This codebase
  deliberately hand-rolls validation/parsing (see `packages/data-sources/src/lib/csv.ts`,
  the regex XML parser in `dmoGiltPortfolio.ts`). Match that idiom; do not
  introduce zod/cheerio/pdf-js unless a phase below explicitly allows it.
- Every published number must be traceable to a primary source. The AI
  pipeline below is designed around that constraint — provenance is not
  optional metadata, it is the product.
- Corrections are public: any revision of an already-published value must
  land in the `corrections` table (see `db/patches/log-2026-04-29-*.sql`
  for tone and shape).
- All tests green before merge: `pnpm -r typecheck && pnpm -r test`.

### Current architecture (10-second version)

- `apps/ingest` — 4 crons (`*/5` market+recompute; 02:00/02:15/02:30 fiscal/
  labour/delivery). Adapters from `packages/data-sources` write
  `indicator_observations` (D1); `recompute.ts` scores and writes
  `score:latest` to KV. Audit trail in `ingestion_audit`.
- `apps/api` / `apps/web` — read the KV snapshot, and **both re-prime it**
  on miss/staleness via their own copies of the snapshot-build SQL.
- Non-API sources ship as JSON fixtures inside the Worker bundle and are
  refreshed by hand (`docs/RUNBOOK.md` §7).
- No Workers AI, Browser Rendering, or PDF/XLSX parsing exists anywhere yet.
- `delivery_commitments` and `timeline_events` have **no runtime write
  path** — they change only via hand-run SQL patches.

---

## Phase 0 — Manual data catch-up (do first, no code required)

Every fixture was last refreshed 2026-04-18 → 2026-04-29. State as of
2026-07-03, in priority order:

| Fixture (`packages/data-sources/src/fixtures/`) | Latest data | Guard / maxStale | State on 2026-07-03 | Action |
|---|---|---|---|---|
| `growth-sentiment.json` | 2026-03-31 | 40d fixture guard | **TRIPPED (~10 May)** — `services_pmi`, `consumer_confidence`, `rics_price_balance` fail every market cron; check `/admin/health` | Append April, May, June prints from the S&P Global UK Services PMI final releases, GfK/NIQ consumer confidence barometer, RICS Residential Market Survey. Also append the same points to `services-pmi-history.json`, `consumer-confidence-history.json`, `rics-price-balance-history.json`. |
| `delivery-milestones.json` | observed 2026-04-17 | 90d fixture guard | **Trips ~16 July** — would drop 4 of 6 delivery indicators; quorum `ceil(6×0.5)=3` then fails and the delivery pillar stops persisting | Re-review all four editorial assessments against departmental announcements since mid-April; bump `observed_at` (RUNBOOK: bump even if state unchanged), keep citations per point. |
| `ons-rti.json` (`dd_failure_rate`) | 2026-03-31 | indicator maxStale 60d | **Stale since ~end May** | Refresh from the upstream cited in the fixture `_comment`. |
| `housing.json` + `housing-history.json` | 2025-Q4 (pub 2026-03-19) | indicator maxStale 130d | Q1-2026 MHCLG release expected ~June — verify and refresh; guard trips late July otherwise | Follow the refresh procedure at the top of `housing-history.json` (documented formulas), then re-run backfill (commands below). |
| `brent.json`, `ftse-250.json` | 2026-04-20 / 04-24 | 14d guard **on fallback only** | Benign iff `EIA_API_KEY` / `EODHD_API_KEY` are set in prod and the live paths are succeeding — **verify via `/admin/health`** | Refresh fixtures anyway (cheap insurance for the fallback path). |
| `obr-efo.json` | 2026-03 EFO | 220d indicator maxStale | Current until the Autumn Budget | No action. |
| `mortgage.json` | 2026-04-01 | — | `moneyfacts` adapter is no longer wired into any pipeline (`boe_mortgage_rates` is live via BoE IADB `IUMBV34`) | No refresh. Retire the adapter in Phase 1.2. |
| `*-history.json` (all) | end 2026-04 | — | 90-day chart has a May–June gap for fixture-fed series | After live-fixture refresh, re-run backfill. |

Also review `delivery_commitments` and `timeline_events` content (last
touched April): until Phase 1.3/1.4 land, updates go through
`db/patches/*.sql` + `wrangler d1 execute` per existing patch precedent.

**Procedure per fixture** — follow `docs/RUNBOOK.md` §7 exactly (edit JSON →
adapter tests → regenerate seed → seed-artifact guards → commit naming the
upstream release → deploy → recompute). Then:

```bash
# force the pipelines that own the refreshed sources
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" "https://ingest.tightropetracker.uk/admin/run?source=market"
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" "https://ingest.tightropetracker.uk/admin/run?source=delivery"
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" "https://ingest.tightropetracker.uk/admin/run?source=labour"

# MHCLG back-series + score backfill (memory of prior runs: this exact sequence)
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" "https://ingest.tightropetracker.uk/admin/run?source=backfill-observations&adapter=mhclg&overwrite=true"
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" "https://ingest.tightropetracker.uk/admin/run?source=backfill-scores&days=365&overwrite=true"

# verify
curl -H "x-admin-token: $ADMIN_TOKEN" "https://ingest.tightropetracker.uk/admin/health"   # all chips green
curl -s https://api.tightropetracker.uk/api/v1/score | jq '.headline.updatedAt, .sourceHealth'
```

**Exit criteria:** `/admin/health` shows no `failure`/`partial` rows; no
indicator older than its cadence; 90-day history chart has no gap; and
`pnpm --filter @tightrope/data-sources test` is green — as of 2026-07-03 the
build-time fixture-freshness guards (`fixtureFreshness.build.test.ts`) fail
on 7 fixtures plus 5 downstream adapter tests, which means CI on `main` has
been red since roughly late May. That test run IS the local acceptance gate
for this phase.

---

## Phase 1 — Architecture remediation

Ordered by leverage. Each item: problem → change → acceptance.

### 1.1 Single snapshot builder (kill the tri-write)

**Problem.** `score:latest` is written by three independent code paths:
`apps/ingest/src/pipelines/recompute.ts:209` (authoritative, every 5 min),
`apps/api/src/handlers/score.ts:81` (re-prime on miss/stale), and
`apps/web/src/lib/db.ts:54-64` (same). The two-tier latest-observation SQL
(live rows by `MAX(ingested_at)`, `hist:` rows by `MAX(observed_at)`) exists
in **three copies**: `apps/api/src/lib/db.ts:149-181`, `apps/web/src/lib/db.ts`,
`apps/ingest/src/lib/history.ts::readLatestLiveObservations`. A new snapshot
field silently ships dark unless all writers are updated (this bit us with
`sourceHealth` on 2026-04-18).

**Change.** Create `packages/snapshot` (workspace package, deps:
`@tightrope/shared`, `@tightrope/methodology`, `@cloudflare/workers-types`):

- `readLatestObservations(db)` — the single two-tier selector.
- `buildSnapshotFromD1(db)` — move from `apps/api/src/lib/db.ts:57`.
- `primeSnapshotCache(kv, snapshot)` — the only function allowed to write
  `score:latest` / `score:history:90d` (owns TTLs and key names as exported
  constants).

Ingest recompute, api score handler, and web db all consume this package.
Behaviour-preserving refactor: keep serve-time staleness inference
(`isScoreRowStale`, 30-min ceiling) identical.

**Acceptance.** `grep -r "score:latest" apps packages` shows reads plus
exactly one write site (the package). The two-tier SQL exists once. All
existing api/web/ingest tests pass unchanged. Post-deploy: delete the KV key
once (`wrangler kv key delete --binding KV --remote score:latest`) and
confirm rebuild.

### 1.2 Retire dead adapters and secrets

`lseg_housebuilders` (superseded by `eodhd_housebuilders`) and `moneyfacts`
(superseded by `boe_mortgage_rates`) are registered but unwired; the
deprecated `TWELVE_DATA_KEY` still threads through `env.ts` and
`runAdapter.ts`. Delete the adapters + fixtures they exclusively own, purge
`INACTIVE_INGEST_SOURCES` entries that no longer produce audit rows, drop
the secret plumbing, regenerate `SOURCES.md` (it self-describes as generated
— keep the "generated on" date honest). Acceptance: `pnpm -r test` green;
`/admin/health` shows no permanently-grey sources.

### 1.3 Runtime write path for `delivery_commitments`

**Problem.** The `/api/v1/delivery` scorecard changes only via hand-run SQL
patches; zero `INSERT/UPDATE delivery_commitments` exists in TypeScript.

**Change.** New ingest admin endpoint `POST /admin/delivery-commitment`
(token-gated, same `adminAuthGate` + `timingSafeEqual` pattern as
`admin.ts:19`): body `{id, latest?, status?, notes?, source_url?,
source_label?}` → validated field-allowlist `UPDATE` → bump `updated_at` →
purge `delivery:latest` KV → write an `ingestion_audit` row (source
`delivery_commitments_admin`). This is the substrate the Phase 3 approval
queue publishes through.

**Acceptance.** Round-trip test: patch a row via curl, see it on
`/api/v1/delivery` within one cache window; audit row present.

### 1.4 Timeline candidates become reviewable (stop dropping them)

**Problem.** `govUkRss.ts` pushes timeline-event candidates to the DLQ,
whose consumer logs, writes an audit row, and **acks** — candidates are
effectively discarded unless someone reads Worker logs.

**Change.** Candidates go to the new `curator_captures` table (migration
0011, `kind='timeline_event'`, `status='pending'`) instead of the DLQ.
Review/approval flows through the Phase 3 admin endpoints; approval INSERTs
into `timeline_events` and purges `timeline:latest`. (Ship the migration
with this phase; the table is deliberately shared with Phase 3.)

### 1.5 Fix the OG worker (highest-visibility defect)

Share-card renders 500 today (`RUNBOOK.md` "Known issue": Satori/Yoga
dynamic-Wasm ban). During a broadcast-driven traffic spike the share cards
ARE the product. Take option 1 from the runbook: swap the pipeline to
`workers-og` (pre-compiled satori/yoga/resvg for Workers). Budget a day;
keep `apps/og/src/lib/render.ts`'s timeout wrapper. Acceptance: `curl -sI
https://og.tightropetracker.uk/og/headline-score.png` → 200 `image/png`;
remove the runbook known-issue section.

### 1.6 Small cleanups

- `packages/shared/src/openapi.ts` imports itself (only cycle in the repo)
  — restructure the type reference.
- `eodhd_housebuilders` fixture fallback has **no** freshness guard
  (`payloadHash:"fixture-fallback"`) — add `assertFixtureFresh` at 14d to
  match its siblings.
- `runAdapter.ts`: add one bounded retry (2 attempts, ~10s spacing) for
  network-class failures only (fetch throw / upstream 5xx). Parse errors
  must NOT retry — a schema drift re-fails identically and the audit trail
  should show one honest failure. Keep adapters sequential (BoE/ONS rate
  courtesy).

---

## Phase 2 — Data-quality hardening

### 2.1 Release-cadence registry (staleness becomes predictive, not binary)

Extend the `SOURCES` metadata map (`packages/shared/src/indicators.ts:505`)
with `expectedCadence: "trading-daily" | "monthly" | "quarterly" |
"biannual" | "event"` and `graceDays`. New shared helper
`evaluateCadenceState(latestObservedAt, releasedAt, cadence): "green" |
"amber" | "red"` — amber = a new upstream release should exist but we
haven't ingested it; red = guard tripped / maxStale exceeded. Surface per
indicator in `/admin/health`, in snapshot `sourceHealth` (via the Phase 1.1
package — single edit point now), and on the methodology page's ingestion
table. This is what makes "data going a little stale" visible *before* a
guard trips.

### 2.2 Plausibility gates on every observation write

`writeObservations` (`apps/ingest/src/lib/observations.ts:15`) currently
writes whatever an adapter emits. Add a per-indicator plausibility table in
`packages/shared` (`plausibility.ts`: `{min, max, maxJumpPerDay}` — seed
values in Appendix A). Violations do **not** write to
`indicator_observations`; they insert a `curator_captures` row with
`status='quarantined'` + fire the alert webhook. Manual release via the
Phase 3 approve endpoint. Unit-test the gate against the 2026-04-29 audit's
known-bad cases (denominator misalignment class).

### 2.3 Alerting upgrade + dead-man switch

Today: Slack-shaped webhook, only after a source fails for >1h, KV-deduped.
Add:
- **cron_miss alerts** — a `cron_miss` audit row means the schedule itself
  broke; that's currently silent.
- **Daily 07:00 UTC digest** (curator cron, Phase 4): ambers, quarantines,
  pending approvals. Quiet when all green.
- **Dead-man heartbeat**: `HEARTBEAT_URL` secret (healthchecks.io-style);
  recompute and curator sweeps GET it on success. External service emails
  when silent — covers "Cloudflare cron stopped firing", which no in-stack
  alert can.

### 2.4 Adapter contract tests + weekly live probe

`scripts/probe-adapters.mjs` exists but runs ad hoc. Add a GitHub Actions
weekly cron (Mon 06:00 UTC) running it against live upstreams; open an
issue on failure. Catches upstream format drift days before the Tuesday
sweep would.

---

## Phase 3 — `apps/curator`: AI capture → verify → publish

### Why a separate Worker

Isolates the AI/browser bindings and their latency from the deterministic
5-minute ingest loop; independent cron budget (account is on Workers Paid —
Queues require it — so the 250/account cron cap is not a constraint;
**verify plan before deploy**); scheduled handlers at ≥1h intervals get up
to 15 min CPU; a curator bug can never take down market ingestion.

### Non-negotiable design rules

1. **The model never writes to `indicator_observations` directly.** Every
   candidate lands in `curator_captures` and passes gates first.
2. **Quote-anchoring.** The extractor must return the verbatim source
   sentence containing each value; verification re-locates that quote in
   the captured artefact text. A value without a locatable quote is
   unpublishable, categorically.
3. **Editorial content is never auto-published.** `delivery_milestones`,
   `delivery_commitments`, `timeline_events` drafts always await human
   approval. Only numeric statistical series are auto-publish eligible, per
   source, behind a flag that defaults off until Phase 5 rollout.
4. **Provenance on every row**: source URL, retrieval time, artefact
   sha256 (raw bytes archived to R2), model id, prompt version, gate-by-gate
   verification JSON.
5. **Revisions are corrections.** Publishing a different value for an
   (indicator, observed_at) already published appends to `corrections`.

### Data flow

```
[cron] → for each CaptureSpec:
  capture   fetch artefact(s) → sha256 → same hash as last time? stop ("unchanged")
            → archive raw bytes to R2  curator/{sourceId}/{date}-{sha8}.{ext}
  extract   Workers AI, JSON-schema mode → {value(s), observed_at, released_at,
            unit, quote, context}     (retry ≤2 on schema-invalid output)
            derived specs (§ Derived indicators, below) extract RAW printed
            components; the ratio is computed post-validation in the same
            call, so retries, the 5024 rescue, and G5 all inherit it
  verify    G1 quote found verbatim in artefact text (whitespace-normalised)
            — derived values anchor EVERY component quote instead
            G2 schema + unit sanity
            G3 plausible range          (shared plausibility table, 2.2)
            G4 max-delta vs latest published observation
            G5 independent second extraction (different prompt framing) agrees
               within per-source tolerance
            G6 period sanity (observed_at ≤ now, newer than last, fits cadence)
  decide    all gates pass ∧ numeric ∧ spec.allowAutoPublish → auto-publish
            else → status 'pending' in the review queue
  publish   INSERT OR REPLACE indicator_observations
            payload_hash = "ai:" + sha256   (passes the live tier of the
            two-tier selector: not hist:%, not seed%)
            → picked up by the next 5-min recompute tick (≤5 min later; no
              KV surgery needed)
            → corrections row if this revises a published value
  notify    Tue/Wed editorial digest + immediate webhook on quarantine
```

### Derived indicators (component extraction)

Added 2026-07-12, after `mhclg_housing` proved structurally impossible under
the plain contract: both its indicators are ratios the releases never print
(`housing_trajectory` = SA-quarterly completions × 4 ÷ 300,000 × 100;
`planning_consents` = residential decisions granted ÷ 11,500 × 100).
Prompt rule 4 forbids emitting unstated values and G1 demands a verbatim
quote per value, so the model could only refuse (the 2026-07-08..12 5024
storm) or fabricate (its only two pre-derive "successes" recorded invented
95 / 120 at confidence 0.3 — exactly what the gates exist to catch).
(Both mhclg derivations turned out single-component once verified against
the 2026 Q1 releases' real phrasing — the planning release prints the
residential-granted total as one quotable bullet. Multi-component SUMS are
fully supported by the machinery and pinned by tests, for releases that only
print a breakdown.)

Mechanism:

- A `CaptureSpec` may carry `derive: { [indicatorId]: { components, compute } }`
  (apps/curator/src/types.ts). Each `ComponentSpec` names one RAW printed
  figure (`key`, prompt-brief label/unit/description, optional loose
  `min`/`max` sanity bounds — fail-fast ergonomics; G3 on the derived scale
  remains the real safety layer).
- The prompt brief lists the components instead of the derived indicators, in
  BOTH framings (or G5's second pass would have nothing derivable), plus a
  "report only these raw figures; do NOT sum/annualise/compute ratios" block.
- `applyDerivation` (apps/curator/src/lib/derive.ts) runs inside
  `parseAndValidate`, so every extraction path derives identically: schema
  retries, the 5024 shrink-window retries, the schema-free rescue, and the G5
  second extraction. Failures are loud, distinct, component-named
  (`DERIVE_MISSING_COMPONENT`, `DERIVE_DUPLICATE_COMPONENT`,
  `DERIVE_OBSERVEDAT_MISMATCH`, `DERIVE_COMPONENT_OUT_OF_BOUNDS`,
  `DERIVE_NON_FINITE`) and consume schema retries like any validation miss —
  they are not 5024s, so they never trigger the schema-free rescue.
- A model value carrying a derived id is DROPPED (warn-logged): the computed
  value is the only carrier of a derived indicatorId, so a fabricated ratio
  can never ride in on a locatable-but-unrelated quote.
- Gate G1 anchors every component's verbatim quote (AND, weakest named); the
  derived value's own `quote` is the components' quotes joined for human
  reading and is never itself anchored. G2–G6 run unchanged on the derived
  scale — G3/G4 against the shared plausibility table, G5 derived-vs-derived.
- Capture rows persist components in the `payload` JSON
  (`{unit, components:[{key,value,unit,observedAt,quote}]}`), so a reviewer
  can check the computation from `GET /admin/captures/:id` alone.
- Formulas + constants live in `packages/shared/src/derivations.ts`; a
  drift-guard test in packages/data-sources pins the hand-maintained
  housing.json / housing-history.json values to the same formulas.

Expected day-one behaviour: while the current quarter is already published
from the fixture path, a capture run yields **G1–G5 pass, G6 FAIL** ("not
newer than published") at confidence 0.9 — correct, not a bug. The genuine
end-to-end test is the next MHCLG quarterly release. Contingency if 5024s
persist despite component extraction: split `mhclg_housing` into two specs
(housing-supply / planning), halving the artefact and decoupling the two
collections' publication lag.

### What ships in the skeleton (this commit) vs. what the implementer builds

Skeleton (already written, compiles as stubs):
- `db/migrations/0011_curator_captures.sql` — the staging/review/audit table.
- `apps/curator/wrangler.toml` — bindings (same D1/KV/R2 ids as ingest, plus
  `[ai]`), cron triggers, preview-env stub.
- `apps/curator/src/{env,types,index}.ts` — Env contract, capture types,
  cron dispatch + admin route skeleton.
- `apps/curator/src/sources/registry.ts` — `CaptureSpec` contract with
  `services_pmi` fully specified as the reference implementation; remaining
  specs stubbed with TODO + Appendix A parameters.
- `apps/curator/src/pipeline/{capture,extract,verify,publish,digest}.ts` —
  stage contracts as doc comments, bodies TODO.

Implementer builds (heavy lifting):
1. Stage implementations in `pipeline/*` to the documented contracts.
2. PDF handling: prefer Workers AI's markdown-conversion utility
   (`env.AI.toMarkdown`) for PDF artefacts — **verify current availability
   and model catalog at implementation time**; docs caveat that JSON mode
   is best-effort, hence the schema-validate-and-retry wrapper in
   `extract.ts`. Model default: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
   (JSON-mode capable); pin per-spec so upgrades are deliberate.
3. Remaining `CaptureSpec`s per Appendix A. Where the value lives in an
   HTML statistical release (MHCLG, ONS), extract from HTML — do NOT parse
   ODS/XLSX in the Worker. Browser Rendering is a fallback only if a source
   proves JS-gated; add the binding then, not preemptively.
4. Review endpoints (see below) + gov.uk RSS triage (reroute of Phase 1.4
   candidates through an AI relevance/dedup pass into drafts).
5. Fixture-adapter interplay: once curator owns a source, its fixture
   becomes a dev/seed fallback. Requirement (implementation choice open):
   after curator go-live for a source, a stale fixture must NOT produce red
   health chips or lose to silence — e.g. teach `runAdapterSafe` to
   downgrade a fixture-staleness `AdapterError` to `unchanged` when a
   fresher `ai:%` row exists for every indicator the adapter feeds. The
   two-tier selector already guarantees fresher AI rows win reads.
6. Fixture/seed parity: approved milestone/housing captures should remind
   (via digest) to fold values back into the fixture at leisure so fresh
   deployments seed correctly — publishing does not depend on it.

### Review queue endpoints (curator worker, `ADMIN_TOKEN`-gated, same
backoff pattern as ingest — extract `adminBackoff.ts` into a shared lib or
copy it verbatim; do not weaken it)

```
GET  /admin/captures?status=pending          list (id, source, kind, value, confidence, age)
GET  /admin/captures/:id                     full detail: quote, artefact excerpt,
                                             gate results, diff vs currently-published value
POST /admin/captures/:id/approve             → publish path (observation / commitment
                                             UPDATE via ingest admin / timeline INSERT)
POST /admin/captures/:id/reject   {reason}   → status 'rejected', reason recorded
GET  /__healthz                              unauthenticated liveness
```

curl + jq is the v1 review UI. A private HTML page is a nice-to-have,
explicitly out of scope for this plan.

### Cost note

~10 sources × daily hash-poll (no AI call when unchanged) + ~30
extraction+verify pairs/month on a 70B model ≈ negligible Workers AI neuron
spend (well under £5/month). Not a design constraint.

---

## Phase 4 — Scheduling & self-maintenance

Ingest crons: **unchanged**. Curator crons (in skeleton `wrangler.toml`):

| Cron (UTC) | Job | Notes |
|---|---|---|
| `0 5 * * 2` and `0 5 * * 3` | **Pre-deadline sweep**: force-capture every spec (ignore hash short-circuit), full verify | 05:00 UTC = 06:00 London in summer — results ready at the start of the editorial day, both days of the deadline window |
| `30 6 * * 2,3` | **Editorial readiness digest** → webhook: pillar deltas, ambers/reds, pending approvals (with ready-to-paste approve curls), upstream releases expected in the next 7 days (from the 2.1 cadence registry) | The "is the dataset broadcast-ready?" answer, delivered before anyone asks |
| `0 6 * * *` | Daily change-detection poll: fetch + hash-compare each source page, extract only on change; heartbeat ping; quiet unless something needs a human | This is the "self-maintaining" loop — event-driven sources (OBR EFO) get picked up within 24h of publication |
| `0 7 * * *` | Staleness monitor: cadence-state evaluation across all indicators; alert on amber→red transitions and `cron_miss` rows | |

Dead-man heartbeats (Phase 2.3) fire from both ingest recompute and the
daily curator poll — two independent "the platform is alive" signals.

---

## Phase 5 — Rollout, testing, acceptance

### Production rollout checklist (the exact ordered runbook)

Waves 1–6 landed the code on `automation-overhaul`. This is the concrete
sequence a human runs **after merging to `main`**. CI (`deploy.yml`) automates
the migration + worker deploys; the KV surgery, secrets, verification,
shadow-comparison, live flip, and dashboard rules are human steps. Run them in
order.

**Pre-merge gate.** `pnpm -r typecheck && pnpm -r test` green;
`pnpm --filter @tightrope/shared test seedArtifact` green. Then merge.

**Step 1 — Apply migration 0011 + deploy (CI does this automatically).**
On push to `main`, CI runs `migrate` (`pnpm db:migrate:remote` =
`wrangler d1 migrations apply tightrope_db --remote`, which applies
`0011_curator_captures` and any other pending migration in order), then deploys
the workers. If deploying **by hand** instead, the equivalent ordered commands
(deploy order: ingest, api, web, og, then curator):

```bash
pnpm db:migrate:remote                                   # applies 0011 + pending
pnpm --filter @tightrope/ingest run deploy
pnpm --filter @tightrope/api run deploy
pnpm --filter @tightrope/web build && pnpm --filter @tightrope/web run deploy
pnpm --filter @tightrope/og run deploy
pnpm --filter @tightrope/curator run deploy              # last
```

**Step 2 — One-time KV delete (snapshot-builder consolidation, Phase 1.1).**
`score:latest` now has a single writer (`@tightrope/snapshot`). Delete the key
once so the first read rebuilds through it:

```bash
cd apps/ingest && wrangler kv key delete --binding KV --remote score:latest
```

**Step 3 — Set the new secrets.** Ingest gains `HEARTBEAT_URL` (Phase 2.3);
the curator needs its own set (see `docs/DEPLOYMENT.md` §8 for the full
walkthrough):

```bash
# Ingest: dead-man heartbeat (new). Optional but recommended.
wrangler secret put HEARTBEAT_URL --name tightrope-ingest

# Curator: fresh review token (do NOT reuse ingest's), the ingest admin token
# for the approve path, the shared alert webhook, and a SEPARATE heartbeat.
openssl rand -base64 32                                   # value for the next line
wrangler secret put ADMIN_TOKEN        --name tightrope-curator
wrangler secret put INGEST_ADMIN_TOKEN --name tightrope-curator   # = ingest's ADMIN_TOKEN
wrangler secret put ALERT_WEBHOOK_URL  --name tightrope-curator
wrangler secret put HEARTBEAT_URL      --name tightrope-curator
```

**Step 4 — Verify after each deploy.**

```bash
# Ingest health — every chip green, no failure/partial rows.
curl -H "x-admin-token: $ADMIN_TOKEN" https://ingest.tightropetracker.uk/admin/health

# API snapshot rebuilt from the single builder; sourceHealth present (not dark).
curl -s https://api.tightropetracker.uk/api/v1/score | jq '.headline.updatedAt, .sourceHealth'

# OG cards render (Phase 1.5): expect 200 + content-type image/png.
curl -sI https://og.tightropetracker.uk/og/headline-score.png | head -5

# Curator liveness + it is recording in shadow.
curl -s https://curator.tightropetracker.uk/__healthz
curl -H "x-admin-token: $ADMIN_TOKEN" "https://curator.tightropetracker.uk/admin/captures?status=shadow" | jq '.count'
```

**Step 5 — Two-cycle shadow comparison (curator stays `CURATOR_MODE=shadow`).**
For **two consecutive weekly cycles**, after each Tue/Wed sweep, compare each
source's `shadow` capture against the independently hand-verified fixture value
(procedure in `docs/RUNBOOK.md` §7.3). **Sign-off criteria for a source:**
across both cycles the shadow value matches the hand-verified figure (same
number, same `observed_at`), every gate passed, and the anchoring quote is
verbatim. A single mismatch resets the clock — fix the prompt/extraction first.
`obr_efo` and every editorial kind never sign off for auto-publish (they stay
review-only permanently).

**Step 6 — Flip to live, per source, in plan order.** Enable
`allowAutoPublish: true` for a signed-off spec in
`apps/curator/src/sources/registry.ts`, in this order as each signs off:
`sp_global_pmi` → `gfk_confidence` → `rics_rms` (the growth-sentiment trio),
then `ons_dd_failure`, then `mhclg_housing` (with its tight G4). Redeploy the
curator after each change. Once the **first** source is signed off, flip the
global switch in `apps/curator/wrangler.toml` `[vars]`:

```toml
CURATOR_MODE = "live"    # was "shadow"; auto-publish now gated only by the per-source flag
```

Auto-publish requires **both** `CURATOR_MODE = "live"` and the source's
`allowAutoPublish = true`, so live mode is safe to flip before every source is
enabled — un-flagged sources keep queuing to `pending`.

**Step 7 — Cloudflare dashboard items (cannot be expressed in code).**

- **Curator custom domain.** `curator.tightropetracker.uk` is declared
  `custom_domain = true` in `apps/curator/wrangler.toml`, so `wrangler deploy`
  provisions it — confirm it resolved in **dashboard → Workers → tightrope-curator
  → Domains & Routes**; add it there if the zone did not auto-create it.
- **Rate-limit `/admin/*` on the curator host**, mirroring the ingest WAF rule
  in `docs/RUNBOOK.md` §8 (SEC-2). Dashboard → `tightropetracker.uk` zone →
  Security → WAF → Rate-limiting rules → Create rule:

  | Field | Value |
  |---|---|
  | Rule name | `curator-admin-rate-limit` |
  | Match | `(http.host eq "curator.tightropetracker.uk" and http.request.uri.path matches "^/admin/")` |
  | Characteristics | IP source address |
  | Period | 1 minute |
  | Threshold | 30 requests |
  | Action | Block — duration 10 minutes |

  This layers on top of the curator's per-IP `adminBackoff` gate, exactly as
  the ingest rule layers on ingest's.

**Test matrix**
- Unit: verification gates G1–G6 (fixture artefacts with known values,
  including adversarial cases: value present but wrong period, quote
  paraphrased rather than verbatim, unit shift bps↔%); plausibility gate;
  cadence-state helper.
- Integration: curator pipeline against a stubbed `env.AI` (vitest,
  deterministic canned responses incl. malformed-JSON responses to prove
  the retry wrapper); D1 via miniflare.
- Contract: every adapter keeps its recorded-payload tests; weekly live
  probe in CI (2.4).
- E2E: `--env preview` (provision the preview resources per the comments in
  `apps/ingest/wrangler.toml:72-111`; replicate the pattern for curator) —
  full sweep against live upstreams, publish into preview D1, assert
  snapshot correctness.
- Regression: `pnpm -r typecheck && pnpm -r test`, seed-artifact guards,
  the `CRON_BRANCHES`-vs-wrangler assertion test (add the curator
  equivalent).

**Acceptance criteria (the definition of "self-maintaining")**

Checked `[x]` where the branch makes it **code-complete** (built + tested on
`automation-overhaul`); `[ ]` where it can only be confirmed by a
production/operational run after the rollout above.

- [ ] All Phase-0 exit criteria hold continuously for 14 days with zero
      manual fixture edits. *(operational — a 14-day production observation.)*
- [ ] A monthly source (PMI) publishes within 24h of upstream release with
      no human involvement; the digest shows it as auto-published with
      quote + link. *(operational — needs live mode + a real upstream release.)*
- [x] A deliberately-injected implausible value is quarantined, alerted, and
      never reaches `indicator_observations`. *(Gate + quarantine + alert
      code-complete and unit-tested — ingest plausibility gate and curator
      G3/G4; the preview injection run is the sign-off step.)*
- [x] The dead-man heartbeat fires from ingest recompute and the curator daily
      poll, and is silent when a run wedges. *(Ping code-complete + unit-tested
      in both workers; the external monitor config + preview cron-kill test are
      the operational sign-off.)*
- [x] `score:latest` has exactly one writer code path; `sourceHealth`-class
      fields cannot ship dark. *(Phase 1.1 consolidated the writer into
      `@tightrope/snapshot`; the one-time KV delete is Step 2 above.)*
- [x] The Tue/Wed 06:30 digest carries pillar deltas + the pending queue with
      ready-to-paste approve/reject curls (targeting `CURATOR_PUBLIC_URL`), so
      an editor can clear the queue in minutes. *(Digest + curls code-complete
      and unit-tested.)*
- [x] OG cards render 200/PNG. *(Phase 1.5 swapped to `workers-og`; verified
      under `wrangler dev`, which enforces the same wasm ban.)*
- [x] `SOURCES.md` and `RUNBOOK.md` §7 rewritten to describe the curator flow;
      corrections-log discipline documented for AI-published revisions.
      *(Wave 6d.)*

---

## Appendix A — Capture specs (parameters for `sources/registry.ts`)

Plausible ranges are publication gates, not forecasts — set wide.

| Spec id | Kind | Indicator(s) | Artefact | Discovery | Cadence | Range / maxΔ per release | Auto-publish |
|---|---|---|---|---|---|---|---|
| `sp_global_pmi` | observation | `services_pmi` | HTML (PDF fallback) press release, UK Services PMI **final** | S&P Global press-release index page; monthly, first full week | monthly | 35–70 / Δ≤8 | yes (after shadow) |
| `gfk_confidence` | observation | `consumer_confidence` | PDF/HTML press release, GfK/NIQ UK consumer confidence barometer | monthly, ~month-end | monthly | −55–10 / Δ≤10 | yes |
| `rics_rms` | observation | `rics_price_balance` | PDF, RICS UK Residential Market Survey | monthly, ~2nd Thursday | monthly | −80–80 / Δ≤25 | yes |
| `mhclg_housing` | observation | `housing_trajectory`, `planning_consents` | **HTML statistical release** (not ODS) | gov.uk housing-supply + planning live-tables release pages | quarterly | **component extraction** (SA completions; major+minor residential decisions granted) → shared formulas in `packages/shared/src/derivations.ts`; Δ≤30% | yes, tight G4 |
| `obr_efo` | observation | `cb_headroom`, `psnfl_trajectory` | PDF exec summary + key-figures page | obr.uk/efo — event-driven via daily hash poll | biannual+ | headroom −20–60 £bn | **no — always review** |
| `ons_dd_failure` | observation | `dd_failure_rate` | HTML article | upstream per `ons-rti.json` `_comment` | monthly | 0.3–3.0% / Δ≤0.4 | yes |
| `delivery_milestones` | delivery_milestone | 4 editorial indicators | gov.uk announcements (dept-filtered), departmental dashboards | reuse `govUkRss` filtering | event | n/a — drafts with citations | **never** |
| `delivery_commitments` | delivery_commitment | scorecard rows | same monitoring stream | event | n/a — drafts field patches | **never** |
| `timeline_triage` | timeline_event | — | gov.uk Atom candidates (Phase 1.4 reroute) | existing `govUkRss` candidates | daily | n/a — relevance+dedupe, drafts | **never** |

## Appendix B — New bindings & secrets

| Where | Name | Purpose |
|---|---|---|
| curator wrangler | `AI` (Workers AI binding) | extraction + verification |
| curator wrangler | `DB`, `KV`, `ARCHIVE` | same production ids as ingest (shared resources) |
| curator secret | `ADMIN_TOKEN` | review endpoints (generate fresh — do not reuse ingest's) |
| curator secret | `ALERT_WEBHOOK_URL` | same webhook as ingest |
| curator + ingest secret | `HEARTBEAT_URL` | dead-man switch (2.3) |
| curator secret | `INGEST_ADMIN_TOKEN` + var `INGEST_ADMIN_URL` | approve-path calls to `POST /admin/delivery-commitment` (1.3) |

Update `docs/DEPLOYMENT.md` provisioning walkthrough accordingly.
