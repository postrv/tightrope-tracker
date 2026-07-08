# Tightrope Data Sources

This file enumerates every upstream the Tightrope pipelines consume, how often
we hit it, and which indicator(s) it feeds. Maintained by hand from
`packages/data-sources/src/adapters/*`, `apps/ingest/src/pipelines/*`, and
`apps/curator/src/sources/registry.ts`. Last regenerated on **2026-07-07**
(curator follow-link discovery + artefact relay; `rics_rms` disabled). Re-run
the audit if you add or retire an adapter or a capture spec.

Two workers feed the dataset:

- **`apps/ingest`** — deterministic, no AI. Runs the API-backed adapters on a
  fixed cron and recomputes the score. The single source of truth for market /
  fiscal / labour series.
- **`apps/curator`** — AI capture → verify → publish for the non-API sources
  that were previously hand-refreshed fixtures. Every candidate passes
  deterministic gates or human review before it reaches
  `indicator_observations`. Ships in **shadow mode** (`CURATOR_MODE = "shadow"`)
  — it verifies and records but publishes nothing until a source is signed off
  per the Phase 5 rollout.

## Cron schedule — `apps/ingest` (`wrangler.toml`)

| Cron (UTC)     | Pipeline                          | Adapters fired in order |
|----------------|-----------------------------------|--------------------------|
| `*/5 * * * *`  | market + recompute + today        | eia_brent, growth_sentiment, lseg (FTSE 250). BoE adapters removed from this cron 2026-07-07 — they run via the Actions relay row below. Throttled to UK market hours (07:00–16:30 Europe/London) — outside that window only the recompute and today-strip stages run. |
| `0 2 * * *`    | fiscal + recompute                | obr_efo, ons_psf, dmo, eodhd_housebuilders |
| `15 2 * * *`   | labour + recompute                | ons_lms, ons_rti (boe_mortgage_rates moved to the Actions relay row below, 2026-07-07) |
| `30 2 * * *`   | delivery + recompute              | mhclg, delivery_milestones, gov_uk (timeline candidates → `curator_captures`) |
| `30 9 * * 1-5` **(GitHub Actions, not a Worker cron)** | BoE IADB relay → `POST /admin/relay` | boe_yields, boe_fx, boe_breakevens, boe_mortgage_rates. A runner fetches each IADB CSV and replays it through the ingest relay endpoint, which runs the standard adapter machinery. See `.github/workflows/relay-boe.yml` + `scripts/relay-boe.mjs`. |

The last row is **not** a Cloudflare cron: since 2026-06-10 the BoE IADB CSV
endpoint returns HTTP 500 to Cloudflare Workers egress IPs (an ASN block —
identical requests succeed from GitHub Actions runners), so the four BoE
adapters' *network leg only* runs on GitHub Actions and POSTs the raw payloads
to `POST /admin/relay?adapter=<id>` (token-gated, allowlisted to those four
adapter ids). Everything downstream of the fetch — parse, plausibility gate,
audit, DLQ — is identical to a live run.

`recomputeScores` runs after every ingest stage; on cron-stage failure the
recompute still fires so last-known values are carried forward with the
`stale` flag. Recompute writes the KV snapshot via the single builder in
`@tightrope/snapshot` (`primeSnapshotCache`) and pings `HEARTBEAT_URL` on a
fully-successful run.

DLQ: `tightrope-ingest-dlq` consumer is the final stop for adapter failures
(audit row written, message acked). Timeline candidates are **no longer** sent
to the DLQ — they stage into `curator_captures` for review (see below).

## Cron schedule — `apps/curator` (`wrangler.toml`)

All curator schedules are ≥1h apart, so scheduled invocations get the long CPU
allowance on the paid plan. Scheduling copy is neutral — the sweep windows are
timed for the **weekly editorial deadline**.

| Cron (UTC)      | Job | What it does |
|-----------------|-----|--------------|
| `0 5 * * 2`     | pre-deadline sweep (Tue) | Force-capture every spec (ignore the hash short-circuit) + full verify, so results are ready at the start of the editorial day. |
| `0 5 * * 3`     | pre-deadline sweep (Wed) | Same, second day of the deadline window. |
| `30 6 * * 2`    | editorial readiness digest (Tue) | Posts pillar deltas, amber/red cadence, pending queue (with ready-to-paste approve/reject curls against `CURATOR_PUBLIC_URL`), releases expected in 7 days, and auto-published-since-last-digest to `ALERT_WEBHOOK_URL`. |
| `30 6 * * 3`    | editorial readiness digest (Wed) | Same. |
| `0 6 * * *`     | daily change-detection poll | Fetch + hash-compare each source; extract only on change; fire `HEARTBEAT_URL` on success. The "self-maintaining" loop. **Skips `fetchVia:"relay"` specs** (`obr_efo`, `ons_dd_failure`) — they are fed by the Actions relay row below. |
| `0 7 * * *`     | staleness monitor | Cadence-state evaluation across all indicators; alerts on amber→red transitions and `cron_miss` rows. |
| `0 4 * * 2,3` + `15 6 * * *` **(GitHub Actions, not a Worker cron)** | curator artefact relay → `POST /admin/relay-artefact` | For runner-reachable `fetchVia:"relay"` specs (`ons_dd_failure` — xlsx-only). A runner fetches + discovers each artefact (shared `fetchArtefactParts`) and POSTs the bytes; the curator runs the same capture→extract→verify→persist pipeline. `obr_efo` is `relayRunner:"manual"` — obr.uk's Cloudflare bot management also 403s runner IPs, so its leg runs from an operator machine on publication day. See `.github/workflows/relay-artefacts.yml` + `scripts/relay-artefacts.mjs`; RUNBOOK §7.8. |

## Live network sources (`apps/ingest`, API-backed adapters)

| Source ID | Provider / endpoint | Indicator(s) | Pillar | Adapter | Cadence | Notes |
|-----------|---------------------|--------------|--------|---------|---------|-------|
| `boe_yields` | Bank of England IADB CSV — `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?SeriesCodes=IUDMNZC,IUDLNZC` | `gilt_10y` (IUDMNZC), `gilt_30y` (IUDLNZC) | market | `boeYields.ts` | T+1 trading day | Public, no key. Browser-ish UA required. **Network leg via the Actions relay since 2026-07** (Workers egress blocked upstream 2026-06-10). |
| `boe_fx` | BoE IADB CSV — `SeriesCodes=XUDLUSS,XUDLBK67` | `gbp_usd`, `gbp_twi` | market | `boeFx.ts` | T+1 (4pm BoE spot fix) | Same endpoint family. **Network leg via the Actions relay since 2026-07** (Workers egress blocked upstream 2026-06-10). |
| `boe_breakevens` | BoE IADB CSV — `SeriesCodes=IUDSNZC,IUDSIZC` | `breakeven_5y` (= nom 5y − real 5y) | market | `boeBreakevens.ts` | T+1 trading day | `sourceId` written under `boe_yields` historically; the audit row is `boe_breakevens`. **Network leg via the Actions relay since 2026-07** (Workers egress blocked upstream 2026-06-10). |
| `dmo` | UK Debt Management Office — `https://www.dmo.gov.uk/data/XmlDataReport?reportCode=D1A` | `ilg_share`, `issuance_long_share` | fiscal | `dmoGiltPortfolio.ts` | Daily, late-evening UK | Public XML, no key. |
| `ons_psf` | ONS Public Sector Finances — beta search API resolves CDID → `https://www.ons.gov.uk/{uri}/data` | `borrowing_outturn` (CDID J5II), `debt_interest` (CDID NMFX) | fiscal | `onsPsf.ts` | Monthly | Resolved via `onsCommon.ts`. Sign-flipped on borrowing. |
| `ons_lms` | ONS Labour Market — beta search API + `/data` | `unemployment` (MGSX), `inactivity_rate` (LF2S), `inactivity_health` (LF69), `real_regular_pay` (A3WW), `vacancies_per_unemployed` (derived from AP2Y / MGSC) | labour | `onsLms.ts` | Monthly LMS bulletin | LF69 replaced retired LFK2 code. |
| `ons_rti` | ONS RTI — beta search API + `/data` for `payroll_mom` (CDID K54L); fixture for `dd_failure_rate` | `payroll_mom`, `dd_failure_rate` | labour | `onsRti.ts` | Monthly | `payroll_mom` is actually the AWE regular-pay index, not PAYE-RTI MoM (see comment in adapter). `dd_failure_rate` is a curator-owned source (`ons_dd_failure`). |
| `boe_mortgage_rates` | BoE IADB CSV — `SeriesCodes=IUMBV34` (effective new-business 2y fix) | `mortgage_2y_fix` | labour | `boeMortgageRates.ts` | Monthly | **Replaced `moneyfacts`** (advertised rate, fixture-fed). BoE is the canonical reference. **Network leg via the Actions relay since 2026-07** (Workers egress blocked upstream 2026-06-10). |
| `eia_brent` | US EIA Open Data v2 — Europe Brent Spot (`EPCBRENT`), divided by BoE `XUDLUSS` 4pm fix | `brent_gbp` | market | `eiaBrent.ts` + `fixtures/brent.json` | Live every 5 min in market hours; fixture is a fallback | Requires `EIA_API_KEY`. `assertFixtureFresh` 14 days on fallback. |
| `lseg` (FTSE 250) | EODHD EOD — `https://eodhd.com/api/eod/FTMC.LSE` | `ftse_250` | market | `lseFtse250.ts` + `fixtures/ftse-250.json` | Live daily ~16:35 UK; fixture is a fallback | Requires `EODHD_API_KEY`. `assertFixtureFresh` 14 days on fallback. |
| `eodhd_housebuilders` | EODHD EOD — `https://eodhd.com/api/eod/{SYMBOL}.LSE` for PSN, BTRW, TW, BKG, VTY (rebased to 100 at 2019 mean) | `housebuilder_idx` | fiscal | `eodhdHousebuilders.ts` + `fixtures/housebuilders.json` | Daily EOD (16:30 UK) | Free-tier 20 req/day. Requires `EODHD_API_KEY`; falls back to fixture if unset. Min 3-of-5 constituents required. |
| `gov_uk` | gov.uk Atom — `https://www.gov.uk/search/news-and-communications.atom` | (timeline event candidates only — no observations) | delivery | `govUkRss.ts` → `stageTimelineCandidates` | Daily 02:30 UTC | Filters to DESNZ / DBT / MHCLG / HMT / Cabinet Office. Candidates stage into `curator_captures` (`kind='timeline_event'`, `status='pending'`) for the curator's timeline-triage pass. |

## Retired adapters (2026-07)

Deleted in the Phase 1.2 retirement. Historical audit rows remain in D1;
`INACTIVE_INGEST_SOURCES` (`packages/shared/src/sourceHealth.ts`) suppresses
them so they never show a permanently-grey health chip.

| Retired source | Superseded by | Notes |
|----------------|---------------|-------|
| `lseg_housebuilders` | `eodhd_housebuilders` | Adapter removed; `housebuilders.json` kept as the `eodhd_housebuilders` fixture fallback. |
| `moneyfacts` | `boe_mortgage_rates` | Adapter + `mortgage.json` / `mortgage-history.json` removed. Deprecated `TWELVE_DATA_KEY` plumbing dropped from `env.ts` / `runAdapter.ts`. |

## Hand-curated fixtures (dev / fallback tier)

Since curator go-live these JSON fixtures are the **dev/seed fallback**, not
the primary freshness path. A fresh deployment seeds from them, and an adapter
falls back to them if its live path is unavailable; the curator keeps the live
values fresh (see the capture-spec table below). The two-tier selector
guarantees a fresher `ai:%` row always wins over a stale fixture-fallback write.

| Source ID | Reference upstream | Indicator(s) | Adapter + fixture | Curator spec (owns freshness) | Freshness guard |
|-----------|--------------------|--------------|-------------------|-------------------------------|-----------------|
| `obr_efo` | OBR EFO — `https://obr.uk/efo/` | `cb_headroom`, `psnfl_trajectory` | `obrEfo.ts` + `obr-efo.json` | `obr_efo` | Validated at parse time only. |
| `mhclg` | MHCLG live tables — house building + planning | `housing_trajectory`, `planning_consents` | `mhclgHousing.ts` + `housing.json` (live), `housing-history.json` (back-series) | `mhclg_housing` | None on live; back-series uses `historicalPayloadHash`. |
| `delivery_milestones` | gov.uk press releases / departmental dashboards | `new_towns_milestones`, `bics_rollout`, `industrial_strategy`, `smr_programme` | `deliveryMilestones.ts` + `delivery-milestones.json` | `delivery_milestones` (drafts only) | `assertFixtureFresh` 90 days. |
| `growth_sentiment` | S&P Global / GfK-NIQ / RICS press releases | `services_pmi`, `consumer_confidence`, `rics_price_balance` | `growthSentiment.ts` + `growth-sentiment.json` | `sp_global_pmi`, `gfk_confidence`, `rics_rms` | `assertFixtureFresh` 40 days. |
| `ons_rti` (`dd_failure_rate` half) | ONS monthly DD failure-rate dataset | `dd_failure_rate` | `onsRti.ts` + `ons-rti.json` | `ons_dd_failure` | Indicator `maxStale` 60 days. |

## Curator capture specs (`apps/curator/src/sources/registry.ts`)

Each spec is one AI-curated source. The extractor must return the verbatim
sentence anchoring every value; the verifier re-locates that quote in the
captured artefact (gate G1). A value without a locatable quote is
unpublishable. Gates G1–G6: quote-anchor, schema+unit, plausible range (shared
`plausibility.ts`), max-delta vs latest published, independent second
extraction agrees, period sanity.

`allowAutoPublish` is **off for every spec today** — they flip on per source
during the Phase 5 shadow rollout. The "auto-publish eligibility" column is the
*plan intent* (Appendix A), reached only after two clean shadow cycles.

| Spec id | Kind | Indicator(s) | Artefact / discovery | Cadence | Auto-publish eligibility (plan) | Current flag / status |
|---------|------|--------------|----------------------|---------|---------------------------------|-----------------------|
| `sp_global_pmi` | observation | `services_pmi` | HTML mirror (Trading Economics) of the S&P Global UK Services PMI **final** — the canonical S&P index/press pages return 403 to a server-side fetch, so the mirror is cited as a mirror, never the primary. Headline number is on the landing page; capture-stage truncation (lib/artefactText.ts) is the 5024 fix | monthly | yes (after shadow) | off · shadow |
| `gfk_confidence` | observation | `consumer_confidence` | HTML, NIQ (formerly GfK) consumer-confidence barometer landing → **follow-link** to newest `/news-center/YYYY/consumer-confidence-*` article (implemented) | monthly | yes | off · shadow |
| `mhclg_housing` | observation | `housing_trajectory`, `planning_consents` | HTML gov.uk collection → **two-hop follow-link**: newest quarterly release page → the full HTML statistical-release doc (**not** the ODS attachments), where the figures are inlined; formulas per `housing-history.json` | quarterly | yes, tight G4 (Δ≤30%) | off · shadow |
| `obr_efo` | observation | `cb_headroom`, `psnfl_trajectory` | PDF exec summary, discovered from `obr.uk/efo` → newest EFO download. **`fetchVia:"relay"`, `relayRunner:"manual"`** — obr.uk's Cloudflare bot management 403s Workers egress AND GitHub/Azure runner IPs (verified 2026-07-08); relayed from an operator machine on EFO publication day (`relay-artefacts.mjs --spec=obr_efo`), ingested via `POST /admin/relay-artefact` | event | **no — always human review** | off · shadow · relay (manual) |
| `ons_dd_failure` | observation | `dd_failure_rate` | XLSX, newest dataset workbook discovered from the ONS DD-failure-rate dataset page (the figure is xlsx-only — no HTML/API states it). **`fetchVia:"relay"`**; the Worker converts the xlsx to markdown via `AI.toMarkdown` | monthly | yes | off · shadow · relay |
| `delivery_milestones` | delivery_milestone | `new_towns_milestones`, `bics_rollout`, `industrial_strategy`, `smr_programme` | gov.uk announcements Atom, dept-filtered (`govUkRss` DELIVERY_DEPARTMENTS) | event | **never** — editorial | off · shadow |
| `delivery_commitments` | delivery_commitment | scorecard rows (no scored indicator) | same monitoring stream; approval POSTs the field patch to ingest `POST /admin/delivery-commitment` | event | **never** — editorial | off · shadow |
| `timeline_triage` | timeline_event | — | gov.uk Atom candidates staged by ingest (§1.4); no fetch, an AI relevance/dedupe pass | event | **never** — editorial | off · shadow |

**Disabled capture specs.** `rics_rms` (`rics_price_balance`) was **removed from
the sweep set on 2026-07-07**. The rics.org site is behind Imperva/Incapsula bot
protection: the survey page returns only a ~200–840-byte JS challenge stub (no
article text) to a server-side fetch, verified from residential egress and with
a full browser UA + Accept headers. A GitHub Actions runner (datacenter ASN)
would be challenged at least as hard, so `fetchVia:"relay"` cannot reach it
either. `rics_price_balance` therefore stays on the **hand-refresh fixture path**
(`growth-sentiment.json`; RUNBOOK §7.5). Re-enable the spec if RICS drops the
challenge or ships a plain-fetch release mirror.

## `curator_captures` — staging / review / audit (migration 0011)

One review surface for everything that needs a human decision. Rows are written
by three producers and drained by the curator admin endpoints:

- **Producers.** The curator sweep (AI candidates), the ingest plausibility
  gate (a `writeObservations` violation quarantines instead of writing —
  `status='quarantined'`), and the ingest gov.uk stage
  (`kind='timeline_event'`, `status='pending'`).
- **Status lifecycle.** `shadow` (verified, never publishable while
  `CURATOR_MODE≠live`) · `pending` (awaiting review) · `auto_published` (passed
  all gates, published without review) · `approved` / `rejected` (human) ·
  `superseded` (a newer capture of the same reading replaced it) · `quarantined`
  (plausibility breach) · `unchanged` (artefact hash matched the last capture;
  no extraction ran).
- **Provenance on every row.** source URL, retrieval time, artefact sha256 (raw
  bytes archived to R2 under `curator/{sourceId}/{date}-{sha8}.{ext}`), model
  id, prompt version, gate-by-gate verification JSON, and — once published —
  `published_observation_key` (`indicator_id|observed_at`).
- **Publish path.** An observation is written `INSERT OR REPLACE` with
  `payload_hash = "ai:" + sha256` (so it passes the live tier of the two-tier
  selector) and is picked up by the next 5-min recompute. Revising an
  already-published value appends a public `corrections` row.

Review queue (curator worker, `ADMIN_TOKEN`-gated, at `CURATOR_PUBLIC_URL`):

```
GET  /admin/captures?status=pending      list (id, source, kind, value, confidence, age)
GET  /admin/captures/:id                 detail: quote, gates, diff vs published
POST /admin/captures/:id/approve         → publish path
POST /admin/captures/:id/reject {reason} → status 'rejected', reason recorded
GET  /__healthz                          unauthenticated liveness
```

## What ships in fixtures / the two-tier latest-observation selector

The single two-tier selector now lives in `@tightrope/snapshot`
(`readLatestObservations`), consumed by ingest recompute, the api score
handler, and the web db layer — no more three-copy drift (audit 2026-04-29,
consolidated in Phase 1.1):

- **Tier 1 (live)** picks `MAX(ingested_at)` over non-`hist:%` non-`seed%` rows.
  Protects against fixture supersedes and lets a fresh `ai:%` curator row win
  over a stale fixture-fallback write.
- **Tier 2 (hist)** picks `MAX(observed_at)` over `hist:%` rows. Surfaces
  backfill data when a live adapter is silently falling through to a
  stale-dated fixture.

Outer ranking: `observed_at DESC`, live-before-hist on ties, `ingested_at DESC`
as final tiebreaker.

## D1-cached lookups (not adapters)

| Source | Endpoint | Cached in | TTL |
|--------|----------|-----------|-----|
| Parliament Members API | `https://members-api.parliament.uk/api/Location/Constituency/Search` + `/Members/{id}/Contact` | D1 `mp_lookup_cache` keyed on postcode outward | 7 days |

## Secrets / vars referenced

| Name | Kind | Where set | Purpose |
|------|------|-----------|---------|
| `ADMIN_TOKEN` | secret | ingest worker | Guards `POST /admin/run` and `POST /admin/delivery-commitment` |
| `ADMIN_TOKEN` | secret | curator worker | Guards `/admin/captures` review endpoints — **generate fresh, do not reuse ingest's** |
| `INGEST_ADMIN_TOKEN` | secret | curator worker | Ingest's admin token, used only by the approve path to `POST /admin/delivery-commitment` |
| `EODHD_API_KEY` | secret | ingest worker | FTSE 250 + housebuilder EOD closes; absence triggers fixture fallback |
| `EIA_API_KEY` | secret | ingest worker | EIA Open Data v2 Brent spot; absence triggers fixture fallback |
| `ALERT_WEBHOOK_URL` | secret (optional) | ingest + curator | Slack-shaped webhook: source-health, plausibility quarantine, cron-miss, editorial digest. No-op if unset. |
| `HEARTBEAT_URL` | secret (optional) | ingest + curator | Dead-man switch — GET on a fully-successful recompute (ingest) and daily poll (curator). Unset = no heartbeat. |
| `PARLIAMENT_API_BASE` | var | `apps/api/wrangler.toml` | SSRF-pinned to `members-api.parliament.uk` |
| `CURATOR_MODE` | var | curator worker | `"shadow"` (default) verifies but never publishes; `"live"` enables auto-publish per the `allowAutoPublish` flags |
| `CURATOR_PUBLIC_URL` | var | curator worker | Public base URL of the review surface; digest/quarantine curls target it |
| `INGEST_ADMIN_URL` | var | curator worker | Base URL of the ingest admin surface for the approve path |
