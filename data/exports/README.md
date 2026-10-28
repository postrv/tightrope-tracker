# Tightrope Tracker — composite history exports

Dated exports of the headline Tightrope Score and its four pillars,
captured from the production D1 database. These are historical artifacts;
later corrections and reconstructions can change the current database.

**The 2026-04-29 CSV is an outdated archive, not a current-methodology
comparison series.** A formula check finds that 497 of its 499 headline
values differ by more than 0.25 points from the weighted geometric mean
of its displayed pillar columns. Direction-converted legacy scores and
the export's independent pillar sampling prevent that assumption. Keep
this file as captured; use the current score-history API for current
formula comparisons and its declared sampling and coverage metadata.

## Files

- `tightrope-composite-history-YYYY-MM-DD.csv` — full available daily
  series captured on the export date. Past rows can change in D1 after
  an audited correction or reconstruction; a later export is a new capture.

## Schema

| Column            | Type    | Description                                                                  |
|-------------------|---------|------------------------------------------------------------------------------|
| `date`            | YYYY-MM-DD (UTC) | UTC calendar day. One row per day.                                  |
| `headline`        | float   | Tightrope composite score (0–100). Higher = more room to move.               |
| `headline_band`   | string  | `critical` / `acute` / `strained` / `steady` / `slack`. Threshold ladder in methodology. |
| `dominant_pillar` | string  | The pillar with the largest weighted shortfall from 100 (i.e. biggest drag). |
| `market`          | float   | Market Stability pillar score (0–100). Weight 0.40.                          |
| `fiscal`          | float   | Fiscal Room pillar score (0–100). Weight 0.30.                               |
| `labour`          | float   | Labour & Living pillar score (0–100). Weight 0.20.                           |
| `delivery`        | float   | Growth Delivery pillar score (0–100). Weight 0.10.                           |

## Polarity

All scores use the public polarity: **0 = maximum stress, 100 = slack /
on track**. Historical rows that pre-date the polarity convention
were converted in place before this archive was captured (see
`/corrections` entry "score-direction-v2" on 2026-04-28). Complementing a
legacy headline changes its direction; it does not recompute the current
geometric mean from its complemented pillars. A falling score means
conditions are worsening within a comparable calculation series.

## Methodology in brief

The current composite is the weighted geometric mean of the four pillar values,
clamped to [0, 100]. Each pillar is the weighted arithmetic mean of its
indicators after baseline-normalisation against a 2019-onwards window
that excludes Apr–Jun 2020. Full methodology and per-indicator weights
are at <https://tightropetracker.uk/methodology>. This description does not
make archived values comparable across calculation changes.

## Caveats / known notes

- This archive starts **2024-12-17**. Current coverage is reported by
  the score-history API and may differ from this historical capture.
- The legacy export samples the **last observation timestamp per day**
  (`MAX(observed_at)`) independently for the headline and each pillar.
  Recompute writes every five minutes; the captured value is the last
  one timestamped before midnight UTC. The current API instead aligns
  each pillar as of the selected headline timestamp.
- Some early backfill days carry constant pillar values where the
  underlying indicators were monthly / quarterly and only updated on
  publication. Reconstructed history can incorporate later source
  revisions and is not an immutable archive of what was known that day.
- Q4 2025 housing-trajectory step (49.0% from 30 Dec 2025 onward) and
  the OBR 2026 Spring Forecast cb_headroom step (£23.6bn from 3 Mar
  2026 onward) are real publication events, not data anomalies.

## Reproducing this export

The legacy script that produced this CSV lives in this repo at
`db/scripts/export-composite-history.sh`; its independent daily sampling
differs from the current API reader. The query is read-only — `rows_written=0`, `changed_db=false`
on the wrangler ack — so it's safe to re-run any time.

```bash
# Default: writes data/exports/tightrope-composite-history-YYYY-MM-DD.csv
db/scripts/export-composite-history.sh

# Or write to an explicit path:
db/scripts/export-composite-history.sh path/to/out.csv
```

Requires `wrangler` authenticated against the production Cloudflare
account and `python3` in PATH (used as a CSV writer with proper
quoting). Re-running now captures the current database and need not be
byte-identical to this archive. Preserve dated artifacts and use a new
filename for a new capture.

## Source provenance

Each pillar's indicators are listed at <https://tightropetracker.uk/sources>
and in `SOURCES.md` at the repo root. Every figure has a primary source
URL and a corrections-log entry if it has ever been restated.

— Archive captured 2026-04-29; guidance reviewed 2026-10-28.

## MHCLG source workbooks, September 2026 vintage

`mhclg-housebuilding-table222-2026-09-24.ods` and
`mhclg-planning-p120-p138-2026-09-24.ods` preserve the original official
workbooks downloaded on 28 October 2026. Both covers give 24 September 2026
as the publication date. Source URLs, SHA-256 hashes and the 28 extracted
leading indicator quarters are recorded in
`mhclg-leading-2019-2022-evidence-2026-10-28.json`.

Housing uses Table 222a, column I: seasonally adjusted new-build completions
in England. Table 222b is an index and is unsuitable for that count formula.
Planning uses Table P120A, columns D plus L: major and minor residential
applications granted. These are application counts, not dwelling units.

The leading fixture extension adds 13 housing quarters and 15 planning
quarters from 2019, preserving all existing later components and current
47.7 / 60 readings. New rows carry the workbook's current-vintage publication
date; they do not claim to recover what was originally published in those
quarters. Existing later fixture vintages remain unchanged. The estimated
11,500 planning benchmark is retained; the workbook's exact calendar 2019
quarterly mean is 11,174.5, which is disclosed in the indicator description.

## Prepared baseline coverage and finalization

Preparation status: **proposal only; no production baseline writes**.

`baseline-2019-primary-2026-10-28/` contains the reviewed 8,770-observation
proposal across 17 inputs, source captures and hashes, ODS cell evidence,
1,396 EIA/FX pair checks, and a disposable SQLite application/retry proof.
The proposal adds 8,375 baseline-eligible observations and retains the existing
Q2 2020 exclusion for 395 observations. Its controlled replay holds the
18:35 UTC current readings constant: **39.4 to 36.9**. This measures baseline
coverage sensitivity. The earlier 40.2 to 37.6 replay is preserved separately.
Current-vintage histories do not reconstruct what was known in each earlier
period, and earlier published headline/pillar scores are not regenerated.

Run `node --import tsx scripts/backfill-leading-baseline-2019.mjs` for the
offline plan. The production preflight only reads D1; applying the operation
requires its separate explicit approval. The runner uses `overwrite=false`
and checks preservation of every original observation field. The prepared
proof preserves all 8,294 original records. `applied.json` is created only
after a verified production application; proposal files alone are not proof
that a backfill happened.

Before the first production write, the runner exclusively saves the actual
`attempt-before-observations.json` and an `attempt.json` recording its SHA-256,
row count and application start time. A complete
success receipt is created exclusively only after every source and original
field has been verified. A verified all-present retry preserves the original
receipt and before-state bytes without production or evidence writes. An
incomplete attempt or unreceipted partial history stops for explicit
reconciliation; the original attempt, before-state archive and separate
failure diagnostic are retained rather than automatically resumed or replaced.

After application and a normal score recompute, run:

```bash
node --import tsx scripts/finalize-baseline-2019-audit.mjs \
  --input=/absolute/post-apply-D1-dump.json \
  --snapshot=/absolute/current-score.json \
  --sql-output=/absolute/resolved-baseline-disclosure.sql
```

This local workflow verifies all 8,770 inserted source values, the application
record and 8,375 eligible additions, regenerates the structural quality audit,
and retains all reviewed historical range flags. It resolves the draft
`db/patches/correct-2026-10-28-baseline-coverage.sql` from actual application
timestamps. The unresolved draft fails before inserting anything; the resolved
SQL also requires nine successful historical audits totaling 8,770 rows.
The timeline marks application **start**, so interim recomputes are covered;
the correction publication and summary record **completion**. The workflow
publishes nothing. Apply the resolved disclosure and verify its public result
as separate authorized steps.
