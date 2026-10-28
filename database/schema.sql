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
 canonical_id INTEGER,
 artwork_ids_json TEXT NOT NULL DEFAULT '[]',
 tcg_date TEXT,
 frame_type TEXT,
 placement TEXT CHECK(placement IS NULL OR placement IN ('main','extra')),
 link_rating INTEGER,
 pendulum_scale INTEGER,
 archetype TEXT,
 treated_as TEXT,
 copy_limit_key TEXT,
 pool_verified INTEGER NOT NULL DEFAULT 0 CHECK(pool_verified IN (0,1)),
 metadata_revision TEXT,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_sort ON cards_cache(sort_name);
CREATE INDEX IF NOT EXISTS idx_cache_catalogue ON cards_cache(pool_verified,category,sort_name);
CREATE INDEX IF NOT EXISTS idx_cache_pool_sort ON cards_cache(pool_verified,sort_name);
CREATE INDEX IF NOT EXISTS idx_cache_type ON cards_cache(pool_verified,card_type,sort_name);
CREATE INDEX IF NOT EXISTS idx_cache_attribute ON cards_cache(pool_verified,attribute,sort_name);
CREATE TABLE IF NOT EXISTS card_name_search (
 search_text TEXT NOT NULL,
 card_id INTEGER NOT NULL,
 PRIMARY KEY (search_text, card_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS card_artworks (
 artwork_id INTEGER PRIMARY KEY,
 canonical_id INTEGER NOT NULL,
 is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artworks_canonical ON card_artworks(canonical_id);
CREATE TABLE IF NOT EXISTS card_id_evidence (
 input_id INTEGER PRIMARY KEY,
 canonical_id INTEGER,
 tcg_date TEXT,
 eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
 reason TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_canonical ON card_id_evidence(canonical_id);
CREATE TABLE IF NOT EXISTS catalogue_meta (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);
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
CREATE TABLE IF NOT EXISTS image_cache_v2 (
 asset_key TEXT PRIMARY KEY,
 card_id INTEGER NOT NULL,
 variant TEXT NOT NULL CHECK(variant IN ('thumb','cover','full')),
 size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
 cached_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_cache_v2_card ON image_cache_v2(card_id);
CREATE TABLE IF NOT EXISTS r2_operation_usage (
 usage_month TEXT PRIMARY KEY,
 class_a_operations INTEGER NOT NULL DEFAULT 0 CHECK(class_a_operations >= 0),
 class_b_operations INTEGER NOT NULL DEFAULT 0 CHECK(class_b_operations >= 0),
 updated_at TEXT NOT NULL,
 CHECK(length(usage_month) = 7)
);
CREATE TABLE IF NOT EXISTS recurring_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 slug TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL,
 weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
 recurrence_pattern TEXT NOT NULL DEFAULT 'weekly' CHECK(recurrence_pattern IN ('weekly','weekly_except_last','last')),
 start_time TEXT NOT NULL DEFAULT '',
 end_time TEXT NOT NULL DEFAULT '',
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
 end_time TEXT NOT NULL DEFAULT '',
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
 end_time TEXT NOT NULL DEFAULT '',
 location TEXT NOT NULL DEFAULT 'Guild of Games, Rotherham',
 description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_special_events_date ON special_events(event_date);

-- Additive migration: count existing artwork once, then maintain the total atomically.
-- Reservations remain counted after an uncertain upload outcome; never expire them
-- without confirming the R2 object has been removed or accounted for in the ledger.
CREATE TABLE IF NOT EXISTS image_storage_usage (
 id INTEGER PRIMARY KEY CHECK(id = 1),
 size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0)
);
CREATE TABLE IF NOT EXISTS image_cache_reservations (
 asset_key TEXT PRIMARY KEY,
 size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
 token TEXT NOT NULL,
 created_at TEXT NOT NULL
);
INSERT INTO image_storage_usage(id,size_bytes)
SELECT 1,
 (SELECT COALESCE(SUM(size_bytes),0) FROM image_cache) +
 (SELECT COALESCE(SUM(size_bytes),0) FROM image_cache_v2) +
 (SELECT COALESCE(SUM(size_bytes),0) FROM image_cache_reservations)
WHERE NOT EXISTS (SELECT 1 FROM image_storage_usage WHERE id=1);
CREATE TRIGGER IF NOT EXISTS image_cache_storage_insert
AFTER INSERT ON image_cache
BEGIN
 UPDATE image_storage_usage SET size_bytes=size_bytes + NEW.size_bytes WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS image_cache_storage_update
AFTER UPDATE OF size_bytes ON image_cache
BEGIN
 UPDATE image_storage_usage SET size_bytes=size_bytes + NEW.size_bytes - OLD.size_bytes WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS image_cache_storage_delete
AFTER DELETE ON image_cache
BEGIN
 UPDATE image_storage_usage SET size_bytes=size_bytes - OLD.size_bytes WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS image_cache_v2_storage_insert
AFTER INSERT ON image_cache_v2
BEGIN
 UPDATE image_storage_usage SET size_bytes=size_bytes + NEW.size_bytes WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS image_cache_v2_storage_update
AFTER UPDATE OF size_bytes ON image_cache_v2
BEGIN
 UPDATE image_storage_usage SET size_bytes=size_bytes + NEW.size_bytes - OLD.size_bytes WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS image_cache_v2_storage_delete
AFTER DELETE ON image_cache_v2
BEGIN
 UPDATE image_storage_usage SET size_bytes=size_bytes - OLD.size_bytes WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS image_cache_reservations_storage_insert
AFTER INSERT ON image_cache_reservations
BEGIN
 UPDATE image_storage_usage SET size_bytes=size_bytes + NEW.size_bytes WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS image_cache_reservations_storage_update
AFTER UPDATE OF size_bytes ON image_cache_reservations
BEGIN
 UPDATE image_storage_usage SET size_bytes=size_bytes + NEW.size_bytes - OLD.size_bytes WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS image_cache_reservations_storage_delete
AFTER DELETE ON image_cache_reservations
BEGIN
 UPDATE image_storage_usage SET size_bytes=size_bytes - OLD.size_bytes WHERE id=1;
END;
