# Tightrope Data Sources

This file enumerates every upstream the Tightrope ingest pipeline consumes,
how often we hit it, and which indicator(s) it feeds. Generated from
`packages/data-sources/src/adapters/*` and `apps/ingest/src/pipelines/*`
on 2026-04-27. Re-run the audit if you add or retire an adapter.

## Cron schedule (apps/ingest, `wrangler.toml`)

| Cron (UTC)     | Pipeline                          | Adapters fired in order |
|----------------|-----------------------------------|--------------------------|
| `*/5 * * * *`  | market + recompute + today        | boe_yields, boe_fx, boe_breakevens, eia_brent, growth_sentiment, lseg (FTSE 250). Throttled to UK market hours (07:00–16:30 Europe/London) — outside that window only the recompute and today-strip stages run. |
| `0 2 * * *`    | fiscal + recompute                | obr_efo, ons_psf, dmo, eodhd_housebuilders |
| `15 2 * * *`   | labour + recompute                | ons_lms, ons_rti, boe_mortgage_rates |
| `30 2 * * *`   | delivery + recompute              | mhclg, delivery_milestones, gov_uk (timeline candidates only) |

`recomputeScores` runs after every ingest stage; on cron-stage failure the
recompute still fires so last-known values are carried forward with the
`stale` flag.

DLQ: `tightrope-ingest-dlq` consumer is the final stop for adapter failures
(audit row written, message acked).

## Live network sources

| Source ID | Provider / endpoint | Indicator(s) | Pillar | Adapter | Cadence | Notes |
|-----------|---------------------|--------------|--------|---------|---------|-------|
| `boe_yields` | Bank of England IADB CSV — `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?SeriesCodes=IUDMNZC,IUDLNZC` | `gilt_10y` (IUDMNZC), `gilt_30y` (IUDLNZC) | market | `boeYields.ts` | T+1 trading day | Public, no key. Browser-ish UA required. |
| `boe_fx` | BoE IADB CSV — `SeriesCodes=XUDLUSS,XUDLBK67` | `gbp_usd`, `gbp_twi` | market | `boeFx.ts` | T+1 (4pm BoE spot fix) | Same endpoint family. |
| `boe_breakevens` | BoE IADB CSV — `SeriesCodes=IUDSNZC,IUDSIZC` | `breakeven_5y` (= nom 5y − real 5y) | market | `boeBreakevens.ts` | T+1 trading day | `sourceId` written under `boe_yields` historically; the audit row is `boe_breakevens`. |
| `dmo` | UK Debt Management Office — `https://www.dmo.gov.uk/data/XmlDataReport?reportCode=D1A` | `ilg_share`, `issuance_long_share` | fiscal | `dmoGiltPortfolio.ts` | Daily, late-evening UK | Public XML, no key. |
| `ons_psf` | ONS Public Sector Finances — beta search API resolves CDID → `https://www.ons.gov.uk/{uri}/data` | `borrowing_outturn` (CDID J5II), `debt_interest` (CDID NMFX) | fiscal | `onsPsf.ts` | Monthly | Resolved via `onsCommon.ts`. Sign-flipped on borrowing. |
| `ons_lms` | ONS Labour Market — beta search API + `/data` | `unemployment` (MGSX), `inactivity_rate` (LF2S), `inactivity_health` (LF69), `real_regular_pay` (A3WW), `vacancies_per_unemployed` (derived from AP2Y / MGSC) | labour | `onsLms.ts` | Monthly LMS bulletin | LF69 replaced retired LFK2 code. |
| `ons_rti` | ONS RTI — beta search API + `/data` for `payroll_mom` (CDID K54L); fixture for `dd_failure_rate` | `payroll_mom`, `dd_failure_rate` | labour | `onsRti.ts` | Monthly | `payroll_mom` is actually the AWE regular-pay index, not PAYE-RTI MoM (see comment in adapter). |
| `eodhd_housebuilders` | EODHD EOD — `https://eodhd.com/api/eod/{SYMBOL}.LSE` for PSN, BTRW, TW, BKG, VTY (rebased to 100 at 2019 mean) | `housebuilder_idx` | market | `eodhdHousebuilders.ts` | Daily EOD (16:30 UK) | Free-tier 20 req/day. Requires `EODHD_API_KEY` secret; falls back to `housebuilders.json` fixture if unset. Min 3-of-5 constituents required. |
| `gov_uk` | gov.uk Atom — `https://www.gov.uk/search/news-and-communications.atom` | (timeline event candidates only — no observations) | delivery | `govUkRss.ts` | Daily 02:30 UTC | Filters to DESNZ / DBT / MHCLG / HMT / Cabinet Office. Pushes candidates to DLQ for editorial review. |

## Hand-curated fixtures (no live network call)

These adapters read JSON fixtures bundled with the worker. The fixture is
the source of truth; the upstream URLs in the table below are reference
links that editorial uses to refresh the fixture.

| Source ID | Reference upstream | Indicator(s) | Pillar | Adapter | Editorial cadence | Freshness guard |
|-----------|--------------------|--------------|--------|---------|-------------------|-----------------|
| `obr_efo` | OBR Economic & Fiscal Outlook — `https://obr.uk/efo/` | `cb_headroom`, `psnfl_trajectory` | fiscal | `obrEfo.ts` + `fixtures/obr-efo.json` | Twice yearly + in-year updates | None — fixture validated at parse time only. |
| `eia_brent` | US EIA Open Data v2 — Europe Brent Spot (`EPCBRENT`), divided by BoE `XUDLUSS` 4pm fix | `brent_gbp` | market | `eiaBrent.ts` + `fixtures/brent.json` | Live every 5 min in market hours; fixture refreshed weekly as fallback | `assertFixtureFresh` 14 days on fallback. Live path falls through silently on empty EIA rows or BoE/EIA pairing skew > 7 days. Two-tier latest-observation selector (audit 2026-04-29) surfaces D1 backfill rows when the fixture-fallback observed_at is older. Requires `EIA_API_KEY` secret. |
| `lseg` (FTSE 250) | EODHD EOD — `https://eodhd.com/api/eod/FTMC.LSE` | `ftse_250` | market | `lseFtse250.ts` + `fixtures/ftse-250.json` | Live daily ~16:35 UK; fixture refreshed weekly as fallback | `assertFixtureFresh` 14 days on fallback. Two-tier latest-observation selector (audit 2026-04-29) surfaces D1 backfill rows when the fixture-fallback observed_at is older. Requires `EODHD_API_KEY` secret. |
| `lseg_housebuilders` | LSE — same five housebuilders | (none — superseded) | (none) | **adapter removed** (`housebuilders.json` kept as the `eodhd_housebuilders` fallback) | — | None. **Retired 2026-07**: `eodhd_housebuilders` runs in the fiscal pipeline instead. Historical audit rows remain in D1 (suppressed via `INACTIVE_INGEST_SOURCES`). |
| `moneyfacts` | Moneyfacts — `https://moneyfacts.co.uk` | (none — superseded by `boe_mortgage_rates` for `mortgage_2y_fix`) | (none) | **adapter + `mortgage.json` / `mortgage-history.json` removed** | — | None. **Retired 2026-07**: `boe_mortgage_rates` (BoE IADB IUMBV34) feeds `mortgage_2y_fix` from the labour pipeline. Historical audit rows remain in D1 (suppressed via `INACTIVE_INGEST_SOURCES`). |
| `mhclg` | MHCLG / DLUHC live tables — `https://www.gov.uk/government/statistical-data-sets/live-tables-on-house-building` & planning live tables | `housing_trajectory`, `planning_consents` | delivery | `mhclgHousing.ts` + `fixtures/housing.json` (live), `fixtures/housing-history.json` (back-series) | Quarterly | None on live; back-series uses `historicalPayloadHash`. |
| `delivery_milestones` | gov.uk press releases / departmental dashboards | `new_towns_milestones`, `bics_rollout`, `industrial_strategy`, `smr_programme` | delivery | `deliveryMilestones.ts` + `fixtures/delivery-milestones.json` | Quarterly | `assertFixtureFresh` 90 days. Each indicator carries its own `sourceId` (`gov_uk`, `desnz`, `dbt`). |
| `sp_global_pmi` / `gfk_confidence` / `rics_rms` | S&P Global / GfK-NIESR / RICS press releases | `services_pmi`, `consumer_confidence`, `rics_price_balance` | market | `growthSentiment.ts` + `fixtures/growth-sentiment.json` | Monthly | None. |

## D1-cached lookups (not adapters)

| Source | Endpoint | Cached in | TTL |
|--------|----------|-----------|-----|
| Parliament Members API | `https://members-api.parliament.uk/api/Location/Constituency/Search` + `/Members/{id}/Contact` | D1 `mp_lookup_cache` keyed on postcode outward | 7 days |

## What ships in fixtures (and why this matters)

The fixture-backed adapters above (every "fixture" row) emit observations
whose `observed_at` comes verbatim from the JSON. The latest-observation
selector in `apps/api/src/lib/db.ts`, `apps/web/src/lib/db.ts`, and
`apps/ingest/src/lib/history.ts::readLatestLiveObservations` is two-tier
(audit 2026-04-29):

  - **Tier 1 (live)** picks `MAX(ingested_at)` over non-`hist:%` non-`seed%`
    rows. This protects against fixture supersedes — when a fixture's
    `observed_at` moves backwards (e.g. an editorial swap from a 2025 EFO
    snapshot to the 2026 one with an earlier publication date), the
    new write wins despite the older `observed_at`.
  - **Tier 2 (hist)** picks `MAX(observed_at)` over `hist:%` rows.
    Surfaces backfill data when a live adapter is silently falling
    through to a stale-dated fixture.

The outer ranking is `observed_at DESC`, live-before-hist on ties,
`ingested_at DESC` as final tiebreaker. So fresher backfill wins over
stale fixture-fallback writes, but a real live row at the same
`observed_at` always beats its backfill counterpart.

## Secrets / vars referenced

| Name | Where set | Purpose |
|------|-----------|---------|
| `ADMIN_TOKEN` | `wrangler secret put` (ingest worker) | Guards `POST /admin/run` |
| `EODHD_API_KEY` | `wrangler secret put` (ingest worker) | Daily housebuilder EOD + FTSE 250 close; absence triggers fixture fallback |
| `EIA_API_KEY` | `wrangler secret put` (ingest worker) | EIA Open Data v2 Brent spot; absence triggers fixture fallback |
| `PARLIAMENT_API_BASE` | `[vars]` in `apps/api/wrangler.toml` | SSRF-pinned to `members-api.parliament.uk` |
| `ALERT_WEBHOOK_URL` | optional | Source-health alerts on recompute (no-op if unset) |
