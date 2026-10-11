#!/usr/bin/env node
/**
 * Build an additive D1 SQL import for the verified TCG catalogue.
 * This script never connects to Cloudflare and never changes restriction rows.
 * Run the generated SQL with Wrangler only after reviewing its summary.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CUTOFF = '2025-08-01';
const PAGE_SIZE = 1000;
const MAX_CARDS = 20_000;
const API = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
const output = resolve(process.argv[2] || 'catalogue-import.sql');
const revision = new Date().toISOString();

const normalise = (value = '') => String(value)
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’‘]/g, "'").replace(/[–—]/g, '-')
  .replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
const playable = (raw) => raw?.type && !['Skill Card', 'Token'].includes(raw.type) && raw.name !== '???';
const firstTcgDate = (raw) => raw?.misc_info?.find((item) => typeof item?.tcg_date === 'string')?.tcg_date || null;
const treatedAs = (raw) => raw?.misc_info?.find((item) => typeof item?.treated_as === 'string')?.treated_as || null;
const category = (type = '') => /spell/i.test(type) ? 'Spell' : /trap/i.test(type) ? 'Trap' : 'Monster';
const subtype = (type = '') => {
  if (/spell/i.test(type)) return 'Spell';
  if (/trap/i.test(type)) return 'Trap';
  return ['Fusion', 'Synchro', 'XYZ', 'Link', 'Ritual', 'Pendulum', 'Normal', 'Effect']
    .find((part) => new RegExp(part, 'i').test(type))?.replace('XYZ', 'Xyz') || 'Effect';
};
const placement = (type = '') => /Fusion|Synchro|XYZ|Link/i.test(type) ? 'extra' : 'main';
const checkedId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff ? id : null;
};
const sql = (value) => value == null ? 'NULL' : `'${String(value).replaceAll('\0', '').replaceAll("'", "''")}'`;
const number = (value) => value === null || value === undefined || value === ''
  ? 'NULL' : Number.isFinite(Number(value)) ? String(Number(value)) : 'NULL';
const tuple = (values) => `(${values.join(',')})`;
const statements = [];
const batchedInsert = (table, columns, rows, update, chunkSize) => {
  for (let i = 0; i < rows.length; i += chunkSize) {
    statements.push(`INSERT INTO ${table} (${columns.join(',')}) VALUES\n${rows.slice(i, i + chunkSize).join(',\n')}\n${update};`);
  }
};

const cards = new Map();
let offset = 0;
let expectedTotal = null;
while (offset < (expectedTotal ?? 1)) {
  const url = new URL(API);
  url.searchParams.set('format', 'tcg');
  url.searchParams.set('misc', 'yes');
  url.searchParams.set('num', PAGE_SIZE);
  url.searchParams.set('offset', offset);
  url.searchParams.set('sort', 'name');
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Catalogue page ${offset} failed with HTTP ${response.status}.`);
  const payload = await response.json();
  if (!Array.isArray(payload.data) || !payload.data.length) throw new Error(`Catalogue page ${offset} returned no cards.`);
  expectedTotal ??= Number(payload.meta?.total_rows || payload.data.length);
  if (!Number.isInteger(expectedTotal) || expectedTotal < 1 || expectedTotal > MAX_CARDS)
    throw new Error(`Unexpected catalogue size: ${expectedTotal}.`);
  for (const raw of payload.data) {
    const id = checkedId(raw.id);
    if (id) cards.set(id, raw);
  }
  offset += payload.data.length;
  process.stdout.write(`Fetched ${Math.min(offset, expectedTotal)}/${expectedTotal}\r`);
  if (offset < expectedTotal) await new Promise((done) => setTimeout(done, 100));
}
process.stdout.write('\n');

const cacheRows = [], artworkRows = [], evidenceRows = [];
let eligibleCount = 0, artworkCount = 0, outsidePoolCount = 0, excludedCount = 0;
for (const raw of cards.values()) {
  const canonicalId = checkedId(raw.id);
  const tcgDate = firstTcgDate(raw);
  const dateVerified = /^\d{4}-\d{2}-\d{2}$/.test(tcgDate || '');
  const isPlayable = playable(raw);
  const eligible = isPlayable && dateVerified && tcgDate <= CUTOFF;
  const reason = !isPlayable ? 'not_playable' : !dateVerified ? 'missing_tcg_date' : eligible ? 'eligible' : 'outside_pool';
  if (eligible) eligibleCount += 1;
  else if (reason === 'outside_pool') outsidePoolCount += 1;
  else excludedCount += 1;
  const images = [...new Set((raw.card_images || []).map((image) => checkedId(image.id)).filter(Boolean))];
  if (!images.includes(canonicalId)) images.unshift(canonicalId);
  for (const imageId of images) {
    evidenceRows.push(tuple([imageId, canonicalId, sql(tcgDate), eligible ? 1 : 0, sql(reason), sql(revision)]));
    if (eligible) {
      artworkRows.push(tuple([imageId, canonicalId, imageId === canonicalId ? 1 : 0, sql(revision)]));
      artworkCount += 1;
    }
  }
  if (!eligible) continue;
  const type = String(raw.type || '');
  const treated = treatedAs(raw);
  const imageId = images[0] || canonicalId;
  cacheRows.push(tuple([
    canonicalId, sql(raw.name), sql(normalise(raw.name)), sql(category(type)), sql(subtype(type)), sql(type),
    sql(raw.race || null), sql(raw.attribute || null), number(raw.level), number(raw.atk), number(raw.def),
    sql(raw.desc || ''), sql(`https://images.ygoprodeck.com/images/cards_small/${imageId}.jpg`), canonicalId,
    sql(JSON.stringify(images)), sql(tcgDate), sql(raw.frameType || null), sql(placement(type)), number(raw.linkval),
    number(raw.scale), sql(raw.archetype || null), sql(treated), sql(normalise(treated || raw.name)), 1,
    sql(revision), sql(revision)
  ]));
}

statements.push('PRAGMA foreign_keys = ON;');
statements.push(`INSERT INTO catalogue_meta(key,value) VALUES ('complete','0') ON CONFLICT(key) DO UPDATE SET value='0';`);
batchedInsert('cards_cache', [
  'card_id','name','sort_name','category','subtype','card_type','race','attribute','level','atk','def','description',
  'image_source_url','canonical_id','artwork_ids_json','tcg_date','frame_type','placement','link_rating','pendulum_scale',
  'archetype','treated_as','copy_limit_key','pool_verified','metadata_revision','updated_at'
], cacheRows, `ON CONFLICT(card_id) DO UPDATE SET
name=excluded.name,sort_name=excluded.sort_name,category=excluded.category,subtype=excluded.subtype,
card_type=excluded.card_type,race=excluded.race,attribute=excluded.attribute,level=excluded.level,atk=excluded.atk,
def=excluded.def,description=excluded.description,image_source_url=excluded.image_source_url,
canonical_id=excluded.canonical_id,artwork_ids_json=excluded.artwork_ids_json,tcg_date=excluded.tcg_date,
frame_type=excluded.frame_type,placement=excluded.placement,link_rating=excluded.link_rating,
pendulum_scale=excluded.pendulum_scale,archetype=excluded.archetype,treated_as=excluded.treated_as,
copy_limit_key=excluded.copy_limit_key,pool_verified=1,metadata_revision=excluded.metadata_revision,updated_at=excluded.updated_at`, 12);
batchedInsert('card_artworks', ['artwork_id','canonical_id','is_default','updated_at'], artworkRows,
  'ON CONFLICT(artwork_id) DO UPDATE SET canonical_id=excluded.canonical_id,is_default=excluded.is_default,updated_at=excluded.updated_at', 250);
batchedInsert('card_id_evidence', ['input_id','canonical_id','tcg_date','eligible','reason','updated_at'], evidenceRows,
  'ON CONFLICT(input_id) DO UPDATE SET canonical_id=excluded.canonical_id,tcg_date=excluded.tcg_date,eligible=excluded.eligible,reason=excluded.reason,updated_at=excluded.updated_at', 180);
statements.push(`UPDATE entries SET card_id=(SELECT c.card_id FROM cards_cache c WHERE c.pool_verified=1 AND c.sort_name=entries.sort_name ORDER BY c.card_id LIMIT 1)
WHERE card_id IS NULL AND 1=(SELECT COUNT(*) FROM cards_cache c WHERE c.pool_verified=1 AND c.sort_name=entries.sort_name);`);
for (const [key, value] of Object.entries({
  complete: '1', revision, cutoff: CUTOFF, eligible_cards: String(eligibleCount),
  evidence_cards: String(cards.size), artwork_ids: String(artworkCount), source: 'YGOPRODeck API v7'
})) statements.push(`INSERT INTO catalogue_meta(key,value) VALUES (${sql(key)},${sql(value)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
await writeFile(output, `${statements.join('\n\n')}\n`, 'utf8');
console.log(JSON.stringify({ output, revision, fetched: cards.size, eligible: eligibleCount, artworkIds: artworkCount,
  outsidePool: outsidePoolCount, excluded: excludedCount }, null, 2));
