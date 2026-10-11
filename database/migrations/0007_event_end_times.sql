-- Apply ONCE to an existing database using the pre-0007 event schema.
-- Fresh databases use schema.sql and seed.sql instead.
ALTER TABLE recurring_events ADD COLUMN end_time TEXT NOT NULL DEFAULT '';
ALTER TABLE event_overrides ADD COLUMN end_time TEXT NOT NULL DEFAULT '';
ALTER TABLE special_events ADD COLUMN end_time TEXT NOT NULL DEFAULT '';

UPDATE recurring_events SET start_time='17:30',end_time='21:00',updated_at=datetime('now')
WHERE slug IN ('yugioh-advanced-thursday','yugioh-house-friday');

-- Fill previously unspecified times, without changing an explicitly customised
-- occurrence, its cancellation, title, location or description.
UPDATE event_overrides SET start_time='17:30',end_time='21:00',updated_at=datetime('now')
WHERE start_time='' AND recurring_event_id IN (
  SELECT id FROM recurring_events WHERE slug IN ('yugioh-advanced-thursday','yugioh-house-friday')
);
UPDATE event_overrides SET end_time='21:00',updated_at=datetime('now')
WHERE start_time='17:30' AND end_time='' AND recurring_event_id IN (
  SELECT id FROM recurring_events WHERE slug IN ('yugioh-advanced-thursday','yugioh-house-friday')
);
