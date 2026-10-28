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
