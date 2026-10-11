-- Prevent the default deckbuilder catalogue page from scanning and sorting the
-- entire eligible pool. Safe to run more than once.
CREATE INDEX IF NOT EXISTS idx_cache_pool_sort ON cards_cache(pool_verified,sort_name);
