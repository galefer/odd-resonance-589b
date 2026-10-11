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
