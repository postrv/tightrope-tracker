-- fix-housing-notes-government-capitalisation.sql
--
-- Capitalise "Labour government" to "Labour Government" in the
-- housing_305k.notes field, matching the seed and the rest of the
-- site copy ("The Government's own stated commitments…"). Per the
-- LFG style guideline: capitalise "Government" when referring to
-- the specific UK Government, lowercase when generic.
--
-- DeliverySection.astro renders `c.notes` directly under the housing
-- commitment row, so this is broadcast-facing copy.
--
-- Idempotent: REPLACE only swaps the lowercase substring; if the row
-- already reads "Labour Government" the WHERE clause guards against a
-- no-op write. Other "labour" instances in the same notes (e.g.
-- "pre-Labour trajectory analysis") are correct and untouched.
--
-- Cache invalidation: delivery:latest in KV self-heals within ~30 min,
-- or `wrangler kv key delete --namespace-id=<KV_ID> --remote
-- delivery:latest` for instant refresh.
--
-- Run as:
--   wrangler d1 execute tightrope_db --remote \
--     --file=db/patches/fix-housing-notes-government-capitalisation.sql

-- Sanity check before mutation.
SELECT id, substr(notes, instr(notes, 'Labour'), 60) AS extract
FROM delivery_commitments
WHERE id = 'housing_305k';

UPDATE delivery_commitments
SET notes = REPLACE(notes, 'Labour government''s headline pledge', 'Labour Government''s headline pledge')
WHERE id = 'housing_305k'
  AND notes LIKE '%Labour government''s headline pledge%';

-- Sanity check after mutation: the extract should now show
-- "Labour Government's headline pledge…"
SELECT id, substr(notes, instr(notes, 'Labour'), 60) AS extract
FROM delivery_commitments
WHERE id = 'housing_305k';
