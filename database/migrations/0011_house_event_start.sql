-- Store the first published JUSH monthly occurrence as schedule data rather
-- than embedding it in recurrence code. Repeat-safe and data-only.
INSERT OR IGNORE INTO settings(key,value)
VALUES ('house_event_start','2026-11-26');
