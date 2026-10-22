#!/usr/bin/env node
/**
 * Build the additive, repeat-safe production migration for reviewed release
 * evidence. Generate a fresh full catalogue first, then compare it with the
 * production baseline so the migration copies exactly the reviewed card IDs.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RELEASE_EVIDENCE_OVERRIDES } from '../functions/gog/api/release-evidence-overrides.js';

const root = resolve(import.meta.dirname, '..');
const baselineFile = resolve(process.argv[2] || `${root}/../catalogue-complete.sql`);
const freshFile = resolve(process.argv[3] || `${root}/../catalogue-release-evidence-full.sql`);
const outputFile = resolve(process.argv[4] || `${root}/database/migrations/0008_release_evidence_overrides.sql`);
const schema = readFileSync(`${root}/database/schema.sql`, 'utf8');
const seed = readFileSync(`${root}/database/seed.sql`, 'utf8');
const ids = Object.keys(RELEASE_EVIDENCE_OVERRIDES).map(Number).sort((a, b) => a - b);
const idList = ids.join(',');

function load(importFile) {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  db.exec(seed);
  db.exec(readFileSync(importFile, 'utf8'));
  return db;
}

const baseline = load(baselineFile);
const fresh = load(freshFile);
const beforeRestrictions = JSON.stringify(baseline.prepare('SELECT * FROM entries ORDER BY version_id,sort_name').all());
const beforeEligible = baseline.prepare('SELECT COUNT(*) AS n FROM cards_cache WHERE pool_verified=1').get().n;

for (const id of ids) {
  assert(!baseline.prepare('SELECT 1 FROM cards_cache WHERE card_id=?').get(id), `Baseline already contains reviewed card ${id}`);
  const card = fresh.prepare('SELECT name,tcg_date,pool_verified FROM cards_cache WHERE card_id=?').get(id);
  assert(card, `Fresh catalogue is missing reviewed card ${id}`);
  assert.equal(card.tcg_date, RELEASE_EVIDENCE_OVERRIDES[id].tcgDate, `${card.name}: reviewed date`);
  assert.equal(card.pool_verified, 1, `${card.name}: pool eligibility`);
}

const quote = (value) => value == null ? 'NULL' : typeof value === 'number' || typeof value === 'bigint'
  ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const statements = [
  '-- Add the reviewed pre-cutoff TCG cards omitted by incomplete upstream release metadata.',
  '-- Repeat-safe and additive: restriction versions, administrators, sessions, events and image ledgers are untouched.',
  'PRAGMA foreign_keys = ON;'
];

function copyRows(table, whereColumn, conflictColumns, chunkSize = 12) {
  const rows = fresh.prepare(`SELECT * FROM ${table} WHERE ${whereColumn} IN (${idList}) ORDER BY ${whereColumn}`).all();
  assert(rows.length, `${table}: no reviewed rows found`);
  const columns = Object.keys(rows[0]);
  const mutable = columns.filter((column) => !conflictColumns.includes(column));
  const conflict = mutable.length
    ? `ON CONFLICT(${conflictColumns.join(',')}) DO UPDATE SET ${mutable.map((column) => `${column}=excluded.${column}`).join(',')}`
    : `ON CONFLICT(${conflictColumns.join(',')}) DO NOTHING`;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const values = rows.slice(index, index + chunkSize)
      .map((row) => `(${columns.map((column) => quote(row[column])).join(',')})`).join(',\n');
    statements.push(`INSERT INTO ${table}(${columns.join(',')}) VALUES\n${values}\n${conflict};`);
  }
  return rows.length;
}

const counts = {
  cards: copyRows('cards_cache', 'card_id', ['card_id']),
  artworks: copyRows('card_artworks', 'canonical_id', ['artwork_id'], 100),
  evidence: copyRows('card_id_evidence', 'canonical_id', ['input_id'], 100),
  search: copyRows('card_name_search', 'card_id', ['search_text', 'card_id'], 150)
};
assert.equal(counts.cards, ids.length);

const revision = `${new Date().toISOString()}-reviewed-release-evidence`;
statements.push(`INSERT INTO catalogue_meta(key,value) VALUES ('revision',${quote(revision)})
  ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
statements.push(`INSERT INTO catalogue_meta(key,value) VALUES ('source','YGOPRODeck API v7 + reviewed TCG release evidence')
  ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
statements.push("UPDATE catalogue_meta SET value=CAST((SELECT COUNT(*) FROM cards_cache WHERE pool_verified=1) AS TEXT) WHERE key='eligible_cards';");
statements.push("UPDATE catalogue_meta SET value=CAST((SELECT COUNT(*) FROM card_artworks) AS TEXT) WHERE key='artwork_ids';");
statements.push("UPDATE catalogue_meta SET value=CAST((SELECT COUNT(*) FROM card_id_evidence) AS TEXT) WHERE key='evidence_cards';");
statements.push(`UPDATE entries SET card_id=(SELECT c.card_id FROM cards_cache c WHERE c.pool_verified=1 AND c.sort_name=entries.sort_name ORDER BY c.card_id LIMIT 1)
  WHERE card_id IS NULL AND 1=(SELECT COUNT(*) FROM cards_cache c WHERE c.pool_verified=1 AND c.sort_name=entries.sort_name);`);
statements.push('DELETE FROM search_cache;');

const migration = `${statements.join('\n\n')}\n`;
baseline.exec(migration);
baseline.exec(migration);
assert.equal(JSON.stringify(baseline.prepare('SELECT * FROM entries ORDER BY version_id,sort_name').all()), beforeRestrictions);
assert.equal(baseline.prepare('SELECT COUNT(*) AS n FROM cards_cache WHERE pool_verified=1').get().n, beforeEligible + ids.length);
assert.equal(baseline.prepare("SELECT COUNT(*) AS n FROM cards_cache WHERE tcg_date>'2025-08-01' OR pool_verified<>1").get().n, 0);
assert.equal(baseline.prepare("SELECT value FROM catalogue_meta WHERE key='eligible_cards'").get().value, String(beforeEligible + ids.length));
assert(baseline.prepare("SELECT 1 FROM card_name_search WHERE search_text='monarchic perfection' AND card_id=59983249").get());
assert.equal(baseline.prepare('SELECT name FROM cards_cache WHERE card_id=98349765').get().name,
  'Layer 19 "Sudden Incursion! Super Quantum Black!!"');

writeFileSync(outputFile, migration, 'utf8');
console.log(JSON.stringify({ outputFile, reviewedCards: ids.length, beforeEligible,
  afterEligible: beforeEligible + ids.length, counts, bytes: Buffer.byteLength(migration),
  largestStatementBytes: Math.max(...statements.map((statement) => Buffer.byteLength(statement))),
  repeatSafe: true, restrictionsUnchanged: true }, null, 2));

