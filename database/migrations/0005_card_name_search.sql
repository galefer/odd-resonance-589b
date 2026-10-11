-- Add an indexed word-suffix search table so partial card-name searches do not
-- scan the complete eligible catalogue. Safe to run more than once.
CREATE TABLE IF NOT EXISTS card_name_search (
 search_text TEXT NOT NULL,
 card_id INTEGER NOT NULL,
 PRIMARY KEY (search_text, card_id)
) WITHOUT ROWID;

DELETE FROM card_name_search;
WITH RECURSIVE suffixes(card_id, search_text) AS (
  SELECT card_id, sort_name
  FROM cards_cache
  WHERE pool_verified=1 AND sort_name<>''
  UNION ALL
  SELECT card_id, ltrim(substr(search_text, instr(search_text, ' ') + 1))
  FROM suffixes
  WHERE instr(search_text, ' ') > 0
)
INSERT OR IGNORE INTO card_name_search(search_text, card_id)
SELECT search_text, card_id FROM suffixes WHERE search_text<>'';
