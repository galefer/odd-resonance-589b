-- Show the full current month's Thursday programme. The regular Advanced
-- series runs on every Thursday except the last, which is the House Format.
-- Apply once to an existing event database before deploying the matching code.

ALTER TABLE recurring_events ADD COLUMN recurrence_pattern TEXT NOT NULL DEFAULT 'weekly'
  CHECK(recurrence_pattern IN ('weekly','weekly_except_last','last'));

UPDATE recurring_events
SET weekday=4, recurrence_pattern='weekly_except_last', updated_at=datetime('now')
WHERE slug='yugioh-advanced-thursday';

UPDATE recurring_events
SET weekday=4, recurrence_pattern='last', updated_at=datetime('now')
WHERE slug='yugioh-house-friday';
