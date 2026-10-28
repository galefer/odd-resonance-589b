-- Add cropped template-cover images without losing the populated R2 ledger.
-- SQLite cannot widen a CHECK constraint in place, so rebuild only this table.
DROP TRIGGER IF EXISTS image_cache_v2_storage_insert;
DROP TRIGGER IF EXISTS image_cache_v2_storage_update;
DROP TRIGGER IF EXISTS image_cache_v2_storage_delete;
DROP INDEX IF EXISTS idx_image_cache_v2_card;

ALTER TABLE image_cache_v2 RENAME TO image_cache_v2_before_cover;

CREATE TABLE image_cache_v2 (
 asset_key TEXT PRIMARY KEY,
 card_id INTEGER NOT NULL,
 variant TEXT NOT NULL CHECK(variant IN ('thumb','cover','full')),
 size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
 cached_at TEXT NOT NULL
);

INSERT INTO image_cache_v2(asset_key,card_id,variant,size_bytes,cached_at)
SELECT asset_key,card_id,variant,size_bytes,cached_at FROM image_cache_v2_before_cover;

DROP TABLE image_cache_v2_before_cover;
CREATE INDEX idx_image_cache_v2_card ON image_cache_v2(card_id);

CREATE TRIGGER image_cache_v2_storage_insert
AFTER INSERT ON image_cache_v2
BEGIN
 UPDATE image_storage_usage SET size_bytes=size_bytes + NEW.size_bytes WHERE id=1;
END;
CREATE TRIGGER image_cache_v2_storage_update
AFTER UPDATE OF size_bytes ON image_cache_v2
BEGIN
 UPDATE image_storage_usage SET size_bytes=size_bytes + NEW.size_bytes - OLD.size_bytes WHERE id=1;
END;
CREATE TRIGGER image_cache_v2_storage_delete
AFTER DELETE ON image_cache_v2
BEGIN
 UPDATE image_storage_usage SET size_bytes=size_bytes - OLD.size_bytes WHERE id=1;
END;

-- Reconcile the counter after the trigger-free copy. Existing reservations remain
-- counted until their corresponding R2 objects are confirmed and ledgered.
UPDATE image_storage_usage SET size_bytes=
 (SELECT COALESCE(SUM(size_bytes),0) FROM image_cache) +
 (SELECT COALESCE(SUM(size_bytes),0) FROM image_cache_v2) +
 (SELECT COALESCE(SUM(size_bytes),0) FROM image_cache_reservations)
WHERE id=1;
