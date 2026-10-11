-- Run on a dedicated Cloudflare D1 database (gog-house-format).
-- Designed only for the /gog/ house-format application.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS admins (
 id INTEGER PRIMARY KEY CHECK(id = 1),
 email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 salt TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY,
 admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
 csrf_token TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_attempts (
 key_hash TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL,
 window_start TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 version_label TEXT NOT NULL,
 effective_date TEXT NOT NULL,
 summary TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('draft','published')),
 previous_version_id INTEGER REFERENCES versions(id),
 source TEXT NOT NULL DEFAULT 'house',
 created_at TEXT NOT NULL,
 published_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_draft ON versions(status) WHERE status = 'draft';
CREATE TABLE IF NOT EXISTS entries (
 version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 sort_name TEXT NOT NULL,
 card_id INTEGER,
 category TEXT NOT NULL CHECK(category IN ('Monster', 'Spell', 'Trap')),
 subtype TEXT NOT NULL,
 card_type TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('forbidden', 'limited', 'semi_limited')),
 note TEXT,
 PRIMARY KEY (version_id, sort_name)
);
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(version_id, status);
CREATE TABLE IF NOT EXISTS cards_cache (
 card_id INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 sort_name TEXT NOT NULL,
 category TEXT NOT NULL,
 subtype TEXT NOT NULL,
 card_type TEXT NOT NULL,
 race TEXT,
 attribute TEXT,
 level INTEGER,
 atk INTEGER,
 def INTEGER,
 description TEXT,
 image_source_url TEXT,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_sort ON cards_cache(sort_name);
CREATE TABLE IF NOT EXISTS search_cache (
 query TEXT PRIMARY KEY,
 results_json TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS image_cache (
 card_id INTEGER PRIMARY KEY,
 size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
 cached_at TEXT NOT NULL
);
