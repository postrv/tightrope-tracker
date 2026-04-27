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
| `15 2 * * *`   | labour + recompute                | ons_lms, ons_rti, moneyfacts |
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
| `eia_brent` | US EIA Europe Brent Spot — `https://www.eia.gov/dnav/pet/hist/rbrted.htm` | `brent_gbp` (USD/bbl × XUDLUSS) | market | `eiaBrent.ts` + `fixtures/brent.json` | Weekly | **None**. Stale fixture silently emits old value (see audit findings). |
| `lseg` (FTSE 250) | London Stock Exchange — `https://www.londonstockexchange.com/indices/ftse-250` | `ftse_250` | market | `lseFtse250.ts` + `fixtures/ftse-250.json` | Weekly | `assertFixtureFresh` 14 days. |
| `ice_gas` | ICE Endex UK Natural Gas Futures — `https://www.theice.com/products/910/UK-Natural-Gas-Futures` | `gas_m1` | (registered, **not currently wired into any pipeline**) | `iceGasM1.ts` + `fixtures/gas-m1.json` | Weekly | `assertFixtureFresh` 14 days. |
| `boe_sonia` | BoE IADB — `IUDSOIA` | (registered, **not currently wired**) | (none) | `boeSonia.ts` | n/a | 252-day rolling-mean proxy; superseded by direct gilt yields. |
| `lseg_housebuilders` | LSE — same five housebuilders | `housebuilder_idx` (override) | market | `lseHousebuilders.ts` + `fixtures/housebuilders.json` | Weekly | None. **Retired**: `eodhd_housebuilders` runs in fiscal pipeline instead. Audit row sticks around. |
| `twelve_data_housebuilders` | `https://api.twelvedata.com/quote` | `housebuilder_idx` (override) | market | `twelveDataHousebuilders.ts` | n/a | **Retired** — Twelve Data free tier dropped LSE equities; replaced by EODHD. |
| `moneyfacts` | Moneyfacts — `https://moneyfacts.co.uk` | `mortgage_2y_fix` | labour | `moneyfactsMortgage.ts` + `fixtures/mortgage.json` | Monthly | None. |
| `mhclg` | MHCLG / DLUHC live tables — `https://www.gov.uk/government/statistical-data-sets/live-tables-on-house-building` & planning live tables | `housing_trajectory`, `planning_consents` | delivery | `mhclgHousing.ts` + `fixtures/housing.json` (live), `fixtures/housing-history.json` (back-series) | Quarterly | None on live; back-series uses `historicalPayloadHash`. |
| `delivery_milestones` | gov.uk press releases / departmental dashboards | `new_towns_milestones`, `bics_rollout`, `industrial_strategy`, `smr_programme` | delivery | `deliveryMilestones.ts` + `fixtures/delivery-milestones.json` | Quarterly | `assertFixtureFresh` 90 days. Each indicator carries its own `sourceId` (`gov_uk`, `desnz`, `dbt`). |
| `sp_global_pmi` / `gfk_confidence` / `rics_rms` | S&P Global / GfK-NIESR / RICS press releases | `services_pmi`, `consumer_confidence`, `rics_price_balance` | market | `growthSentiment.ts` + `fixtures/growth-sentiment.json` | Monthly | None. |

## D1-cached lookups (not adapters)

| Source | Endpoint | Cached in | TTL |
|--------|----------|-----------|-----|
| Parliament Members API | `https://members-api.parliament.uk/api/Location/Constituency/Search` + `/Members/{id}/Contact` | D1 `mp_lookup_cache` keyed on postcode outward | 7 days |

## What ships in fixtures (and why this matters)

The fixture-backed adapters above (every "fixture" row) emit observations
whose `observed_at` comes verbatim from the JSON. If a fixture's
`observed_at` ever moves backwards (e.g. an editorial swap from a 2025
EFO snapshot to the 2026 one with an earlier publication date), the
adapter writes new rows but the API's `MAX(observed_at)` selector keeps
returning the older row. See `AUDIT_FINDINGS.md` for two live instances
of this happening (cb_headroom, housing_trajectory) and the recommended fix.

## Secrets / vars referenced

| Name | Where set | Purpose |
|------|-----------|---------|
| `ADMIN_TOKEN` | `wrangler secret put` (ingest worker) | Guards `POST /admin/run` |
| `EODHD_API_KEY` | `wrangler secret put` (ingest worker) | Daily housebuilder EOD; absence triggers fixture fallback |
| `TWELVE_DATA_KEY` | (deprecated) | Old housebuilder vendor; free tier dropped LSE |
| `PARLIAMENT_API_BASE` | `[vars]` in `apps/api/wrangler.toml` | SSRF-pinned to `members-api.parliament.uk` |
| `ALERT_WEBHOOK_URL` | optional | Source-health alerts on recompute (no-op if unset) |
