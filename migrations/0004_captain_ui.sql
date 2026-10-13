-- The question of a decision in one sentence, for lists and headings; the full text stays in `question`.
ALTER TABLE decisions ADD COLUMN title TEXT;
-- Where an app runs, shown on the release route (planned → staging → live).
ALTER TABLE teams ADD COLUMN staging_url TEXT;
ALTER TABLE teams ADD COLUMN live_url TEXT;
