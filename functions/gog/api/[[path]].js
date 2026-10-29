// GRAVETALE /gog/ house format API for Cloudflare Pages Functions + D1 (+ optional R2).
// The historical card pool is LOCKED to TCG first releases on/before 2025-08-01.
// Frontend paths all live under /gog/; this function only handles /gog/api/*.

import { reviewedCardNameFor, reviewedTcgDateFor } from './release-evidence-overrides.js';

const BASE = '/gog/api';
const CUTOFF = '2025-08-01';
const ALLOWED = new Set(['forbidden', 'limited', 'semi_limited', 'unlimited']);
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW = 15 * 60 * 1000;
// Leave a wide margin below R2's 10 GB monthly free storage allowance.
const IMAGE_CACHE_LIMIT_BYTES = 5_000_000_000;
const IMAGE_MAX_BYTES = Object.freeze({ thumb: 350_000, cover: 900_000, full: 2_000_000 });
// Use only 10% of R2's monthly free operation allowances. Calendar-month
// counters preserve ample headroom even when Cloudflare's billing cycle differs.
const R2_CLASS_A_MONTHLY_LIMIT = 100_000;
const R2_CLASS_B_MONTHLY_LIMIT = 1_000_000;
const IMAGE_CACHE_SECONDS = 30 * 24 * 60 * 60;
const CATALOGUE_PAGE_SIZE = 48;
const MAX_CATALOGUE_PAGE_SIZE = 60;
const MAX_RESOLVE_IDS = 512;
const ASSET_REVISION = '2';
const EXTRA_TYPES = new Set([
  'Fusion Monster', 'Link Monster', 'Pendulum Effect Fusion Monster', 'Synchro Monster',
  'Synchro Pendulum Effect Monster', 'Synchro Tuner Monster', 'XYZ Monster', 'XYZ Pendulum Effect Monster'
]);
const MONSTER_TYPES = [
  'Effect Monster','Flip Effect Monster','Flip Tuner Effect Monster','Gemini Monster','Normal Monster',
  'Normal Tuner Monster','Pendulum Effect Monster','Pendulum Effect Ritual Monster','Pendulum Flip Effect Monster',
  'Pendulum Normal Monster','Pendulum Tuner Effect Monster','Ritual Effect Monster','Ritual Monster','Spirit Monster',
  'Toon Monster','Tuner Monster','Union Effect Monster',...EXTRA_TYPES
];
const loginEncoder = new TextEncoder();
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY'
};

const fail = (status, message) => Object.assign(new Error(message), { status });
const nowIso = () => new Date().toISOString();
const normalise = (value = '') => String(value)
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’‘]/g, "'").replace(/[–—]/g, '-')
  .replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
const searchSuffixes = (value = '') => {
  const words = normalise(value).split(' ').filter(Boolean);
  return words.map((_, index) => words.slice(index).join(' '));
};
const makeId = (length = 32) => {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (value) => value.toString(16).padStart(2, '0')).join('');
};
const sha256 = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', loginEncoder.encode(text))))
  .map((v) => v.toString(16).padStart(2, '0')).join('');
const safeEquals = (a = '', b = '') => {
  const left = String(a), right = String(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return diff === 0;
};
// The browser performs expensive PBKDF2 before login. This HMAC is inexpensive
// in a Cloudflare Free Worker (10 ms CPU budget) and keeps stolen D1 hashes
// unusable without a separate, persistent server-side secret pepper.
const validSalt = (s) => /^[a-f0-9]{32}$/.test(s || '');
const validVerifier = (s) => /^[a-f0-9]{64}$/.test(s || '');
async function passwordStorageHash(verifier, salt, pepper) {
  if (!pepper || String(pepper).length < 32) throw fail(503, 'Cloudflare secret GOG_AUTH_PEPPER is missing or too short. See SETUP.md.');
  const key = await crypto.subtle.importKey('raw', loginEncoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bits = await crypto.subtle.sign('HMAC', key, loginEncoder.encode(`${salt}:${verifier}`));
  return Array.from(new Uint8Array(bits), (v) => v.toString(16).padStart(2, '0')).join('');
}
const cardCopies = (status) => ({ forbidden: 0, limited: 1, semi_limited: 2, unlimited: 3 })[status] ?? 3;
const cardCategory = (type = '') => /spell/i.test(type) ? 'Spell' : /trap/i.test(type) ? 'Trap' : 'Monster';
const cardSubtype = (type = '') => {
  if (/spell/i.test(type)) return 'Spell';
  if (/trap/i.test(type)) return 'Trap';
  return ['Fusion', 'Synchro', 'XYZ', 'Link', 'Ritual', 'Pendulum', 'Normal', 'Effect']
    .find((x) => new RegExp(x, 'i').test(type))?.replace('XYZ', 'Xyz') || 'Effect';
};
const cardPlacement = (type = '') => EXTRA_TYPES.has(type) ? 'extra' : 'main';
const playableType = (type = '') => !!type && type !== 'Skill Card' && type !== 'Token';
const tcgDateFor = reviewedTcgDateFor;
const treatedAsFor = (raw) => raw?.misc_info?.find((info) => typeof info?.treated_as === 'string')?.treated_as || null;
const validCardId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 0xffffffff;
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
function isD1DailyReadLimit(error) {
  const message = String(error?.message || error || '');
  return /D1_ERROR:/i.test(message) && /free tier daily row read limit|code\s*7500/i.test(message);
}
function secondsUntilNextUtcDay() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
function sessionCookie(token, remove = false) {
  return `gog_session=${remove ? '' : token}; Path=/gog/; Secure; HttpOnly; SameSite=Strict; Max-Age=${remove ? 0 : SESSION_SECONDS}`;
}
function parseCookie(request, key) {
  return (request.headers.get('Cookie') || '').split(';').map((item) => item.trim()).map((item) => {
    const eq = item.indexOf('='); return eq < 0 ? [] : [item.slice(0, eq), item.slice(eq + 1)];
  }).find((entry) => entry[0] === key)?.[1] || '';
}
async function inputJson(request) {
  if (Number(request.headers.get('Content-Length') || 0) > 16000) throw fail(413, 'Request too large.');
  const raw = await request.text();
  if (raw.length > 16000) throw fail(413, 'Request too large.');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw fail(400, 'Invalid JSON request.'); }
}
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}
async function sessionFor(db, request) {
  const cookie = parseCookie(request, 'gog_session');
  if (!cookie) return null;
  return await db.prepare(`SELECT s.*, a.email FROM sessions s JOIN admins a ON a.id=s.admin_id
    WHERE s.token_hash=? AND s.expires_at>?`).bind(await sha256(cookie), nowIso()).first();
}
async function requireAdmin(db, request, checkCsrf = false) {
  const session = await sessionFor(db, request);
  if (!session) throw fail(401, 'Administrator login required.');
  if (checkCsrf && (!sameOrigin(request) || !safeEquals(request.headers.get('X-CSRF-Token') || '', session.csrf_token)))
    throw fail(403, 'Invalid session token. Refresh and sign in again.');
  return session;
}
async function newSession(db, adminId) {
  const token = makeId(32), csrf = makeId(24);
  const expires = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await db.prepare(`INSERT INTO sessions(token_hash,admin_id,csrf_token,expires_at,created_at)
    VALUES (?,?,?,?,?)`).bind(await sha256(token), adminId, csrf, expires, nowIso()).run();
  return { token, csrf };
}
function versionView(v) {
  if (!v) return null;
  return { id: v.id, label: v.version_label, effectiveDate: v.effective_date, summary: v.summary, source: v.source, publishedAt: v.published_at };
}
async function currentVersion(db) {
  return db.prepare("SELECT * FROM versions WHERE status='published' ORDER BY id DESC LIMIT 1").first();
}
async function entriesFor(db, versionId) {
  if (!versionId) return [];
  const { results } = await db.prepare(`SELECT name, card_id AS cardId, category, subtype, card_type AS cardType, status, note
    FROM entries WHERE version_id=? ORDER BY sort_name`).bind(versionId).all();
  return results.map((e) => ({ ...e, copies: cardCopies(e.status) }));
}
async function foundationVersion(db) {
  return db.prepare("SELECT * FROM versions WHERE source='tcg-apr-2025' ORDER BY id LIMIT 1").first();
}
function compareEntries(before, after, includeNotes = true) {
  const b = new Map(before.map((e) => [normalise(e.name), e]));
  const a = new Map(after.map((e) => [normalise(e.name), e]));
  return [...new Set([...a.keys(), ...b.keys()])].map((k) => {
    const past = b.get(k), next = a.get(k);
    if (past && next && past.status === next.status && (!includeNotes || (past.note || '') === (next.note || ''))) return null;
    return {
      ...(next || past),
      previousStatus: past?.status || 'unlimited',
      status: next?.status || 'unlimited',
      changeType: !past ? 'restricted' : !next ? 'unrestricted' : past.status === next.status ? 'note_updated' : 'changed'
    };
  }).filter(Boolean).sort((x, y) => x.name.localeCompare(y.name));
}
async function differencesFor(db, beforeId, afterId, includeNotes = true) {
  if (!beforeId || !afterId) return [];
  const [before, after] = await Promise.all([entriesFor(db, beforeId), entriesFor(db, afterId)]);
  return compareEntries(before, after, includeNotes);
}
async function changesFor(db, version) {
  if (!version || !version.previous_version_id) return [];
  return differencesFor(db, version.previous_version_id, version.id, true);
}
async function houseViewFor(db, version) {
  const [baseline, entries] = await Promise.all([foundationVersion(db), entriesFor(db, version?.id)]);
  if (!baseline || !version) return { baseline: versionView(baseline), entries, changes: [] };
  const changes = (await differencesFor(db, baseline.id, version.id, false)).map((entry) => ({
    ...entry,
    baselineStatus: entry.previousStatus,
    isHouseChange: true
  }));
  const byName = new Map(changes.map((entry) => [normalise(entry.name), entry]));
  return {
    baseline: versionView(baseline),
    entries: entries.map((entry) => {
      const change = byName.get(normalise(entry.name));
      return change ? { ...entry, baselineStatus: change.baselineStatus, isHouseChange: true } : entry;
    }),
    changes
  };
}
async function getDraft(db) {
  let draft = await db.prepare("SELECT * FROM versions WHERE status='draft' LIMIT 1").first();
  if (draft) return draft;
  const published = await currentVersion(db);
  if (!published) throw fail(503, 'The JUSH foundation has not been imported into D1. Run database/seed.sql.');
  const created = await db.prepare(`INSERT OR IGNORE INTO versions(version_label,effective_date,summary,status,previous_version_id,source,created_at)
    VALUES ('Draft',?,'','draft',?,'house',?)`).bind(published.effective_date, published.id, nowIso()).run();
  draft = await db.prepare("SELECT * FROM versions WHERE status='draft' LIMIT 1").first();
  // Copy only when the draft is new: an intentionally emptied draft must stay empty.
  if (created.meta?.changes) {
    await db.prepare(`INSERT OR IGNORE INTO entries(version_id,name,sort_name,card_id,category,subtype,card_type,status,note)
      SELECT ?,name,sort_name,card_id,category,subtype,card_type,status,note FROM entries WHERE version_id=?`)
      .bind(draft.id, published.id).run();
  }
  return draft;
}

// Defence in depth: the catalogue may filter on dates, but never trust it alone.
// misc=yes provides the original TCG print date across regions (including
// North America, e.g. BLMM on 2025-06-13). Later regional releases do not
// disqualify a card. OCG dates alone never qualify; fail closed without TCG evidence.
function isJushEligible(raw) {
  const tcgDate = tcgDateFor(raw);
  return playableType(raw?.type) && reviewedCardNameFor(raw) !== '???' && /^\d{4}-\d{2}-\d{2}$/.test(tcgDate || '') && tcgDate <= CUTOFF;
}
function cardFromApi(raw, requestedArtworkId = null) {
  const category = cardCategory(raw.type || '');
  const canonicalId = Number(raw.id);
  const cardName = reviewedCardNameFor(raw);
  const artworkIds = [...new Set((raw.card_images || []).map((image) => Number(image.id)).filter(validCardId))];
  if (!artworkIds.includes(canonicalId)) artworkIds.unshift(canonicalId);
  const artworkId = validCardId(requestedArtworkId) && artworkIds.includes(Number(requestedArtworkId))
    ? Number(requestedArtworkId) : artworkIds[0] || canonicalId;
  const treatedAs = treatedAsFor(raw);
  return {
    id: canonicalId, canonicalId, portableId: canonicalId, artworkId, artworkIds,
    name: cardName, category, subtype: cardSubtype(raw.type || ''),
    cardType: raw.type || '', race: raw.race || null, attribute: raw.attribute || null,
    level: raw.level ?? null, linkRating: raw.linkval ?? null, pendulumScale: raw.scale ?? null,
    atk: raw.atk ?? null, def: raw.def ?? null, description: raw.desc || '',
    archetype: raw.archetype || null, frameType: raw.frameType || null,
    tcgDate: tcgDateFor(raw), placement: cardPlacement(raw.type || ''), treatedAs,
    copyLimitKey: normalise(treatedAs || cardName), poolVerified: isJushEligible(raw),
    imageUrl: `${BASE}/cards/${artworkId}/image?size=thumb&v=${ASSET_REVISION}`,
    fullImageUrl: `${BASE}/cards/${artworkId}/image?size=full&v=${ASSET_REVISION}`
  };
}
function cardStoreStatements(db, card) {
  const updated = nowIso();
  const statements = [db.prepare(`INSERT INTO cards_cache(card_id,name,sort_name,category,subtype,card_type,race,attribute,
      level,atk,def,description,image_source_url,canonical_id,artwork_ids_json,tcg_date,frame_type,placement,
      link_rating,pendulum_scale,archetype,treated_as,copy_limit_key,pool_verified,metadata_revision,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(card_id) DO UPDATE SET name=excluded.name,sort_name=excluded.sort_name,category=excluded.category,
      subtype=excluded.subtype,card_type=excluded.card_type,race=excluded.race,attribute=excluded.attribute,
      level=excluded.level,atk=excluded.atk,def=excluded.def,description=excluded.description,
      image_source_url=excluded.image_source_url,canonical_id=excluded.canonical_id,
      artwork_ids_json=excluded.artwork_ids_json,tcg_date=excluded.tcg_date,frame_type=excluded.frame_type,
      placement=excluded.placement,link_rating=excluded.link_rating,pendulum_scale=excluded.pendulum_scale,
      archetype=excluded.archetype,treated_as=excluded.treated_as,copy_limit_key=excluded.copy_limit_key,
      pool_verified=excluded.pool_verified,metadata_revision=excluded.metadata_revision,updated_at=excluded.updated_at`)
    .bind(card.id, card.name, normalise(card.name), card.category, card.subtype, card.cardType,
      card.race, card.attribute, card.level, card.atk, card.def, card.description,
      `https://images.ygoprodeck.com/images/cards_small/${card.artworkId}.jpg`, card.canonicalId,
      JSON.stringify(card.artworkIds), card.tcgDate, card.frameType, card.placement, card.linkRating,
      card.pendulumScale, card.archetype, card.treatedAs, card.copyLimitKey, card.poolVerified ? 1 : 0,
      updated, updated)];
  if (card.poolVerified) {
    for (const searchText of searchSuffixes(card.name)) {
      statements.push(db.prepare('INSERT OR IGNORE INTO card_name_search(search_text,card_id) VALUES (?,?)')
        .bind(searchText, card.canonicalId));
    }
  }
  for (const artworkId of card.artworkIds) {
    statements.push(db.prepare(`INSERT INTO card_artworks(artwork_id,canonical_id,is_default,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(artwork_id) DO UPDATE SET canonical_id=excluded.canonical_id,is_default=excluded.is_default,updated_at=excluded.updated_at`)
      .bind(artworkId, card.canonicalId, artworkId === card.canonicalId ? 1 : 0, updated));
    statements.push(db.prepare(`INSERT INTO card_id_evidence(input_id,canonical_id,tcg_date,eligible,reason,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(input_id) DO UPDATE SET canonical_id=excluded.canonical_id,tcg_date=excluded.tcg_date,
      eligible=excluded.eligible,reason=excluded.reason,updated_at=excluded.updated_at`)
      .bind(artworkId, card.canonicalId, card.tcgDate, card.poolVerified ? 1 : 0,
        card.poolVerified ? 'eligible' : 'outside_pool', updated));
  }
  return statements;
}
async function storeCard(db, card) {
  await db.batch(cardStoreStatements(db, card));
}
function cachedCardView(row, requestedArtworkId = null) {
  let artworkIds = [];
  try { artworkIds = JSON.parse(row.artwork_ids_json || '[]').map(Number).filter(validCardId); } catch { artworkIds = []; }
  const canonicalId = Number(row.canonical_id || row.card_id);
  if (!artworkIds.includes(canonicalId)) artworkIds.unshift(canonicalId);
  const artworkId = validCardId(requestedArtworkId) && artworkIds.includes(Number(requestedArtworkId))
    ? Number(requestedArtworkId) : artworkIds[0] || canonicalId;
  return { id: canonicalId, canonicalId, portableId: canonicalId, artworkId, artworkIds,
    name: row.name, category: row.category, subtype: row.subtype,
    cardType: row.card_type, race: row.race, attribute: row.attribute, level: row.level, atk: row.atk,
    def: row.def, description: row.description, linkRating: row.link_rating ?? null,
    pendulumScale: row.pendulum_scale ?? null, archetype: row.archetype || null,
    frameType: row.frame_type || null, tcgDate: row.tcg_date || null,
    placement: row.placement || cardPlacement(row.card_type), treatedAs: row.treated_as || null,
    copyLimitKey: row.copy_limit_key || normalise(row.treated_as || row.name), poolVerified: row.pool_verified === 1,
    imageUrl: `${BASE}/cards/${artworkId}/image?size=thumb&v=${ASSET_REVISION}`,
    fullImageUrl: `${BASE}/cards/${artworkId}/image?size=full&v=${ASSET_REVISION}` };
}
async function ygoRequest(params, { cutoff = true } = {}) {
  const url = new URL('https://db.ygoprodeck.com/api/v7/cardinfo.php');
  // Current format membership can omit historical TCG cards. Original TCG
  // release metadata, checked by isJushEligible, is our eligibility authority.
  url.searchParams.set('misc', 'yes');
  if (cutoff) {
    url.searchParams.set('enddate', CUTOFF);
    url.searchParams.set('dateregion', 'tcg');
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const result = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
  if (result.status === 400 || result.status === 404) return { data: [], meta: null };
  if (!result.ok) throw fail(503, 'Card catalogue temporarily unavailable. Try again shortly.');
  const payload = await result.json();
  return { data: Array.isArray(payload.data) ? payload.data : [], meta: payload.meta || null };
}
const ygoFetch = async (params, options) => (await ygoRequest(params, options)).data;
async function catalogueComplete(db) {
  const row = await db.prepare("SELECT value FROM catalogue_meta WHERE key='complete'").first();
  return row?.value === '1';
}
async function localSearch(db, query) {
  const key = normalise(query);
  const upper = `${key}\uffff`;
  const like = `%${key.replace(/[%_\\]/g, '\\$&')}%`;
  const [cached, foundation] = await Promise.all([
    db.prepare(`SELECT DISTINCT c.* FROM card_name_search s CROSS JOIN cards_cache c ON c.card_id=s.card_id
      WHERE c.pool_verified=1 AND s.search_text>=? AND s.search_text<?
      ORDER BY CASE WHEN c.sort_name=? THEN 0 ELSE 1 END,c.sort_name LIMIT 25`).bind(key, upper, key).all(),
    db.prepare(`SELECT name,card_id AS id,category,subtype,card_type AS cardType FROM entries
      WHERE version_id=(SELECT id FROM versions WHERE source='tcg-apr-2025' ORDER BY id LIMIT 1)
      AND sort_name LIKE ? ESCAPE '\\' ORDER BY sort_name LIMIT 25`).bind(like).all()
  ]);
  const combined = new Map();
  for (const row of cached.results) combined.set(normalise(row.name), cachedCardView(row));
  for (const row of foundation.results) if (!combined.has(normalise(row.name))) combined.set(normalise(row.name), row);
  return [...combined.values()].slice(0, 20);
}
async function cardSearch(db, query) {
  const trimmed = query.trim().slice(0, 80);
  const key = normalise(trimmed);
  if (key.length < 2) return [];
  const hit = await db.prepare('SELECT results_json FROM search_cache WHERE query=? AND expires_at>?')
    .bind(key, nowIso()).first();
  if (hit) return JSON.parse(hit.results_json);
  const local = await localSearch(db, trimmed);
  if (await catalogueComplete(db)) return local.slice(0, 20);
  let results = [];
  try {
    const rawCards = await ygoFetch({ fname: trimmed, num: 30, offset: 0 });
    results = rawCards.filter((raw) => isJushEligible(raw) && raw.id && raw.name)
      .slice(0, 20).map(cardFromApi);
    if (results.length) {
      await db.batch(results.flatMap((card) => cardStoreStatements(db, card)));
    }
    await db.prepare('INSERT INTO search_cache(query,results_json,expires_at) VALUES(?,?,?) ON CONFLICT(query) DO UPDATE SET results_json=excluded.results_json,expires_at=excluded.expires_at')
      .bind(key, JSON.stringify(results), new Date(Date.now() + 48 * 3600_000).toISOString()).run();
  } catch (error) {
    if (error.status && error.status !== 503) throw error;
    results = await localSearch(db, query);
  }
  return results;
}
async function cardById(db, cardId) {
  const local = await db.prepare(`SELECT c.* FROM card_artworks a JOIN cards_cache c ON c.card_id=a.canonical_id
    WHERE a.artwork_id=? AND c.pool_verified=1 LIMIT 1`).bind(Number(cardId)).first();
  if (local) return cachedCardView(local, cardId);
  const rows = await ygoFetch({ id: cardId });
  // Artwork aliases resolve only when the provider explicitly lists the requested ID.
  const raw = rows.find((row) => Number(row.id) === Number(cardId) ||
    row.card_images?.some((image) => Number(image.id) === Number(cardId)));
  if (!raw || !isJushEligible(raw)) return null;
  const card = cardFromApi(raw, cardId);
  await storeCard(db, card);
  return card;
}
function restrictionStatus(map, card) {
  const keys = [normalise(card.name), normalise(card.treatedAs || ''), card.copyLimitKey].filter(Boolean);
  return keys.map((key) => map.get(key)).filter(Boolean)
    .sort((a, b) => cardCopies(a) - cardCopies(b))[0] || 'unlimited';
}
async function restrictionMapForKeys(db, versionId, keys) {
  if (!versionId || !keys.length) return new Map();
  const map = new Map();
  for (const group of chunks(keys, 80)) {
    const { results } = await db.prepare(`SELECT sort_name,status FROM entries
      WHERE version_id=? AND sort_name IN (${group.map(() => '?').join(',')})`).bind(versionId, ...group).all();
    for (const entry of results) map.set(entry.sort_name, entry.status);
  }
  return map;
}
async function statusesFor(db, cards, capturedVersion = null, includeBaseline = true) {
  if (!cards.length) return [];
  const keys = [...new Set(cards.flatMap((card) =>
    [normalise(card.name), normalise(card.treatedAs || ''), card.copyLimitKey].filter(Boolean)))];
  const [current, baseline] = await Promise.all([
    capturedVersion || currentVersion(db), includeBaseline ? foundationVersion(db) : null
  ]);
  const [map, baselineMap] = await Promise.all([
    restrictionMapForKeys(db, current?.id, keys),
    includeBaseline ? restrictionMapForKeys(db, baseline?.id, keys) : new Map()
  ]);
  return cards.map((c) => {
    const status = restrictionStatus(map, c);
    if (!includeBaseline) return { ...c, status, copies: cardCopies(status) };
    const baselineStatus = restrictionStatus(baselineMap, c);
    return { ...c, status, copies: cardCopies(status), baselineStatus, isHouseChange: status !== baselineStatus };
  });
}
async function catalogueMeta(db) {
  const { results } = await db.prepare('SELECT key,value FROM catalogue_meta').all();
  return Object.fromEntries(results.map((row) => [row.key, row.value]));
}
function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
async function cataloguePage(db, url) {
  const version = await currentVersion(db);
  if (!version) throw fail(503, 'The published house list is unavailable.');
  const query = normalise((url.searchParams.get('q') || '').slice(0, 80));
  const category = url.searchParams.get('category') || '';
  const subtype = url.searchParams.get('subtype') || '';
  const attribute = (url.searchParams.get('attribute') || '').toUpperCase();
  const archetype = (url.searchParams.get('archetype') || '').trim().slice(0, 80);
  const level = url.searchParams.get('level');
  const link = url.searchParams.get('link');
  const statuses = (url.searchParams.get('status') || '').split(',').filter((item) => ALLOWED.has(item));
  const limit = boundedInteger(url.searchParams.get('limit'), CATALOGUE_PAGE_SIZE, 1, MAX_CATALOGUE_PAGE_SIZE);
  const page = boundedInteger(url.searchParams.get('page'), 0, 0, 500);
  if (category && !['Monster','Spell','Trap'].includes(category)) throw fail(400, 'Invalid card category filter.');
  if (attribute && !['DARK','DIVINE','EARTH','FIRE','LIGHT','WATER','WIND'].includes(attribute))
    throw fail(400, 'Invalid attribute filter.');
  const clauses = ['c.pool_verified=1'];
  const bindings = [];
  if (query) {
    clauses.push('search.search_text>=? AND search.search_text<?');
    bindings.push(query, `${query}\uffff`);
  }
  if (category) { clauses.push('c.category=?'); bindings.push(category); }
  if (subtype) { clauses.push('c.subtype=?'); bindings.push(subtype.slice(0, 40)); }
  if (attribute) { clauses.push('c.attribute=?'); bindings.push(attribute); }
  if (archetype) { clauses.push("c.archetype LIKE ? ESCAPE '\\'"); bindings.push(`%${archetype.replace(/[%_\\]/g, '\\$&')}%`); }
  if (level !== null && level !== '') { clauses.push('c.level=?'); bindings.push(boundedInteger(level, -1, 0, 13)); }
  if (link !== null && link !== '') { clauses.push('c.link_rating=?'); bindings.push(boundedInteger(link, -1, 0, 8)); }
  // Resolve both possible restriction keys through indexed primary-key lookups.
  // The former correlated OR subquery scanned the restriction list for every
  // catalogue row and could consume millions of D1 row reads per page load.
  const statusExpr = `CASE
    WHEN name_entry.status='forbidden' OR copy_entry.status='forbidden' THEN 'forbidden'
    WHEN name_entry.status='limited' OR copy_entry.status='limited' THEN 'limited'
    WHEN name_entry.status='semi_limited' OR copy_entry.status='semi_limited' THEN 'semi_limited'
    ELSE 'unlimited' END`;
  const restrictionJoins = `LEFT JOIN entries name_entry ON name_entry.version_id=? AND name_entry.sort_name=c.sort_name
    LEFT JOIN entries copy_entry ON copy_entry.version_id=? AND copy_entry.sort_name=c.copy_limit_key`;
  const selectBindings = [version.id, version.id];
  if (statuses.length) {
    clauses.push(`${statusExpr} IN (${statuses.map(() => '?').join(',')})`);
    bindings.push(...statuses);
  }
  let order = 'c.sort_name';
  const orderBindings = [];
  if (query) {
    order = 'CASE WHEN c.sort_name=? THEN 0 WHEN c.sort_name>=? AND c.sort_name<? THEN 1 ELSE 2 END,c.sort_name';
    orderBindings.push(query, query, `${query}\uffff`);
  }
  // CROSS JOIN preserves the indexed search table as the outer loop. SQLite may
  // otherwise start with all eligible cards before applying the narrow range.
  const source = query ? 'card_name_search search CROSS JOIN cards_cache c ON c.card_id=search.card_id' : 'cards_cache c';
  const distinct = query ? 'DISTINCT ' : '';
  const { results } = await db.prepare(`SELECT ${distinct}c.*,${statusExpr} AS house_status FROM ${source} ${restrictionJoins}
    WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...selectBindings, ...bindings, ...orderBindings, limit + 1, page * limit).all();
  const hasMore = results.length > limit;
  const cards = results.slice(0, limit).map((row) => ({ ...cachedCardView(row), status: row.house_status,
    copies: cardCopies(row.house_status) }));
  const meta = await catalogueMeta(db);
  return { cards, page, pageSize: limit, hasMore, query, catalogue: {
    complete: meta.complete === '1', revision: meta.revision || null,
    eligibleCards: Number(meta.eligible_cards || 0) || null, source: meta.source || null
  }, version: versionView(version) };
}
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
async function evidenceForIds(db, ids) {
  const byId = new Map();
  for (const group of chunks([...new Set(ids)], 80)) {
    if (!group.length) continue;
    const { results } = await db.prepare(`SELECT ev.input_id,ev.canonical_id AS evidence_canonical_id,
      ev.tcg_date AS evidence_tcg_date,ev.eligible,ev.reason,c.* FROM card_id_evidence ev
      LEFT JOIN cards_cache c ON c.card_id=ev.canonical_id AND c.pool_verified=1
      WHERE ev.input_id IN (${group.map(() => '?').join(',')})`).bind(...group).all();
    for (const row of results) byId.set(Number(row.input_id), row);
  }
  return byId;
}
async function storeRawEvidence(db, raw) {
  const canonicalId = Number(raw.id), tcgDate = tcgDateFor(raw);
  const eligible = isJushEligible(raw);
  const reason = !playableType(raw.type) || raw.name === '???' ? 'not_playable'
    : !/^\d{4}-\d{2}-\d{2}$/.test(tcgDate || '') ? 'metadata_unavailable'
      : eligible ? 'eligible' : 'outside_pool';
  const ids = [...new Set([canonicalId, ...(raw.card_images || []).map((image) => Number(image.id))].filter(validCardId))];
  const updated = nowIso();
  await db.batch(ids.map((inputId) => db.prepare(`INSERT INTO card_id_evidence(input_id,canonical_id,tcg_date,eligible,reason,updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(input_id) DO UPDATE SET canonical_id=excluded.canonical_id,
    tcg_date=excluded.tcg_date,eligible=excluded.eligible,reason=excluded.reason,updated_at=excluded.updated_at`)
    .bind(inputId, canonicalId, tcgDate, eligible ? 1 : 0, reason, updated)));
  if (eligible) await storeCard(db, cardFromApi(raw));
}
async function resolveCardIds(db, inputIds, { allowUpstream = true, version = null, includeBaseline = true } = {}) {
  const ids = inputIds.map(Number);
  if (!ids.length || ids.length > MAX_RESOLVE_IDS || ids.some((id) => !validCardId(id)))
    throw fail(400, `Provide between 1 and ${MAX_RESOLVE_IDS} positive numeric card IDs.`);
  let evidence = await evidenceForIds(db, ids);
  const missing = [...new Set(ids.filter((id) => !evidence.has(id)))];
  const complete = await catalogueComplete(db);
  let upstreamUnavailable = false;
  if (missing.length && allowUpstream && !complete) {
    try {
      for (const group of chunks(missing, 40)) {
        const rawCards = await ygoFetch({ id: group.join(',') }, { cutoff: false });
        for (const raw of rawCards) await storeRawEvidence(db, raw);
      }
      evidence = await evidenceForIds(db, ids);
    } catch { upstreamUnavailable = true; }
  }
  const resolvedCards = [];
  const preliminary = ids.map((inputId) => {
    const row = evidence.get(inputId);
    if (!row) return { inputId, outcome: upstreamUnavailable || !complete ? 'metadata_unavailable' : 'unknown_id' };
    if (!row.eligible) return { inputId, outcome: row.reason || 'outside_pool', canonicalId: row.evidence_canonical_id || null,
      tcgDate: row.evidence_tcg_date || null };
    if (!row.card_id) return { inputId, outcome: 'metadata_unavailable', canonicalId: row.evidence_canonical_id || null };
    const card = cachedCardView(row, inputId);
    resolvedCards.push(card);
    return { inputId, outcome: 'resolved', card };
  });
  const statusCards = await statusesFor(db, resolvedCards, version, includeBaseline);
  let cardIndex = 0;
  return preliminary.map((result) => result.outcome === 'resolved'
    ? { inputId: result.inputId, outcome: 'resolved', canonicalId: statusCards[cardIndex].canonicalId,
      artworkId: result.inputId, card: statusCards[cardIndex++] }
    : result);
}
async function publishedRestrictionHash(version) {
  // Published versions are immutable; their ID and publication timestamp form a
  // stable revision token without rereading every restriction on each edit.
  return sha256(JSON.stringify({ id: version.id, publishedAt: version.published_at }));
}
async function validateDeck(db, body) {
  const version = await currentVersion(db);
  if (!version) throw fail(503, 'The published house list is unavailable.');
  const zones = {};
  const flat = [];
  for (const zone of ['main','extra','side']) {
    if (!Array.isArray(body?.[zone])) throw fail(400, `Missing ${zone} deck section.`);
    zones[zone] = body[zone].map((value, index) => {
      const raw = typeof value === 'object' && value ? (value.originalImportId ?? value.canonicalId) : value;
      const inputId = Number(raw);
      const item = { zone, index, inputId };
      flat.push(item);
      return item;
    });
  }
  if (flat.length > MAX_RESOLVE_IDS) throw fail(413, `Deck validation is limited to ${MAX_RESOLVE_IDS} entries.`);
  const validIds = flat.filter((item) => validCardId(item.inputId)).map((item) => item.inputId);
  const resolved = validIds.length ? await resolveCardIds(db, validIds, { version, includeBaseline: false }) : [];
  let resolvedIndex = 0;
  const issues = [];
  for (const item of flat) {
    if (!validCardId(item.inputId)) {
      item.outcome = 'unknown_id';
      issues.push({ code: 'unknown_id', zone: item.zone, index: item.index, message: 'This entry has no valid numeric card ID.' });
      continue;
    }
    Object.assign(item, resolved[resolvedIndex++]);
    if (item.outcome !== 'resolved') issues.push({ code: item.outcome, inputId: item.inputId,
      zone: item.zone, index: item.index, message: item.outcome === 'outside_pool'
        ? `Card ${item.inputId} was first released after ${CUTOFF}.`
        : item.outcome === 'not_playable' ? `Card ${item.inputId} is not a playable TCG deck card.`
          : item.outcome === 'metadata_unavailable' ? `Card ${item.inputId} could not be verified.`
            : `Card ${item.inputId} is unknown.` });
  }
  const sectionLimits = { main: [40,60], extra: [0,15], side: [0,15] };
  for (const [zone, [minimum, maximum]] of Object.entries(sectionLimits)) {
    const count = zones[zone].length;
    if (count < minimum) issues.push({ code: 'deck_size', zone, count, minimum, maximum,
      message: `${zone === 'main' ? 'Main Deck' : zone === 'extra' ? 'Extra Deck' : 'Side Deck'} has ${count}; minimum is ${minimum}.` });
    if (count > maximum) issues.push({ code: 'deck_size', zone, count, minimum, maximum,
      message: `${zone === 'main' ? 'Main Deck' : zone === 'extra' ? 'Extra Deck' : 'Side Deck'} has ${count}; maximum is ${maximum}.` });
  }
  const groups = new Map();
  for (const item of flat.filter((entry) => entry.outcome === 'resolved')) {
    const card = item.card;
    if (card.copies === 0) issues.push({ code: 'forbidden', zone: item.zone,
      index: item.index, inputId: item.inputId, canonicalId: card.canonicalId, name: card.name,
      message: `${card.name} is Forbidden in the published house list.` });
    if (item.zone !== 'side' && card.placement !== item.zone) issues.push({ code: 'wrong_section', zone: item.zone,
      index: item.index, inputId: item.inputId, canonicalId: card.canonicalId, name: card.name,
      message: `${card.name} belongs in the ${card.placement === 'extra' ? 'Extra' : 'Main'} Deck.` });
    const key = card.copyLimitKey || normalise(card.name);
    const group = groups.get(key) || { key, name: card.treatedAs || card.name, count: 0, allowed: card.copies, items: [] };
    group.count += 1;
    group.allowed = Math.min(group.allowed, card.copies);
    group.items.push(item);
    groups.set(key, group);
  }
  for (const group of groups.values()) if (group.count > group.allowed) issues.push({ code: 'too_many_copies',
    copyLimitKey: group.key, name: group.name, count: group.count, allowed: group.allowed,
    message: `${group.name} allows ${group.allowed} ${group.allowed === 1 ? 'copy' : 'copies'} across Main, Extra and Side; this deck has ${group.count}.` });
  const metadataUnavailable = issues.some((issue) => issue.code === 'metadata_unavailable');
  const meta = await catalogueMeta(db);
  return {
    verified: !metadataUnavailable && meta.complete === '1',
    legal: issues.length === 0 && !metadataUnavailable && meta.complete === '1',
    checkedAt: nowIso(), version: versionView(version), restrictionHash: await publishedRestrictionHash(version),
    poolRevision: meta.revision || null, catalogueComplete: meta.complete === '1',
    counts: Object.fromEntries(Object.entries(zones).map(([zone, values]) => [zone, values.length])),
    issues, cards: flat.map((item) => ({ zone: item.zone, index: item.index, inputId: item.inputId,
      outcome: item.outcome, canonicalId: item.canonicalId || item.card?.canonicalId || null,
      artworkId: item.artworkId || null, card: item.card || null }))
  };
}
async function reserveR2Operation(db, operationClass) {
  const classA = operationClass === 'A';
  const column = classA ? 'class_a_operations' : 'class_b_operations';
  const limit = classA ? R2_CLASS_A_MONTHLY_LIMIT : R2_CLASS_B_MONTHLY_LIMIT;
  const initialA = classA ? 1 : 0;
  const initialB = classA ? 0 : 1;
  const month = nowIso().slice(0, 7);
  try {
    const row = await db.prepare(`INSERT INTO r2_operation_usage
      (usage_month,class_a_operations,class_b_operations,updated_at)
      VALUES (?,?,?,?)
      ON CONFLICT(usage_month) DO UPDATE SET ${column}=${column}+1,updated_at=excluded.updated_at
      WHERE ${column} < ?
      RETURNING ${column} AS used`)
      .bind(month, initialA, initialB, nowIso(), limit).first();
    return !!row;
  } catch {
    // If usage cannot be accounted for, fail closed and avoid the R2 operation.
    return false;
  }
}
function cardImageResponse(body, cacheState) {
  return new Response(body, { headers: {
    'Content-Type': 'image/jpeg',
    'Cache-Control': `public, max-age=${IMAGE_CACHE_SECONDS}, immutable`,
    'X-Content-Type-Options': 'nosniff',
    'X-GOG-Image-Cache': cacheState
  } });
}
function edgeImageKey(request) {
  const input = new URL(request.url);
  const url = new URL(input.origin + input.pathname);
  const size = input.searchParams.get('size');
  const revision = input.searchParams.get('v');
  if (size) url.searchParams.set('size', size);
  if (revision) url.searchParams.set('v', revision);
  return new Request(url.toString(), { method: 'GET' });
}
async function edgeImageMatch(request) {
  const cache = globalThis.caches?.default;
  if (!cache) return null;
  try {
    const response = await cache.match(edgeImageKey(request));
    if (!response) return null;
    const headers = new Headers(response.headers);
    headers.set('X-GOG-Image-Cache', 'edge');
    return new Response(response.body, { status: response.status, headers });
  } catch { return null; }
}
async function storeEdgeImage(request, response) {
  const cache = globalThis.caches?.default;
  if (!cache) return;
  try {
    await cache.put(edgeImageKey(request), response.clone());
  } catch { /* R2 and browser caching still work if edge caching is unavailable. */ }
}
async function imageFor(context, id) {
  const db = context.env.GOG_DB;
  const validId = Number(id);
  const url = new URL(context.request.url);
  const size = url.searchParams.get('size') || 'thumb';
  const versioned = url.searchParams.get('v') === ASSET_REVISION;
  const failure = (status, cacheState = null) => versioned ? imageFailure(status, cacheState) : placeholderImage(cacheState);
  if (!validCardId(validId) || !['thumb','cover','full'].includes(size)) return failure(400);
  const edgeHit = await edgeImageMatch(context.request);
  if (edgeHit) return edgeHit;
  // Image requests for unknown / post-cutoff IDs never reach the image host.
  const cached = await db.prepare(`SELECT a.artwork_id FROM card_artworks a JOIN cards_cache c ON c.card_id=a.canonical_id
    WHERE a.artwork_id=? AND c.pool_verified=1 LIMIT 1`).bind(validId).first();
  if (!cached || !context.env.GOG_IMAGES) return failure(cached ? 503 : 404, cached ? 'binding-missing' : 'unknown-card');
  const bucketPrefix = size === 'full' ? 'cards' : size === 'cover' ? 'cards-cropped' : 'cards-small';
  const providerPrefix = size === 'full' ? 'cards' : size === 'cover' ? 'cards_cropped' : 'cards_small';
  const key = `${bucketPrefix}/${validId}.jpg`;
  if (!await reserveR2Operation(db, 'B')) return failure(503, 'operation-limit');
  let object;
  try { object = await context.env.GOG_IMAGES.get(key); }
  catch { return failure(503, 'r2-error'); }
  if (object) {
    try {
      const accounting = await db.prepare(`SELECT
        (SELECT 1 FROM image_cache_v2 WHERE asset_key=? LIMIT 1) AS ledgered,
        (SELECT size_bytes FROM image_cache_reservations WHERE asset_key=? LIMIT 1) AS reserved_bytes`)
        .bind(key, key).first();
      const objectBytes = Number(object.size || accounting?.reserved_bytes || 0);
      if (!accounting?.ledgered && Number.isFinite(objectBytes) && objectBytes > 0) {
        await db.batch([
          db.prepare('DELETE FROM image_cache_reservations WHERE asset_key=?').bind(key),
          db.prepare(`INSERT INTO image_cache_v2(asset_key,card_id,variant,size_bytes,cached_at)
            VALUES (?,?,?,?,?) ON CONFLICT(asset_key) DO UPDATE SET size_bytes=excluded.size_bytes,cached_at=excluded.cached_at`)
            .bind(key, validId, size, objectBytes, nowIso())
        ]);
      }
    } catch { /* Keep serving a confirmed R2 object; its reservation remains conservatively counted. */ }
  }
  if (!object) {
    try {
      const response = await fetch(`https://images.ygoprodeck.com/images/${providerPrefix}/${validId}.jpg`, { signal: AbortSignal.timeout(9000) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return failure(response.status === 404 ? 404 : 503, 'upstream-error');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > IMAGE_MAX_BYTES[size]) return failure(502, 'image-too-large');
      let cacheState = 'bypass-limit';
      try {
        // The conditional insert and counter trigger are one atomic statement.
        // Reserve bytes before touching R2, including concurrent cache misses.
        const token = crypto.randomUUID();
        const reserved = await db.prepare(`INSERT OR IGNORE INTO image_cache_reservations
          (asset_key,size_bytes,token,created_at) SELECT ?,?,?,?
          WHERE (SELECT size_bytes FROM image_storage_usage WHERE id=1) <= ?
          RETURNING token`)
          .bind(key, bytes.byteLength, token, nowIso(), IMAGE_CACHE_LIMIT_BYTES - bytes.byteLength).first();
        if (reserved) {
          if (await reserveR2Operation(db, 'A')) {
            await context.env.GOG_IMAGES.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
            // A failed batch rolls back both statements, retaining the reservation
            // for an object that may already exist. Never undercount uncertain writes.
            await db.batch([
              db.prepare('DELETE FROM image_cache_reservations WHERE asset_key=? AND token=?').bind(key, token),
              db.prepare(`INSERT INTO image_cache_v2(asset_key,card_id,variant,size_bytes,cached_at)
                VALUES (?,?,?,?,?) ON CONFLICT(asset_key) DO UPDATE SET size_bytes=excluded.size_bytes,cached_at=excluded.cached_at`)
                .bind(key, validId, size, bytes.byteLength, nowIso())
            ]);
            cacheState = 'stored';
          } else {
            // No upload was attempted, so these reserved bytes can safely be released.
            await db.prepare('DELETE FROM image_cache_reservations WHERE asset_key=? AND token=?').bind(key, token).run();
            cacheState = 'bypass-operation-limit';
          }
        }
      } catch { cacheState = 'bypass-error'; }
      const result = cardImageResponse(bytes, cacheState);
      await storeEdgeImage(context.request, result);
      return result;
    } catch { return failure(503, 'upstream-error'); }
  }
  const result = cardImageResponse(object.body, 'hit');
  await storeEdgeImage(context.request, result);
  return result;
}
function imageFailure(status, cacheState = null) {
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' };
  if (cacheState) headers['X-GOG-Image-Cache'] = cacheState;
  return new Response('Card image unavailable.', { status, headers });
}
function placeholderImage(cacheState = null) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 421 614"><rect width="421" height="614" fill="#182033"/><rect x="20" y="20" width="381" height="574" rx="16" fill="#222d45" stroke="#c8a85b" stroke-width="4"/><circle cx="210" cy="280" r="82" fill="none" stroke="#c8a85b" stroke-width="8" opacity=".75"/><path d="M210 192l24 64 68 4-53 43 17 66-56-37-56 37 17-66-53-43 68-4z" fill="#c8a85b" opacity=".7"/><text x="210" y="430" text-anchor="middle" font-family="system-ui" font-size="22" fill="#f3ead2">CARD IMAGE</text></svg>`;
  const headers = { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
  if (cacheState) headers['X-GOG-Image-Cache'] = cacheState;
  return new Response(svg, { headers });
}
async function applyEntry(db, versionId, card, status, note) {
  const key = normalise(card.name);
  if (status === 'unlimited') {
    await db.prepare('DELETE FROM entries WHERE version_id=? AND sort_name=?').bind(versionId, key).run();
    return;
  }
  await db.prepare(`INSERT INTO entries(version_id,name,sort_name,card_id,category,subtype,card_type,status,note)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(version_id,sort_name) DO UPDATE SET
    name=excluded.name,card_id=excluded.card_id,category=excluded.category,subtype=excluded.subtype,
    card_type=excluded.card_type,status=excluded.status,note=excluded.note`)
    .bind(versionId, card.name, key, card.id || null, card.category, card.subtype,
      card.cardType || `${card.category}/${card.subtype}`, status, note).run();
}
async function loginThrottled(db, request, email) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = await sha256(`${ip}/${normalise(email)}`);
  const row = await db.prepare('SELECT * FROM auth_attempts WHERE key_hash=?').bind(key).first();
  if (row && Date.now() - Date.parse(row.window_start) < LOGIN_WINDOW && row.attempts >= 8) {
    throw fail(429, 'Too many login attempts. Try again in 15 minutes.');
  }
  if (row && Date.now() - Date.parse(row.window_start) < LOGIN_WINDOW)
    await db.prepare('UPDATE auth_attempts SET attempts=attempts+1 WHERE key_hash=?').bind(key).run();
  else await db.prepare('INSERT INTO auth_attempts(key_hash,attempts,window_start) VALUES(?,?,?) ON CONFLICT(key_hash) DO UPDATE SET attempts=1,window_start=excluded.window_start')
    .bind(key, 1, nowIso()).run();
}
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
function checkedStatus(status) {
  if (!ALLOWED.has(status)) throw fail(400, 'Invalid card restriction status.');
  return status;
}
const EVENT_STATUSES = new Set(['scheduled', 'cancelled']);
const EVENT_TIME = /^(?:|(?:[01]\d|2[0-3]):[0-5]\d)$/;
function londonNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
function londonToday() { return londonNow().date; }
function addCalendarDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function weekdayFor(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
function nextWeekday(date, targetWeekday) {
  return addCalendarDays(date, (Number(targetWeekday) - weekdayFor(date) + 7) % 7);
}
function firstDayOfNextMonth(date) {
  const [year, month] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}
function lastWeekdayOfMonth(date, targetWeekday) {
  const [year, month] = date.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0));
  last.setUTCDate(last.getUTCDate() - (last.getUTCDay() - Number(targetWeekday) + 7) % 7);
  return last.toISOString().slice(0, 10);
}
function isHouseFormatDate(date, startsOn = '') {
  return (!startsOn || date >= startsOn) && date === lastWeekdayOfMonth(date, 4);
}
function nextHouseFormatDates(date, startsOn = '', count = 6) {
  const firstEligibleDate = startsOn && date < startsOn ? startsOn : date;
  const dates = [];
  let cursor = firstEligibleDate;
  while (dates.length < count) {
    const candidate = lastWeekdayOfMonth(cursor, 4);
    if (candidate >= firstEligibleDate) dates.push(candidate);
    cursor = firstDayOfNextMonth(cursor);
  }
  return dates;
}
function nextAdvancedDates(date, count = 8, houseStartsOn = '') {
  const dates = [];
  for (let eventDate = nextWeekday(date, 4); dates.length < count; eventDate = addCalendarDays(eventDate, 7)) {
    if (!isHouseFormatDate(eventDate, houseStartsOn)) dates.push(eventDate);
  }
  return dates;
}
function upcomingDatesForSeries(date, series, houseStartsOn = '') {
  if (series.recurrencePattern === 'weekly_except_last' || series.slug === 'yugioh-advanced-thursday')
    return nextAdvancedDates(date, 8, houseStartsOn);
  if (series.recurrencePattern === 'last' || series.slug === 'yugioh-house-friday')
    return nextHouseFormatDates(date, houseStartsOn, 6);
  return [nextWeekday(date, series.weekday)];
}
function eventHasEnded(event, now) {
  if (event.eventDate < now.date) return true;
  if (event.eventDate > now.date) return false;
  return !!event.endTime && now.time >= event.endTime;
}
function eventValues(body, fallback = {}) {
  const title = String(body.title ?? fallback.title ?? '').trim().slice(0, 120);
  const eventDate = String(body.eventDate ?? fallback.eventDate ?? '').trim();
  const startTime = String(body.startTime ?? fallback.startTime ?? '').trim();
  const endTime = String(body.endTime ?? fallback.endTime ?? '').trim();
  const location = String(body.location ?? fallback.location ?? 'Guild of Games, Rotherham').trim().slice(0, 180);
  const description = String(body.description ?? fallback.description ?? '').trim().slice(0, 1200);
  const status = String(body.status ?? fallback.status ?? 'scheduled');
  if (!title) throw fail(400, 'Event title is required.');
  const parsedDate = new Date(`${eventDate}T00:00:00Z`);
  if (!VALID_DATE.test(eventDate) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== eventDate)
    throw fail(400, 'A valid event date is required.');
  if (!EVENT_TIME.test(startTime) || !EVENT_TIME.test(endTime)) throw fail(400, 'Event times must use 24-hour HH:MM format.');
  if (endTime && (!startTime || endTime <= startTime)) throw fail(400, 'Finish time must be after the start time on the same day.');
  if (!location) throw fail(400, 'Event location is required.');
  if (!EVENT_STATUSES.has(status)) throw fail(400, 'Invalid event status.');
  return { title, eventDate, startTime, endTime, location, description, status };
}
async function eventSchedule(db) {
  const now = londonNow();
  const today = now.date;
  const [seriesResult, specialResult, houseStartSetting] = await Promise.all([
    db.prepare(`SELECT id,slug,title,weekday,recurrence_pattern AS recurrencePattern,start_time AS startTime,end_time AS endTime,location,description,sort_order AS sortOrder
      FROM recurring_events WHERE active=1 ORDER BY sort_order,id`).all(),
    db.prepare(`SELECT id,title,event_date AS eventDate,start_time AS startTime,end_time AS endTime,location,description,status
      FROM special_events WHERE event_date>=? ORDER BY event_date,start_time,id`).bind(today).all(),
    db.prepare("SELECT value FROM settings WHERE key='house_event_start'").first()
  ]);
  const houseStartsOn = VALID_DATE.test(houseStartSetting?.value || '') ? houseStartSetting.value : '';
  const recurring = (await Promise.all(seriesResult.results.map(async (series) => {
    const candidates = await Promise.all(upcomingDatesForSeries(today, series, houseStartsOn).map(async (eventDate) => {
      const override = await db.prepare(`SELECT title,start_time AS startTime,end_time AS endTime,location,description,status
        FROM event_overrides WHERE recurring_event_id=? AND event_date=?`).bind(series.id, eventDate).first();
      return {
        id: `recurring-${series.id}-${eventDate}`, source: 'recurring', seriesId: series.id, slug: series.slug,
        title: override?.title || series.title, eventDate,
        startTime: override?.startTime ?? series.startTime, endTime: override?.endTime ?? series.endTime, location: override?.location || series.location,
        description: override?.description ?? series.description, status: override?.status || 'scheduled',
        customised: !!override, sortOrder: series.sortOrder
      };
    }));
    const visible = candidates.filter((event) => !eventHasEnded(event, now));
    return visible.slice(0, series.slug === 'yugioh-advanced-thursday' ? 4 : 4);
  }))).flat();
  const special = specialResult.results
    .map((event) => ({ ...event, id: `special-${event.id}`, eventId: event.id, source: 'special' }))
    .filter((event) => !eventHasEnded(event, now));
  return [...recurring, ...special].sort((a, b) => a.eventDate.localeCompare(b.eventDate)
    || (a.startTime || '99:99').localeCompare(b.startTime || '99:99') || (a.sortOrder || 0) - (b.sortOrder || 0));
}
async function handle(context) {
  const { request, env } = context;
  const db = env.GOG_DB;
  if (!db) return json({ error: 'Cloudflare D1 binding GOG_DB is missing. See SETUP.md.' }, 503);
  const url = new URL(request.url);
  const path = url.pathname.slice(BASE.length) || '/';
  const method = request.method;
  if (!url.pathname.startsWith(BASE + '/') || path.includes('..')) throw fail(404, 'Not found.');
  if (method !== 'GET' && !sameOrigin(request)) throw fail(403, 'Cross-origin request blocked.');

  if (method === 'GET' && path === '/config') {
    const [settingsRes, admin, version] = await Promise.all([
      db.prepare('SELECT key,value FROM settings').all(),
      db.prepare('SELECT 1 FROM admins LIMIT 1').first(),
      currentVersion(db)
    ]);
    const settings = Object.fromEntries(settingsRes.results.map((row) => [row.key, row.value]));
    return json({ settings, adminConfigured: !!admin, setupTokenRequired: !admin,
      cardPool: { cutoffDate: CUTOFF, setCode: 'JUSH', setName: 'Justice Hunters', releaseBasis: 'first TCG release in any region, including North America' }, version: versionView(version) });
  }
  if (method === 'GET' && path === '/list') {
    const version = await currentVersion(db);
    if (!version) throw fail(503, 'The JUSH foundation has not been seeded. See SETUP.md.');
    const [house, revisionChanges] = await Promise.all([houseViewFor(db, version), changesFor(db, version)]);
    const houseChangesByName = new Map(house.changes.map((entry) => [normalise(entry.name), entry]));
    const recentChanges = revisionChanges.map((entry) => {
      const houseChange = houseChangesByName.get(normalise(entry.name));
      return houseChange ? { ...entry, baselineStatus: houseChange.baselineStatus, isHouseChange: true } : entry;
    });
    return json({ version: versionView(version), baseline: house.baseline, entries: house.entries,
      changes: house.changes, recentChanges });
  }
  if (method === 'GET' && path === '/events') {
    return json({ timezone: 'Europe/London', generatedFor: londonToday(), events: await eventSchedule(db) });
  }
  if (method === 'GET' && path === '/catalogue') return json(await cataloguePage(db, url));
  if (method === 'GET' && path === '/cards/search') {
    const q = (url.searchParams.get('q') || '').trim();
    return json({ results: q.length < 2 ? [] : await statusesFor(db, await cardSearch(db, q)) });
  }
  if (method === 'GET' && path === '/cards/lookup') {
    const name = (url.searchParams.get('name') || '').trim().slice(0, 120);
    if (!name) throw fail(400, 'Card name is required.');
    let match = await db.prepare('SELECT * FROM cards_cache WHERE sort_name=? LIMIT 1').bind(normalise(name)).first();
    let card = match ? cachedCardView(match) : null;
    if (!card) {
      const cards = await cardSearch(db, name);
      card = cards.find((c) => normalise(c.name) === normalise(name)) || null;
    }
    return json({ card: card ? (await statusesFor(db, [card]))[0] : null });
  }
  if (method === 'POST' && path === '/cards/resolve') {
    const body = await inputJson(request);
    if (!Array.isArray(body.ids)) throw fail(400, 'An ids array is required.');
    const results = await resolveCardIds(db, body.ids);
    const meta = await catalogueMeta(db);
    return json({ results, catalogue: { complete: meta.complete === '1', revision: meta.revision || null } });
  }
  if (method === 'POST' && path === '/decks/validate') return json(await validateDeck(db, await inputJson(request)));
  const imageRoute = path.match(/^\/cards\/(\d+)\/image$/);
  if (method === 'GET' && imageRoute) return imageFor(context, imageRoute[1]);
  if (method === 'GET' && path === '/auth/password-salt') {
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase().slice(0, 254);
    const admin = await db.prepare('SELECT salt FROM admins WHERE email=?').bind(email).first();
    return json({ salt: admin?.salt || '2f19c693283adb89407159ea19f003b8' });
  }
  if (method === 'GET' && path === '/auth/session') {
    const s = await sessionFor(db, request);
    return json({ authenticated: !!s, email: s?.email || null, csrfToken: s?.csrf_token || null });
  }
  if (method === 'POST' && path === '/setup') {
    const existing = await db.prepare('SELECT 1 FROM admins LIMIT 1').first();
    if (existing) throw fail(409, 'Administrator setup already complete.');
    const body = await inputJson(request);
    if (!env.GOG_SETUP_TOKEN || !safeEquals(String(body.setupToken || ''), env.GOG_SETUP_TOKEN))
      throw fail(403, 'First-run administrator setup requires the GOG_SETUP_TOKEN configured in Cloudflare Pages secrets.');
    const email = String(body.email || '').trim().toLowerCase();
    const salt = String(body.salt || ''), verifier = String(body.passwordVerifier || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw fail(400, 'Enter a valid email address.');
    if (!validSalt(salt) || !validVerifier(verifier)) throw fail(400, 'Password derivation failed. Refresh and try again.');
    const hash = await passwordStorageHash(verifier, salt, env.GOG_AUTH_PEPPER);
    try {
      await db.prepare('INSERT INTO admins(id,email,password_hash,salt,created_at) VALUES(1,?,?,?,?)')
        .bind(email, hash, salt, nowIso()).run();
    } catch { throw fail(409, 'Administrator setup was already completed.'); }
    const session = await newSession(db, 1);
    return json({ ok: true, email, csrfToken: session.csrf }, 200, { 'Set-Cookie': sessionCookie(session.token) });
  }
  if (method === 'POST' && path === '/auth/login') {
    const body = await inputJson(request);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    const verifier = String(body.passwordVerifier || '');
    await loginThrottled(db, request, email);
    if (!validVerifier(verifier)) throw fail(400, 'Invalid password proof. Refresh and try again.');
    const admin = await db.prepare('SELECT * FROM admins WHERE email=?').bind(email).first();
    // Always perform the HMAC even for a missing account.
    const candidate = await passwordStorageHash(verifier, admin?.salt || '2f19c693283adb89407159ea19f003b8', env.GOG_AUTH_PEPPER);
    if (!admin || !safeEquals(candidate, admin.password_hash)) throw fail(401, 'Email or password is incorrect.');
    const session = await newSession(db, admin.id);
    const key = await sha256(`${request.headers.get('CF-Connecting-IP') || 'unknown'}/${normalise(email)}`);
    await db.prepare('DELETE FROM auth_attempts WHERE key_hash=?').bind(key).run();
    return json({ ok: true, email: admin.email, csrfToken: session.csrf }, 200, { 'Set-Cookie': sessionCookie(session.token) });
  }
  if (method === 'POST' && path === '/auth/logout') {
    const session = await requireAdmin(db, request, true);
    await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(session.token_hash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', true) });
  }

  if (path.startsWith('/admin/')) {
    const session = await requireAdmin(db, request, method !== 'GET');
    if (method === 'GET' && path === '/admin/events') {
      return json({ timezone: 'Europe/London', generatedFor: londonToday(), events: await eventSchedule(db) });
    }
    if (method === 'POST' && path === '/admin/events') {
      const event = eventValues(await inputJson(request));
      const timestamp = nowIso();
      const result = await db.prepare(`INSERT INTO special_events
        (title,event_date,start_time,end_time,location,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(event.title,event.eventDate,event.startTime,event.endTime,event.location,event.description,event.status,timestamp,timestamp).run();
      return json({ ok: true, eventId: result.meta?.last_row_id || null });
    }
    const recurringEvent = path.match(/^\/admin\/events\/recurring\/(\d+)$/);
    if (method === 'PATCH' && recurringEvent) {
      const series = await db.prepare('SELECT * FROM recurring_events WHERE id=? AND active=1').bind(Number(recurringEvent[1])).first();
      if (!series) throw fail(404, 'Recurring event not found.');
      const body = await inputJson(request);
      const expectedDate = String(body.eventDate || '');
      const houseStartSetting = await db.prepare("SELECT value FROM settings WHERE key='house_event_start'").first();
      const houseStartsOn = VALID_DATE.test(houseStartSetting?.value || '') ? houseStartSetting.value : '';
      const validDates = upcomingDatesForSeries(londonToday(), series, houseStartsOn);
      if (!validDates.includes(expectedDate)) throw fail(409, 'This occurrence is outside the current schedule. Refresh and try again.');
      const existing = await db.prepare(`SELECT title,start_time AS startTime,end_time AS endTime,location,description,status
        FROM event_overrides WHERE recurring_event_id=? AND event_date=?`).bind(series.id, expectedDate).first();
      const event = eventValues(body, { title: series.title, eventDate: expectedDate, startTime: series.start_time,
        endTime: series.end_time, location: series.location, description: series.description, status: 'scheduled', ...existing });
      const timestamp = nowIso();
      await db.prepare(`INSERT INTO event_overrides
        (recurring_event_id,event_date,title,start_time,end_time,location,description,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(recurring_event_id,event_date) DO UPDATE SET
        title=excluded.title,start_time=excluded.start_time,end_time=excluded.end_time,location=excluded.location,
        description=excluded.description,status=excluded.status,updated_at=excluded.updated_at`)
        .bind(series.id,event.eventDate,event.title,event.startTime,event.endTime,event.location,event.description,event.status,timestamp,timestamp).run();
      return json({ ok: true });
    }
    const recurringReset = path.match(/^\/admin\/events\/recurring\/(\d+)\/override$/);
    if (method === 'DELETE' && recurringReset) {
      const eventDate = String(url.searchParams.get('date') || '');
      if (!VALID_DATE.test(eventDate)) throw fail(400, 'A valid occurrence date is required.');
      await db.prepare('DELETE FROM event_overrides WHERE recurring_event_id=? AND event_date=?')
        .bind(Number(recurringReset[1]), eventDate).run();
      return json({ ok: true });
    }
    const specialEvent = path.match(/^\/admin\/events\/(\d+)$/);
    if ((method === 'PATCH' || method === 'DELETE') && specialEvent) {
      const id = Number(specialEvent[1]);
      const existing = await db.prepare(`SELECT id,title,event_date AS eventDate,start_time AS startTime,end_time AS endTime,location,description,status
        FROM special_events WHERE id=?`).bind(id).first();
      if (!existing) throw fail(404, 'One-off event not found.');
      if (method === 'DELETE') {
        await db.prepare('DELETE FROM special_events WHERE id=?').bind(id).run();
        return json({ ok: true });
      }
      const event = eventValues(await inputJson(request), existing);
      await db.prepare(`UPDATE special_events SET title=?,event_date=?,start_time=?,end_time=?,location=?,description=?,status=?,updated_at=? WHERE id=?`)
        .bind(event.title,event.eventDate,event.startTime,event.endTime,event.location,event.description,event.status,nowIso(),id).run();
      return json({ ok: true });
    }
    if (method === 'GET' && path === '/admin/draft') {
      const draft = await getDraft(db);
      const [changes, house] = await Promise.all([changesFor(db, draft), houseViewFor(db, draft)]);
      return json({ draft: { id: draft.id, label: draft.version_label, effectiveDate: draft.effective_date,
        summary: draft.summary, previousVersionId: draft.previous_version_id },
        baseline: house.baseline, entries: house.entries, changes, houseChanges: house.changes });
    }
    if (method === 'POST' && path === '/admin/draft/entry') {
      const body = await inputJson(request);
      const status = checkedStatus(body.status);
      const draft = await getDraft(db);
      const proposed = body.card || {};
      const inputId = Number(proposed.id);
      let card = null;
      if (Number.isSafeInteger(inputId) && inputId > 0) {
        // An admin cannot add post-JUSH cards by crafting POST requests.
        card = await cardById(db, inputId);
        if (!card) throw fail(422, `That card was not TCG-legal by ${CUTOFF}.`);
      } else {
        // Only pre-seeded or previously published historical entries may lack an ID.
        const historical = await db.prepare(`SELECT name,card_id AS id,category,subtype,card_type AS cardType
          FROM entries WHERE sort_name=? ORDER BY version_id LIMIT 1`).bind(normalise(proposed.name)).first();
        if (!historical) throw fail(422, 'Search and select an eligible card from the verified catalogue.');
        card = historical;
      }
      const existing = await db.prepare('SELECT note FROM entries WHERE version_id=? AND sort_name=?')
        .bind(draft.id, normalise(card.name)).first();
      const note = typeof body.note === 'string' ? body.note.slice(0, 1000) : (existing?.note || null);
      await applyEntry(db, draft.id, card, status, note);
      return json({ ok: true });
    }
    if (method === 'PATCH' && path === '/admin/draft/entry-by-name') {
      const body = await inputJson(request);
      const draft = await getDraft(db);
      const key = normalise(body.name);
      const existing = await db.prepare('SELECT * FROM entries WHERE version_id=? AND sort_name=?').bind(draft.id, key).first();
      if (!existing) throw fail(404, 'Card not found in the draft.');
      const status = checkedStatus(body.status || existing.status);
      await applyEntry(db, draft.id, { ...existing, id: existing.card_id, name: existing.name,
        cardType: existing.card_type }, status, typeof body.note === 'string' ? body.note.slice(0, 1000) : existing.note);
      return json({ ok: true });
    }
    if (method === 'POST' && path === '/admin/publish') {
      const body = await inputJson(request);
      const versionLabel = String(body.versionLabel || '').trim().slice(0, 120);
      const effectiveDate = String(body.effectiveDate || '').trim();
      const summary = String(body.summary || '').trim().slice(0, 2000);
      if (!versionLabel || !VALID_DATE.test(effectiveDate) || Number.isNaN(Date.parse(effectiveDate)))
        throw fail(400, 'A version label and valid effective date are required.');
      const draft = await getDraft(db);
      if (!(await changesFor(db, draft)).length) throw fail(400, 'There are no status changes to publish.');
      await db.prepare(`UPDATE versions SET version_label=?,effective_date=?,summary=?,status='published',published_at=? WHERE id=? AND status='draft'`)
        .bind(versionLabel, effectiveDate, summary, nowIso(), draft.id).run();
      return json({ ok: true, versionId: draft.id });
    }
    if (method === 'GET' && path === '/admin/versions') {
      const { results } = await db.prepare(`SELECT id,version_label AS versionLabel,effective_date AS effectiveDate,
        summary,status,source,published_at AS publishedAt,created_at AS createdAt FROM versions ORDER BY id DESC`).all();
      return json({ versions: results });
    }
    const restore = path.match(/^\/admin\/versions\/(\d+)\/restore$/);
    if (method === 'POST' && restore) {
      const source = await db.prepare('SELECT * FROM versions WHERE id=?').bind(Number(restore[1])).first();
      if (!source || source.status !== 'published') throw fail(404, 'Published version not found.');
      const current = await currentVersion(db);
      // A single D1 batch ensures the replacement draft cannot be partially copied.
      await db.batch([
        db.prepare("DELETE FROM versions WHERE status='draft'"),
        db.prepare(`INSERT INTO versions(version_label,effective_date,summary,status,previous_version_id,source,created_at)
          VALUES (?,? ,?,'draft',?,'restored',?)`).bind(`Restore ${source.version_label}`, source.effective_date,
            `Draft restored from ${source.version_label}.`, current.id, nowIso()),
        db.prepare(`INSERT INTO entries(version_id,name,sort_name,card_id,category,subtype,card_type,status,note)
          SELECT (SELECT id FROM versions WHERE status='draft'),name,sort_name,card_id,
            category,subtype,card_type,status,note FROM entries WHERE version_id=?`).bind(source.id)
      ]);
      const draft = await getDraft(db);
      return json({ ok: true, draftId: draft.id });
    }
    if (method === 'PATCH' && path === '/admin/settings') {
      const body = await inputJson(request);
      const allowed = ['format_name','format_short_name','format_description','store_name','accent_label'];
      const updates = allowed.filter((key) => typeof body[key] === 'string').map((key) => db.prepare(`INSERT INTO settings(key,value)
        VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(key, body[key].trim().slice(0, 300)));
      if (updates.length) await db.batch(updates);
      const { results } = await db.prepare('SELECT key,value FROM settings').all();
      return json({ ok: true, settings: Object.fromEntries(results.map((row) => [row.key, row.value])) });
    }
    if (method === 'POST' && path === '/admin/password') {
      const body = await inputJson(request);
      const currentVerifier = String(body.currentVerifier || '');
      const newVerifier = String(body.newVerifier || ''), newSalt = String(body.newSalt || '');
      if (!validVerifier(currentVerifier) || !validVerifier(newVerifier) || !validSalt(newSalt))
        throw fail(400, 'Invalid password proof. Refresh and try again.');
      const admin = await db.prepare('SELECT * FROM admins WHERE id=?').bind(session.admin_id).first();
      if (!safeEquals(await passwordStorageHash(currentVerifier, admin.salt, env.GOG_AUTH_PEPPER), admin.password_hash))
        throw fail(403, 'Current password is incorrect.');
      await db.batch([
        db.prepare('UPDATE admins SET password_hash=?,salt=? WHERE id=?')
          .bind(await passwordStorageHash(newVerifier, newSalt, env.GOG_AUTH_PEPPER), newSalt, session.admin_id),
        db.prepare('DELETE FROM sessions WHERE admin_id=? AND token_hash<>?').bind(session.admin_id, session.token_hash)
      ]);
      return json({ ok: true });
    }
    if (method === 'GET' && path === '/admin/export.csv') {
      const draft = await getDraft(db);
      const rows = await entriesFor(db, draft.id);
      const quote = (text) => `"${String(text ?? '').replaceAll('"', '""').replace(/^[=+@\-]/, "'$&")}"`;
      const csv = ['Card Name,Category,Subtype,Status,Note', ...rows.map((r) =>
        [r.name,r.category,r.subtype,r.status,r.note || ''].map(quote).join(','))].join('\r\n');
      return new Response(csv, { headers: { ...HEADERS, 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="jush-house-format-draft.csv"' } });
    }
  }
  throw fail(404, 'API route not found.');
}
export async function onRequest(context) {
  try { return await handle(context); }
  catch (error) {
    if (!error.status) console.error('GOG API failure:', error);
    if (isD1DailyReadLimit(error)) return json({
      error: 'Card and format data are temporarily unavailable because the daily database allowance has been reached. Service resumes automatically at midnight UTC.'
    }, 503, { 'Retry-After': String(secondsUntilNextUtcDay()) });
    return json({ error: error.status ? error.message : 'Internal server error. Check Cloudflare Pages Function logs.' }, error.status || 500);
  }
}
