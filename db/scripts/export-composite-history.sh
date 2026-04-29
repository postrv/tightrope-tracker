#!/usr/bin/env bash
#
# export-composite-history.sh
#
# Produce a daily UTC-downsampled CSV of the headline Tightrope Score
# and the four pillar scores from the production D1 database. One row
# per UTC day, taking MAX(observed_at) per day so intra-day recompute
# writes (every 5 minutes in steady state) collapse to a single
# end-of-day snapshot.
#
# Usage:
#
#   db/scripts/export-composite-history.sh                  # writes data/exports/tightrope-composite-history-YYYY-MM-DD.csv
#   db/scripts/export-composite-history.sh path/to/out.csv  # writes to an explicit path
#
# Output schema (see data/exports/README.md for full provenance):
#
#   date              UTC YYYY-MM-DD
#   headline          Tightrope composite score, 0-100, public polarity (higher = more room to move)
#   headline_band     acute | strained | steady | slack
#   dominant_pillar   pillar with the largest weighted shortfall from 100
#   market            Market Stability pillar score, 0-100 (weight 0.40)
#   fiscal            Fiscal Room pillar score, 0-100 (weight 0.30)
#   labour            Labour & Living pillar score, 0-100 (weight 0.20)
#   delivery          Growth Delivery pillar score, 0-100 (weight 0.10)
#
# Numbers are formatted to two decimals; rows are ordered ascending by
# date. The query is read-only (rows_written=0, changed_db=false on the
# wrangler ack) — safe to run any time without touching prod state.
#
# Requirements:
#
#   - wrangler authenticated against the production Cloudflare account
#   - python3 in PATH (used as a CSV writer with proper quoting)
#   - run from the repo root (the wrangler config is referenced by relative path)
#
# Audit defensibility:
#
#   The inline SQL below is the single source of truth for what each
#   row contains. Anyone with prod D1 access can re-run this script
#   and get a byte-identical CSV for any past date — that's the whole
#   point. If you change the SQL, bump the script header comment and
#   ship a corrections-log entry alongside.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRANGLER_CONFIG="${REPO_ROOT}/apps/api/wrangler.toml"

if [[ -n "${1:-}" ]]; then
  OUT_PATH="$1"
else
  TODAY="$(date -u +%Y-%m-%d)"
  mkdir -p "${REPO_ROOT}/data/exports"
  OUT_PATH="${REPO_ROOT}/data/exports/tightrope-composite-history-${TODAY}.csv"
fi

# The CTE has two halves:
#
#   daily_headline   one row per UTC day, the latest observed_at write
#   daily_pillar     one row per (UTC day, pillar_id), latest write
#
# The outer SELECT pivots the pillar rows to columns. LEFT JOIN keeps
# headline rows even on days where a pillar happens to be NULL (rare,
# would only occur if recompute wrote a headline without a pillar
# alongside, which the production pipeline doesn't actually do — but
# defensive against any future divergence).
SQL=$(cat <<'EOF'
WITH
  daily_headline AS (
    SELECT substr(h.observed_at, 1, 10) AS day,
           h.observed_at, h.value AS headline_value, h.band, h.dominant
    FROM headline_scores h
    JOIN (
      SELECT substr(observed_at, 1, 10) AS day, MAX(observed_at) AS ts
      FROM headline_scores GROUP BY substr(observed_at, 1, 10)
    ) m ON h.observed_at = m.ts
  ),
  daily_pillar AS (
    SELECT substr(p.observed_at, 1, 10) AS day, p.pillar_id, p.value
    FROM pillar_scores p
    JOIN (
      SELECT substr(observed_at, 1, 10) AS day, pillar_id, MAX(observed_at) AS ts
      FROM pillar_scores GROUP BY substr(observed_at, 1, 10), pillar_id
    ) m ON p.pillar_id = m.pillar_id AND p.observed_at = m.ts
  )
SELECT
  dh.day AS date,
  printf('%.2f', dh.headline_value) AS headline,
  dh.band AS headline_band,
  COALESCE(dh.dominant, '') AS dominant_pillar,
  printf('%.2f', MAX(CASE WHEN dp.pillar_id='market'   THEN dp.value END)) AS market,
  printf('%.2f', MAX(CASE WHEN dp.pillar_id='fiscal'   THEN dp.value END)) AS fiscal,
  printf('%.2f', MAX(CASE WHEN dp.pillar_id='labour'   THEN dp.value END)) AS labour,
  printf('%.2f', MAX(CASE WHEN dp.pillar_id='delivery' THEN dp.value END)) AS delivery
FROM daily_headline dh
LEFT JOIN daily_pillar dp ON dh.day = dp.day
GROUP BY dh.day, dh.headline_value, dh.band, dh.dominant
ORDER BY dh.day
EOF
)

# The CSV writer is a separate Python script invoked as `-c` — we can't
# use a heredoc here because the wrangler stdout has to be piped into
# Python's stdin (a `<<HEREDOC` would redirect stdin and silently
# discard the upstream pipe). Doubled-quoted so $OUT_PATH expands.
PY_WRITE_CSV='
import json, sys, csv
data = json.load(sys.stdin)
results = data[0]["results"]
out_path = sys.argv[1]
with open(out_path, "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow([
        "date", "headline", "headline_band", "dominant_pillar",
        "market", "fiscal", "labour", "delivery",
    ])
    for r in results:
        w.writerow([
            r["date"], r["headline"], r["headline_band"], r["dominant_pillar"],
            r["market"], r["fiscal"], r["labour"], r["delivery"],
        ])
print(f"wrote {len(results)} rows to {out_path}", file=sys.stderr)
'

echo "→ querying production D1 (read-only)…" >&2
wrangler d1 execute tightrope_db --remote \
  --config="${WRANGLER_CONFIG}" \
  --command="${SQL}" \
  --json \
  | python3 -c "${PY_WRITE_CSV}" "${OUT_PATH}"

echo "✓ done. First and last rows:" >&2
head -1 "$OUT_PATH" >&2
sed -n '2p' "$OUT_PATH" >&2
echo "  ..." >&2
tail -1 "$OUT_PATH" >&2
