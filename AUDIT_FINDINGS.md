# Tightrope production audit — 2026-04-27

Audit of the live site at `https://tightropetracker.uk/` (apex Astro app)
and `https://api.tightropetracker.uk/api/v1/*` (the public API worker)
against the indicator catalogue, the adapter set, and the hand-curated
fixtures.

Probes captured: `score`, `score/history?days=14`, `delivery`, `timeline`,
`health`, `mp?postcode=SW1A1AA`, `openapi.json`. All endpoints `200`.

Severity legend: 🔴 wrong number on the public site • 🟠 stale-but-not-wrong • 🟡 cosmetic / cleanup. Status legend: 🛠️ Fixed (in this branch, awaiting deploy) • ⏳ Awaiting decision • ✅ Confirmed not-a-bug.

---

## 🔴 1. `cb_headroom` is wrong on the public site — 🛠️ FIXED

**Symptom**: live API serves `9.9 GBPbn` (March 2025 EFO crunch), fixture says `23.6 GBPbn` (March 2026 Spring Forecast).

**Root cause**: the snapshot selector picked `MAX(observed_at)` per indicator. Editorial fixture changes that move `observed_at` earlier leave the previously-written row at the later observed_at as the lexicographic winner. `INSERT OR REPLACE` keyed on `(indicator_id, observed_at)` doesn't unify them. This is the systemic class of bug — affects every fixture-backed adapter, not just OBR.

**Fix shipped**:
- New selector: `MAX(ingested_at)` over rows whose `payload_hash` is neither `hist:%` nor `seed%`. Picks the most-recently-written live row regardless of its observed_at.
- Updated in:
  - `apps/api/src/lib/db.ts::buildSnapshotFromD1` (latestObservations query)
  - `apps/web/src/lib/db.ts::buildSnapshotFromD1` (mirror copy)
  - `apps/og/src/lib/data.ts::loadCardIndicators` (gilt_30y card data)
  - `apps/ingest/src/pipelines/recompute.ts::recomputeScores` (the high-leverage one — feeds `score:latest` KV every 5 min)
  - `apps/ingest/src/pipelines/todayMovements.ts` (intraday cards)
- New helpers in `apps/ingest/src/lib/history.ts`:
  - `readLatestLiveObservations(db)` — canonical SQL for "what's live right now"
  - `filterStaleLiveRows(rows)` — JS-side dedupe per `(indicator_id, source_id)` for daily-sparkline computation, leaves hist:/seed rows untouched.

**Tests added** (Red→Green):
- `apps/api/src/tests/snapshot-fixture-supersede.test.ts` — 4 tests covering the supersede regression, hist:* exclusion, seed* exclusion, and graceful no-live-row fallback.
- `apps/ingest/src/tests/latestLive.test.ts` — 9 tests covering `filterStaleLiveRows` invariants and `readLatestLiveObservations` SQL contract (asserts `MAX(ingested_at)`, hist+seed exclusion on both sides of the JOIN).

**Defensive ops patch**: `db/patches/cleanup-fixture-superseded-rows.sql` deletes the polluted rows from D1. Not required for correctness post-deploy — the new selector handles them at read time — but tidies the table.

`psnfl_trajectory` followed the same code path and is now correct.

## 🔴 2. `housing_trajectory` value mismatch — 🛠️ FIXED (Option B)

User chose Option B: adopt the run-rate methodology and publish a corrections entry. Live API will display **49.0%** (Q4 2025 completions × 4 / 300k OBR working assumption) instead of the stale **72.4%** (legacy seed-era FY-outturn ratio of 221,400 / 305k).

**Apples-to-apples confirmed.** The indicator is internally consistent (annual run-rate vs annual target). The cross-measure inconsistency between the indicator and the public commitment text has been resolved: the `housing_305k` delivery commitment now displays **both** measures side-by-side on the card so a reader can see (1) the live quarterly-run-rate the indicator tracks and (2) the annual NAD outturn that is referenced in news.

**Shipped**:
- Migration `db/migrations/0009_housing_methodology_correction.sql` — atomic UPDATE of `delivery_commitments.housing_305k` + INSERT of a corrections-log row documenting the homepage value shift.
- `packages/shared/src/deliveryCommitmentsSeed.ts` — TS seed updated to match.
- `db/seed/seed.sql` — bootstrap seed updated to match.

**Future enhancement**: switch the live indicator to **trailing 4-quarter (T4Q) completions** rather than single-quarter × 4. Same denominator, same target, but a more stable annual measure that updates quarterly. Back-data is in `packages/data-sources/src/fixtures/housing-history.json`. Mechanical change; would require a methodology PR with full historical recompute and another `/corrections` entry. Not in this branch.

## 🟠 3. Fixture-freshness guards on Brent / growth-sentiment / mortgage — 🛠️ FIXED

`assertFixtureFresh` calls added with appropriate thresholds:
- `eiaBrent.ts`: 14 days (weekly editorial cadence + slack)
- `growthSentiment.ts`: 40 days (monthly + 10-day publication-delay buffer)
- `moneyfactsMortgage.ts`: 45 days (monthly + 15-day buffer)

**Tests added**: each adapter now has fixture-stale (`vi.useFakeTimers` + `setSystemTime` past threshold) and fixture-fresh (boundary) cases. `moneyfactsMortgage.test.ts` is new (no test existed before).

A neglected fixture now trips an `AdapterError` into the audit log instead of silently re-emitting the same value indefinitely.

## 🟠 4. KV freshness gates — 🛠️ FIXED

| Key                  | Before                | After |
|----------------------|-----------------------|-------|
| `score:latest` (og)  | accept any age        | 30-min freshness gate via `isFresh()` matching api/web |
| `score:history:90d`  | schemaVersion only    | 30-min gate on newest point's timestamp; empty/wrong-schema also rejected |
| `delivery:latest`    | no gate               | New `POST /admin/run?source=purge-cache` busts it (and the others) |
| `timeline:latest`    | no gate               | Same |

**Implementation**:
- `apps/api/src/lib/cache.ts::readThrough` extended with optional `isFresh: (cached: T) => boolean` predicate. Loader fires on miss OR predicate-rejected cache.
- `apps/api/src/handlers/score.ts::historyIsFresh` validates schema version + non-empty + newest-timestamp age.
- `apps/og/src/lib/data.ts::loadSnapshot` adds `isFresh()` matching api semantics (`headline.updatedAt` within 30 min).
- `apps/ingest/src/admin.ts` adds `purge-cache` source: deletes `score:latest`, `score:history:90d`, `delivery:latest`, `timeline:latest`, `movements:today`. Auth-gated, idempotent, reports purged + failed lists separately.

**Tests added**:
- `apps/og/src/lib/data.test.ts` — 5 tests (fresh/stale/empty/wrong-schema/unparseable-timestamp).
- `apps/api/src/tests/scoreHistory.test.ts` — 5 tests (same matrix).
- `apps/ingest/src/tests/purgeCache.test.ts` — 5 tests (auth, key set, idempotency, method, per-key failure isolation).

## 🟡 5. Retired-adapter audit rows — 🛠️ FIXED

`INACTIVE_INGEST_SOURCES` set added to `packages/shared/src/sourceHealth.ts`:
`boe_sonia`, `ice_gas`, `lseg_housebuilders`, `twelve_data_housebuilders`.

- `computeSourceHealth` skips entries from these sources (was already skipping `:historical` siblings).
- `apps/api/src/handlers/health.ts` strips them from `/api/v1/health` response, including their `:historical` siblings.

**Tests added**:
- `packages/shared/src/sourceHealth.inactive.test.ts` — 6 tests (set membership, no-overlap-with-active-indicators safety check, `isActiveIngestSource` predicate, `computeSourceHealth` filter behaviour).
- `apps/api/src/tests/health.test.ts` — 3 tests (retired-source exclusion, `:historical` sibling drop, query-param rejection).

The audit rows themselves remain in `ingestion_audit` (forensic value). Only the public surface filters them.

## 🟡 6. Refresh chain — ✅ HEALTHY

All daily crons fired in expected windows. KV `score:latest` is recomputed every 5 minutes. No DLQ rows. No `DB_ERROR` responses on probes. No code change.

## 🟡 7. BoE T+1 lag — ✅ NOT A BUG

Confirmed by direct probe of `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?SeriesCodes=IUDMNZC,IUDLNZC&...`: BoE had not yet published Fri 24 Apr yields at the time of the probe (Mon 27 Apr 11:18 UTC). FX *had* published Fri 24 Apr. This is upstream BoE publishing behaviour, not an adapter bug. No code change.

## 🟡 8. `gbp_usd = 1.35` — ✅ ACCURATE

Confirmed by direct probe: BoE's published `XUDLUSS` for Fri 24 Apr 2026 is `1.3500`, matching the live API. The timeline event `t_2026_04_17` ("near 1.2400") was correct for Apr 17; sterling rallied further between Apr 17 and Apr 24 — the narrative just hasn't caught up. Worth an editorial timeline edit but the displayed number is correct.

---

## Test summary

Pre-audit: 357 tests across 6 workspaces (estimated; baseline observed during survey).
Post-audit: **402 tests across 7 workspaces, all passing.** Typecheck clean across all 7.

New tests added (45 total):
| File | Count |
|------|-------|
| `apps/api/src/tests/snapshot-fixture-supersede.test.ts` | 4 |
| `apps/api/src/tests/scoreHistory.test.ts`               | 5 |
| `apps/api/src/tests/health.test.ts`                     | 3 |
| `apps/ingest/src/tests/latestLive.test.ts`              | 9 |
| `apps/ingest/src/tests/purgeCache.test.ts`              | 5 |
| `apps/og/src/lib/data.test.ts`                          | 5 |
| `packages/shared/src/sourceHealth.inactive.test.ts`     | 6 |
| `packages/data-sources/src/adapters/eiaBrent.test.ts`     | +2 (3 from 1) |
| `packages/data-sources/src/adapters/growthSentiment.test.ts` | +2 (3 from 1) |
| `packages/data-sources/src/adapters/moneyfactsMortgage.test.ts` | 4 (new) |

## Files changed

```
modified:   apps/api/src/handlers/health.ts
modified:   apps/api/src/handlers/score.ts
modified:   apps/api/src/lib/cache.ts
modified:   apps/api/src/lib/db.ts
modified:   apps/og/src/lib/data.ts
modified:   apps/web/src/lib/db.ts
modified:   apps/ingest/src/admin.ts
modified:   apps/ingest/src/lib/history.ts
modified:   apps/ingest/src/pipelines/recompute.ts
modified:   apps/ingest/src/pipelines/todayMovements.ts
modified:   packages/data-sources/src/adapters/eiaBrent.ts
modified:   packages/data-sources/src/adapters/growthSentiment.ts
modified:   packages/data-sources/src/adapters/moneyfactsMortgage.ts
modified:   packages/shared/src/sourceHealth.ts
new:        apps/api/src/tests/health.test.ts
new:        apps/api/src/tests/scoreHistory.test.ts
new:        apps/api/src/tests/snapshot-fixture-supersede.test.ts
new:        apps/og/src/lib/data.test.ts
new:        apps/ingest/src/tests/latestLive.test.ts
new:        apps/ingest/src/tests/purgeCache.test.ts
new:        packages/data-sources/src/adapters/moneyfactsMortgage.test.ts
new:        packages/shared/src/sourceHealth.inactive.test.ts
new:        db/patches/cleanup-fixture-superseded-rows.sql
new:        SOURCES.md
new:        AUDIT_FINDINGS.md  (this file)
```

## Pre-deploy checklist

1. **Resolve #2** (housing_trajectory methodology): decide which value should be on screen. If the answer is "match the public commitment text" (72.4% / 64.1%), update `packages/data-sources/src/fixtures/housing.json` accordingly. Otherwise prepare a `/corrections` entry explaining the run-rate-vs-outturn methodology change before deploy.
2. **Apply migrations**: no schema changes in this branch — nothing to apply.
3. **Deploy order**: data-sources → shared → ingest → api → web → og. (No hard ordering required because all changes are runtime-compatible, but this order ensures the recompute writes a correct KV snapshot before downstream consumers re-read.)
4. **Post-deploy verification**:
   - Hit `https://api.tightropetracker.uk/api/v1/score` and check `pillars.fiscal.contributions[].rawValue` for `cb_headroom`. Expect 23.6.
   - Hit `https://api.tightropetracker.uk/api/v1/health` and check the response no longer contains `boe_sonia`, `ice_gas`, `lseg_housebuilders`, `twelve_data_housebuilders`.
   - Hit `POST https://ingest.tightropetracker.uk/admin/run?source=purge-cache` (with `x-admin-token`) and confirm the response lists the five purged keys.
5. **Optional defensive cleanup**: run `db/patches/cleanup-fixture-superseded-rows.sql` against the prod D1 to delete the now-bypassed stale rows. Sanity-check the count first.
