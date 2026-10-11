#!/usr/bin/env node
/** Verify an additive catalogue import against either the current or pre-migration schema in memory. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const legacySchema = resolve(process.argv[2] || `${root}/database/schema.sql`);
const importFile = resolve(process.argv[3] || `${root}/database/catalogue-import.sql`);
const read = (path) => readFileSync(path, 'utf8');
const db = new DatabaseSync(':memory:');

db.exec(read(legacySchema));
db.exec(read(`${root}/database/seed.sql`));

function restrictionFingerprint() {
  const versions = db.prepare(`SELECT id,status,version_label,effective_date,summary,previous_version_id,source,created_at,published_at
    FROM versions ORDER BY id`).all();
  return versions.map((version) => {
    const entries = db.prepare(`SELECT sort_name,status,note,name FROM entries WHERE version_id=? ORDER BY sort_name`).all(version.id);
    const content = JSON.stringify({ ...version, entries });
    return { id: version.id, entries: entries.length, sha256: createHash('sha256').update(content).digest('hex') };
  });
}

const before = restrictionFingerprint();
const columns = db.prepare('PRAGMA table_info(cards_cache)').all().map((row) => row.name);
const migrationApplied = !columns.includes('canonical_id');
if (migrationApplied) db.exec(read(`${root}/database/migrations/0002_deckbuilder_catalogue.sql`));
db.exec(read(importFile));
const after = restrictionFingerprint();
assert.deepEqual(after, before, 'Restriction versions changed during catalogue migration/import.');

const meta = Object.fromEntries(db.prepare('SELECT key,value FROM catalogue_meta').all().map(({ key, value }) => [key, value]));
const counts = {
  eligible: db.prepare('SELECT COUNT(*) AS n FROM cards_cache WHERE pool_verified=1').get().n,
  evidence: db.prepare('SELECT COUNT(*) AS n FROM card_id_evidence').get().n,
  artworks: db.prepare('SELECT COUNT(*) AS n FROM card_artworks').get().n,
  postCutoff: db.prepare("SELECT COUNT(*) AS n FROM card_id_evidence WHERE reason='outside_pool' AND eligible=0").get().n,
  excluded: db.prepare("SELECT COUNT(*) AS n FROM card_id_evidence WHERE reason IN ('not_playable','missing_tcg_date') AND eligible=0").get().n
};
assert.equal(meta.complete, '1');
assert.equal(counts.eligible, Number(meta.eligible_cards));
assert.equal(counts.artworks, Number(meta.artwork_ids));
assert(counts.postCutoff > 0);
assert(counts.excluded > 0);
assert(db.prepare("SELECT 1 FROM cards_cache WHERE sort_name='dracotail lukias' AND tcg_date<='2025-08-01' AND pool_verified=1").get());
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cards_cache WHERE tcg_date>'2025-08-01' OR pool_verified<>1").get().n, 0);

const sqlText = read(importFile);
const largestStatement = Math.max(...sqlText.split(';').map((statement) => Buffer.byteLength(statement)));
console.log(JSON.stringify({ migrationApplied, meta, counts, largestStatementBytes: largestStatement, restrictionFingerprints: after }, null, 2));
