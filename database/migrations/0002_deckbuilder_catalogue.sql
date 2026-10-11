-- Additive production migration for /gog/deckbuilder/.
-- Apply exactly once after checking PRAGMA table_info(cards_cache).
-- It enriches catalogue metadata and does not modify restriction versions.
ALTER TABLE cards_cache ADD COLUMN canonical_id INTEGER;
ALTER TABLE cards_cache ADD COLUMN artwork_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cards_cache ADD COLUMN tcg_date TEXT;
ALTER TABLE cards_cache ADD COLUMN frame_type TEXT;
ALTER TABLE cards_cache ADD COLUMN placement TEXT CHECK(placement IS NULL OR placement IN ('main','extra'));
ALTER TABLE cards_cache ADD COLUMN link_rating INTEGER;
ALTER TABLE cards_cache ADD COLUMN pendulum_scale INTEGER;
ALTER TABLE cards_cache ADD COLUMN archetype TEXT;
ALTER TABLE cards_cache ADD COLUMN treated_as TEXT;
ALTER TABLE cards_cache ADD COLUMN copy_limit_key TEXT;
ALTER TABLE cards_cache ADD COLUMN pool_verified INTEGER NOT NULL DEFAULT 0 CHECK(pool_verified IN (0,1));
ALTER TABLE cards_cache ADD COLUMN metadata_revision TEXT;

CREATE INDEX IF NOT EXISTS idx_cache_catalogue ON cards_cache(pool_verified,category,sort_name);
CREATE INDEX IF NOT EXISTS idx_cache_pool_sort ON cards_cache(pool_verified,sort_name);
CREATE INDEX IF NOT EXISTS idx_cache_type ON cards_cache(pool_verified,card_type,sort_name);
CREATE INDEX IF NOT EXISTS idx_cache_attribute ON cards_cache(pool_verified,attribute,sort_name);

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

CREATE TABLE IF NOT EXISTS image_cache_v2 (
 asset_key TEXT PRIMARY KEY,
 card_id INTEGER NOT NULL,
 variant TEXT NOT NULL CHECK(variant IN ('thumb','full')),
 size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
 cached_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_cache_v2_card ON image_cache_v2(card_id);
