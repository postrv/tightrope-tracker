# Tightrope Tracker — composite history exports

Daily UTC-downsampled snapshots of the headline Tightrope Score and its
four pillars, generated directly from the production D1 database.

## Files

- `tightrope-composite-history-YYYY-MM-DD.csv` — full available daily
  series up to and including the export date. Re-run the export query
  any time; rows are stable for past dates and grow forward by one row
  per UTC day as recompute writes accumulate.

## Schema

| Column            | Type    | Description                                                                  |
|-------------------|---------|------------------------------------------------------------------------------|
| `date`            | YYYY-MM-DD (UTC) | UTC calendar day. One row per day.                                  |
| `headline`        | float   | Tightrope composite score (0–100). Higher = more room to move.               |
| `headline_band`   | string  | `acute` / `strained` / `steady` / `slack`. Threshold ladder in methodology.  |
| `dominant_pillar` | string  | The pillar with the largest weighted shortfall from 100 (i.e. biggest drag). |
| `market`          | float   | Market Stability pillar score (0–100). Weight 0.40.                          |
| `fiscal`          | float   | Fiscal Room pillar score (0–100). Weight 0.30.                               |
| `labour`          | float   | Labour & Living pillar score (0–100). Weight 0.20.                           |
| `delivery`        | float   | Growth Delivery pillar score (0–100). Weight 0.10.                           |

## Polarity

All scores use the public polarity: **0 = maximum stress, 100 = slack /
on track**. Historical rows that pre-date the polarity convention have
been converted in-place (see `/corrections` entry "score-direction-v2"
on 2026-04-28). A falling score means conditions are worsening.

## Methodology in brief

The composite is the weighted geometric mean of the four pillar values,
clamped to [0, 100]. Each pillar is the weighted arithmetic mean of its
indicators after baseline-normalisation against a 2019-onwards window
that excludes Apr–Jun 2020. Full methodology and per-indicator weights
are at <https://tightropetracker.uk/methodology>.

## Caveats / known notes

- Date axis starts **2024-12-17**: that's the earliest UTC day with a
  written `headline_scores` row. Pillar history extends back to
  2024-07-01 in the database but the headline row was not computed for
  those earlier dates. If you need pre-Dec-2024 pillar values, ask and
  we can ship a separate pillars-only export.
- Days are downsampled to one row each, taking the **latest write per
  day** (`MAX(observed_at)`) for both the headline and each pillar.
  Recompute writes every five minutes; the captured value is the last
  one written before midnight UTC.
- Some early backfill days carry constant pillar values where the
  underlying indicators were monthly / quarterly and only updated on
  publication. This is the same shape the website chart shows — values
  step on a publication, not smoothly.
- Q4 2025 housing-trajectory step (49.0% from 30 Dec 2025 onward) and
  the OBR 2026 Spring Forecast cb_headroom step (£23.6bn from 3 Mar
  2026 onward) are real publication events, not data anomalies.

## Reproducing this export

The query that produced this CSV lives in this repo at
`db/scripts/export-composite-history.sh` (TODO if needed); the inline
SQL is also in the export-script header comment. Run via:

```bash
wrangler d1 execute tightrope_db --remote \
  --config=apps/api/wrangler.toml --command="<SQL>" --json
```

then pipe through the lightweight Python CSV writer used in this
session (in the chat transcript on 2026-04-29).

## Source provenance

Each pillar's indicators are listed at <https://tightropetracker.uk/sources>
and in `SOURCES.md` at the repo root. Every figure has a primary source
URL and a corrections-log entry if it has ever been restated.

— Generated 2026-04-29.
