-- Guild of Games homepage events. Safe to run more than once.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS recurring_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 slug TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL,
 weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
 start_time TEXT NOT NULL DEFAULT '',
 location TEXT NOT NULL DEFAULT 'Guild of Games, Rotherham',
 description TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_overrides (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 recurring_event_id INTEGER NOT NULL REFERENCES recurring_events(id) ON DELETE CASCADE,
 event_date TEXT NOT NULL,
 title TEXT NOT NULL,
 start_time TEXT NOT NULL DEFAULT '',
 location TEXT NOT NULL DEFAULT 'Guild of Games, Rotherham',
 description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(recurring_event_id,event_date)
);

CREATE INDEX IF NOT EXISTS idx_event_overrides_date ON event_overrides(event_date);

CREATE TABLE IF NOT EXISTS special_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL,
 event_date TEXT NOT NULL,
 start_time TEXT NOT NULL DEFAULT '',
 location TEXT NOT NULL DEFAULT 'Guild of Games, Rotherham',
 description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_special_events_date ON special_events(event_date);

INSERT OR IGNORE INTO recurring_events
  (slug,title,weekday,start_time,location,description,active,sort_order,created_at,updated_at)
VALUES
  ('yugioh-advanced-thursday','Yu-Gi-Oh! TCG Advanced',4,'','Guild of Games, Rotherham','Official Advanced Format play at Guild of Games.',1,10,datetime('now'),datetime('now')),
  ('yugioh-house-friday','Yu-Gi-Oh! TCG House',5,'','Guild of Games, Rotherham','Play using the Guild of Games Justice Hunters house format.',1,20,datetime('now'),datetime('now'));
