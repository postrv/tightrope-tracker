-- log-2026-04-29-audit-corrections.sql
--
-- Three corrections-log entries recording user-visible changes shipped
-- in commits 6f84670 and 9e35779 (pre-broadcast liveness/freshness audit
-- on 2026-04-29).
--
--   1. headline.editorial copy — the hero sentence was attributing the
--      dominant pillar's delta7d to "the score", so readers saw
--      "the score is worsening (down 12.6 on the week)" while the
--      headline was actually +1.7 on the week. Editorial-honesty fix.
--
--   2. brent_gbp displayed value — the live EIA path was silently
--      falling through to a 12-day-stale fixture every cron tick.
--      The two-tier latest-observation selector (audit fix) now
--      surfaces the 2026-04-20 backfill row, and the editorial
--      fixture has been refreshed to match.
--
--   3. ftse_250 displayed value — same root cause as Brent. Live
--      EODHD path was returning HTTP 404 for FTMC.LSE, falling
--      through to a 6-day-stale fixture. Selector fix + refreshed
--      fixture surfaces the 2026-04-24 backfill row instead.
--
-- Idempotent: INSERT OR IGNORE keyed on the deterministic id, so
-- re-running this patch is a no-op.
--
-- Cache invalidation: corrections are read live from D1 by the API,
-- and KV doesn't cache the corrections list, so the entries surface
-- on the next /corrections request without a manual purge.
--
-- Run as:
--   wrangler d1 execute tightrope_db --remote \
--     --file=db/patches/log-2026-04-29-audit-corrections.sql

INSERT OR IGNORE INTO corrections
  (id, published_at, affected_indicator, original_value, corrected_value, reason)
VALUES (
  'c_2026_04_29_editorial_attribution',
  '2026-04-29T12:00:00Z',
  'headline_score',
  'Editorial sentence attributed the dominant pillar''s 7-day delta to "the score" (e.g. "the score is worsening (down 12.6 on the week)" while the headline was actually +1.7 on the week).',
  'Editorial sentence now attaches the move to the pillar by name (e.g. "Market Stability is the biggest drag, down 12.6 on the week."). The headline''s own delta is published separately under headline.delta24h / .delta30d / .deltaYtd.',
  'A pre-broadcast audit on 2026-04-29 found the editorial copy could attribute a pillar-level move to the headline when the dominant pillar moved against the headline. The fix changes the sentence subject so the magnitude can never be misread as the headline''s movement; the headline''s own deltas remain on the response unchanged. Methodology and pillar/headline values are unaffected.'
);

INSERT OR IGNORE INTO corrections
  (id, published_at, affected_indicator, original_value, corrected_value, reason)
VALUES (
  'c_2026_04_29_brent_freshness',
  '2026-04-29T12:00:00Z',
  'brent_gbp',
  '£72.68/bbl, observed_at 2026-04-17 (12-day-stale editorial fixture).',
  '£76.46/bbl, observed_at 2026-04-20 (live EIA RBRTE × BoE XUDLUSS pair from the 2026-04-27 backfill run).',
  'The live EIA Open Data v2 path had been silently returning empty rows since 2026-04-17, so every five-minute cron tick was re-writing the editorial fixture rather than ingesting a fresh print. The latest-observation selector previously preferred the most-recently-ingested live row, so the stale-dated fixture row kept winning over fresher backfill data. Fixed by a two-tier selector that prefers fresher observed_at when backfill is more recent than a fixture-fall-through, plus an editorial fixture refresh to match. Live-path root cause (EIA returning empty rows for the EPCBRENT facet) is still under investigation; diagnostic logging widened in the same change.'
);

INSERT OR IGNORE INTO corrections
  (id, published_at, affected_indicator, original_value, corrected_value, reason)
VALUES (
  'c_2026_04_29_ftse_freshness',
  '2026-04-29T12:00:00Z',
  'ftse_250',
  '22,984, observed_at 2026-04-23 (6-day-stale editorial fixture).',
  '22,583, observed_at 2026-04-24 (live EODHD close from the 2026-04-27 backfill run).',
  'The live EODHD path had been returning HTTP 404 for FTMC.LSE, so the adapter was silently falling through to the editorial fixture every cron tick. Same root cause and same fix as the Brent correction above: two-tier latest-observation selector now surfaces fresher backfill rows when a live adapter is silently failing through to an older fixture, plus an editorial fixture refresh. EODHD ticker-namespace investigation still open.'
);

-- Verification: the three new rows should appear at the top of the
-- corrections list once this patch lands.
SELECT id, published_at, affected_indicator
FROM corrections
WHERE id IN (
  'c_2026_04_29_editorial_attribution',
  'c_2026_04_29_brent_freshness',
  'c_2026_04_29_ftse_freshness'
)
ORDER BY published_at DESC, id;
