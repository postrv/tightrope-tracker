-- Score schema v2: public score direction changes from pressure-oriented
-- (100 = maximum stress) to room-to-move oriented (100 = slack / on track).
-- This migration converts stored historical headline/pillar values in place
-- and rebuckets bands on the new axis.
--
-- Idempotency: every data-modifying statement is gated on the absence of the
-- 'score-direction-v2' corrections row. The sentinel row is inserted at the
-- end of the migration. A second run finds the sentinel and skips every
-- UPDATE — re-running the migration cannot double-flip the data and silently
-- restore the old "0 = slack" polarity behind a `schemaVersion: 2` API
-- contract.
--
-- Safety filters:
--   * `value IS NOT NULL AND value BETWEEN 0 AND 100` on score tables: a
--     pre-existing NULL or out-of-range row would otherwise become NULL or
--     negative under `100 - value`, which the band CASE buckets to
--     'critical'. We skip such rows so a single corrupt value can't cascade
--     into a fabricated extreme reading on the homepage.
--   * `score_delta IS NOT NULL` on timeline_events: a NULL delta has no
--     polarity to flip.
--
-- SQLite SET-clause semantics: all expressions on the right-hand side of SET
-- are evaluated against the original row before any assignments take effect.
-- That means `band = CASE WHEN 100 - value < 20 ...` correctly buckets using
-- the pre-update `value`, even though the same statement reassigns `value`.

UPDATE pillar_scores
SET
  value = 100 - value,
  band = CASE
    WHEN 100 - value < 20 THEN 'critical'
    WHEN 100 - value < 40 THEN 'acute'
    WHEN 100 - value < 60 THEN 'strained'
    WHEN 100 - value < 80 THEN 'steady'
    ELSE 'slack'
  END
WHERE value IS NOT NULL
  AND value BETWEEN 0 AND 100
  AND NOT EXISTS (SELECT 1 FROM corrections WHERE id = 'score-direction-v2');

UPDATE headline_scores
SET
  value = 100 - value,
  band = CASE
    WHEN 100 - value < 20 THEN 'critical'
    WHEN 100 - value < 40 THEN 'acute'
    WHEN 100 - value < 60 THEN 'strained'
    WHEN 100 - value < 80 THEN 'steady'
    ELSE 'slack'
  END,
  editorial = CASE dominant
    WHEN 'market' THEN 'Market Stability is the biggest drag; score converted to high-good schema v2.'
    WHEN 'fiscal' THEN 'Fiscal Room is the biggest drag; score converted to high-good schema v2.'
    WHEN 'labour' THEN 'Labour & Living-Standards Resilience is the biggest drag; score converted to high-good schema v2.'
    WHEN 'delivery' THEN 'Growth Delivery is the biggest drag; score converted to high-good schema v2.'
    ELSE 'Tightrope Score converted to high-good schema v2.'
  END
WHERE value IS NOT NULL
  AND value BETWEEN 0 AND 100
  AND NOT EXISTS (SELECT 1 FROM corrections WHERE id = 'score-direction-v2');

UPDATE timeline_events
SET score_delta = -score_delta
WHERE score_delta IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM corrections WHERE id = 'score-direction-v2');

-- Sentinel: marks this migration as applied. INSERT OR IGNORE so re-running
-- the migration file (e.g. after a manual `wrangler d1 migrations apply`
-- against an already-migrated DB without migrations_applied tracking) is a
-- silent no-op rather than a constraint error. The presence of this row is
-- the load-bearing signal — every UPDATE above gates on its absence.
INSERT OR IGNORE INTO corrections (
  id,
  published_at,
  affected_indicator,
  original_value,
  corrected_value,
  reason
) VALUES (
  'score-direction-v2',
  '2026-04-28T00:00:00Z',
  'headline_score',
  'Score values used pressure polarity: 0 = slack / on track, 100 = maximum stress.',
  'Score values use public polarity: 0 = maximum stress, 100 = slack / on track.',
  'Methodology change to align the published Tightrope Score with ordinary reader intuition: a falling score now means conditions are worsening. Historical headline, pillar, and event-delta rows were converted by complementing score values and flipping score-delta signs. NULL and out-of-range rows were left untouched.'
);
