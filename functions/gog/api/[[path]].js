// GRAVETALE /gog/ house format API for Cloudflare Pages Functions + D1 (+ optional R2).
// The historical card pool is LOCKED to TCG first releases on/before 2025-08-01.
// Frontend paths all live under /gog/; this function only handles /gog/api/*.

const BASE = '/gog/api';
const CUTOFF = '2025-08-01';
const ALLOWED = new Set(['forbidden', 'limited', 'semi_limited', 'unlimited']);
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW = 15 * 60 * 1000;
// Leave a wide margin below R2's 10 GB monthly free storage allowance.
const IMAGE_CACHE_LIMIT_BYTES = 5_000_000_000;
const IMAGE_MAX_BYTES = 300_000;
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
  return ['Pendulum', 'Fusion', 'Synchro', 'Xyz', 'Link', 'Ritual', 'Normal', 'Effect'].find((x) => new RegExp(x, 'i').test(type)) || 'Effect';
};
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
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
// misc=yes provides the original TCG print date; fail closed when unavailable.
function isJushEligible(raw) {
  const tcgDate = raw?.misc_info?.find((info) => typeof info?.tcg_date === 'string')?.tcg_date;
  return /^\d{4}-\d{2}-\d{2}$/.test(tcgDate || '') && tcgDate <= CUTOFF;
}
function cardFromApi(raw) {
  const category = cardCategory(raw.type || '');
  return {
    id: Number(raw.id), name: String(raw.name || ''), category, subtype: cardSubtype(raw.type || ''),
    cardType: raw.type || '', race: raw.race || null, attribute: raw.attribute || null,
    level: raw.level ?? raw.linkval ?? null, atk: raw.atk ?? null, def: raw.def ?? null,
    description: raw.desc || '',
    imageUrl: `${BASE}/cards/${Number(raw.id)}/image`
  };
}
async function storeCard(db, card) {
  await db.prepare(`INSERT INTO cards_cache(card_id,name,sort_name,category,subtype,card_type,race,attribute,level,atk,def,description,image_source_url,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(card_id) DO UPDATE SET name=excluded.name,sort_name=excluded.sort_name,category=excluded.category,
      subtype=excluded.subtype,card_type=excluded.card_type,race=excluded.race,attribute=excluded.attribute,
      level=excluded.level,atk=excluded.atk,def=excluded.def,description=excluded.description,
      image_source_url=excluded.image_source_url,updated_at=excluded.updated_at`)
    .bind(card.id, card.name, normalise(card.name), card.category, card.subtype, card.cardType,
      card.race, card.attribute, card.level, card.atk, card.def, card.description,
      `https://images.ygoprodeck.com/images/cards_small/${card.id}.jpg`, nowIso()).run();
}
function cachedCardView(row) {
  return { id: row.card_id, name: row.name, category: row.category, subtype: row.subtype,
    cardType: row.card_type, race: row.race, attribute: row.attribute, level: row.level, atk: row.atk,
    def: row.def, description: row.description,
    imageUrl: `${BASE}/cards/${row.card_id}/image` };
}
async function ygoFetch(params) {
  const url = new URL('https://db.ygoprodeck.com/api/v7/cardinfo.php');
  // These three parameters are required on every upstream lookup.
  url.searchParams.set('format', 'tcg');
  url.searchParams.set('enddate', CUTOFF);
  url.searchParams.set('dateregion', 'tcg');
  url.searchParams.set('misc', 'yes');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const result = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
  if (result.status === 400 || result.status === 404) return [];
  if (!result.ok) throw fail(503, 'Card catalogue temporarily unavailable. Try again shortly.');
  const payload = await result.json();
  return Array.isArray(payload.data) ? payload.data : [];
}
async function localSearch(db, query) {
  const like = `%${normalise(query).replace(/[%_\\]/g, '\\$&')}%`;
  const [cached, foundation] = await Promise.all([
    db.prepare("SELECT * FROM cards_cache WHERE sort_name LIKE ? ESCAPE '\\' ORDER BY sort_name LIMIT 25").bind(like).all(),
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
  let results = [];
  try {
    const rawCards = await ygoFetch({ fname: trimmed, num: 30, offset: 0 });
    results = rawCards.filter((raw) => isJushEligible(raw) && raw.id && raw.name && !['Skill Card', 'Token'].includes(raw.type))
      .slice(0, 20).map(cardFromApi);
    if (results.length) {
      // Each upstream result has already passed YGOPRODeck's TCG first-release filter.
      await db.batch(results.map((c) => db.prepare(`INSERT INTO cards_cache
        (card_id,name,sort_name,category,subtype,card_type,race,attribute,level,atk,def,description,image_source_url,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(card_id) DO UPDATE SET
        name=excluded.name,sort_name=excluded.sort_name,category=excluded.category,subtype=excluded.subtype,
        card_type=excluded.card_type,race=excluded.race,attribute=excluded.attribute,level=excluded.level,
        atk=excluded.atk,def=excluded.def,description=excluded.description,image_source_url=excluded.image_source_url,
        updated_at=excluded.updated_at`).bind(c.id,c.name,normalise(c.name),c.category,c.subtype,c.cardType,
          c.race,c.attribute,c.level,c.atk,c.def,c.description,
          `https://images.ygoprodeck.com/images/cards_small/${c.id}.jpg`,nowIso())));
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
  const rows = await ygoFetch({ id: cardId });
  // Do not trust a browser-supplied name or type: resolve against the locked TCG API.
  const raw = rows.find((row) => Number(row.id) === Number(cardId));
  if (!raw || !isJushEligible(raw) || ['Skill Card', 'Token'].includes(raw.type)) return null;
  const card = cardFromApi(raw);
  await storeCard(db, card);
  return card;
}
async function statusesFor(db, cards) {
  const [current, baseline] = await Promise.all([currentVersion(db), foundationVersion(db)]);
  const [entries, baselineEntries] = await Promise.all([entriesFor(db, current?.id), entriesFor(db, baseline?.id)]);
  const map = new Map(entries.map((e) => [normalise(e.name), e.status]));
  const baselineMap = new Map(baselineEntries.map((e) => [normalise(e.name), e.status]));
  return cards.map((c) => {
    const key = normalise(c.name);
    const status = map.get(key) || 'unlimited';
    const baselineStatus = baselineMap.get(key) || 'unlimited';
    return { ...c, status, copies: cardCopies(status), baselineStatus,
      isHouseChange: status !== baselineStatus };
  });
}
async function imageFor(context, id) {
  const db = context.env.GOG_DB;
  const validId = Number(id);
  if (!Number.isSafeInteger(validId) || validId <= 0) return placeholderImage();
  // Image requests for unknown / post-cutoff IDs never reach the image host.
  const cached = await db.prepare('SELECT card_id FROM cards_cache WHERE card_id=?').bind(validId).first();
  if (!cached || !context.env.GOG_IMAGES) return placeholderImage();
  const key = `cards-small/${validId}.jpg`;
  let object = await context.env.GOG_IMAGES.get(key);
  if (!object) {
    try {
      const response = await fetch(`https://images.ygoprodeck.com/images/cards_small/${validId}.jpg`, { signal: AbortSignal.timeout(9000) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return placeholderImage();
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > IMAGE_MAX_BYTES) return placeholderImage();
      let cacheState = 'bypass-limit';
      try {
        // An object missing from R2 makes any old accounting row stale.
        await db.prepare('DELETE FROM image_cache WHERE card_id=?').bind(validId).run();
        const usage = await db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM image_cache').first();
        if (Number(usage?.bytes || 0) + bytes.byteLength <= IMAGE_CACHE_LIMIT_BYTES) {
          await context.env.GOG_IMAGES.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
          try {
            await db.prepare(`INSERT INTO image_cache(card_id,size_bytes,cached_at)
              VALUES (?,?,?) ON CONFLICT(card_id) DO UPDATE SET size_bytes=excluded.size_bytes,cached_at=excluded.cached_at`)
              .bind(validId, bytes.byteLength, nowIso()).run();
            cacheState = 'stored';
          } catch (error) {
            await context.env.GOG_IMAGES.delete(key);
            throw error;
          }
        }
      } catch { cacheState = 'bypass-error'; }
      return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=2592000',
        'X-Content-Type-Options': 'nosniff', 'X-GOG-Image-Cache': cacheState } });
    } catch { return placeholderImage(); }
  }
  return new Response(object.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=2592000',
    'X-Content-Type-Options': 'nosniff', 'X-GOG-Image-Cache': 'hit' } });
}
function placeholderImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 421 614"><rect width="421" height="614" fill="#182033"/><rect x="20" y="20" width="381" height="574" rx="16" fill="#222d45" stroke="#c8a85b" stroke-width="4"/><circle cx="210" cy="280" r="82" fill="none" stroke="#c8a85b" stroke-width="8" opacity=".75"/><path d="M210 192l24 64 68 4-53 43 17 66-56-37-56 37 17-66-53-43 68-4z" fill="#c8a85b" opacity=".7"/><text x="210" y="430" text-anchor="middle" font-family="system-ui" font-size="22" fill="#f3ead2">CARD IMAGE</text></svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
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
      cardPool: { cutoffDate: CUTOFF, setCode: 'JUSH', setName: 'Justice Hunters', releaseBasis: 'first TCG release' }, version: versionView(version) });
  }
  if (method === 'GET' && path === '/list') {
    const version = await currentVersion(db);
    if (!version) throw fail(503, 'The JUSH foundation has not been seeded. See SETUP.md.');
    const house = await houseViewFor(db, version);
    return json({ version: versionView(version), baseline: house.baseline, entries: house.entries, changes: house.changes });
  }
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
    return json({ error: error.status ? error.message : 'Internal server error. Check Cloudflare Pages Function logs.' }, error.status || 500);
  }
}
