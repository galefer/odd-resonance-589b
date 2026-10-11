// Dependency-free local API regression suite using Node's built-in SQLite.
// Simulates Cloudflare Pages request routing, D1 and a release-aware YGOPRODeck API.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../functions/gog/api/[[path]].js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../database/schema.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../database/seed.sql', import.meta.url), 'utf8'));

const wrapStmt = (sql, args = []) => ({
  bind(...params) { return wrapStmt(sql, params); },
  first() { return db.prepare(sql).get(...args) ?? null; },
  async all() { return { results: db.prepare(sql).all(...args) }; },
  async run() {
    const result = db.prepare(sql).run(...args);
    return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  }
});
const D1 = {
  prepare(sql) { return wrapStmt(sql); },
  async batch(stmts) {
    db.exec('BEGIN');
    try { const rows = []; for (const stmt of stmts) rows.push(await stmt.run()); db.exec('COMMIT'); return rows; }
    catch(e) { db.exec('ROLLBACK'); throw e; }
  }
};
const eligible = {
  1111: { id: 1111, name: 'Dracotail Lukias', type: 'Effect Monster', desc: 'Fusion material effect.', misc_info: [{tcg_date:'2025-08-01'}], card_images: [{ id:1111 }] },
  2222: { id: 2222, name: 'Ash Blossom & Joyous Spring', type: 'Tuner Monster', desc: 'Hand trap.', misc_info: [{tcg_date:'2017-05-04'}], card_images: [{ id:2222 }] },
  4444: { id: 4444, name: 'Pot of Greed', type: 'Spell Card', desc: 'Draw two cards.', misc_info: [{tcg_date:'2002-03-08'}], card_images: [{ id:4444 }] },
  5555: { id: 5555, name: 'Droll & Lock Bird', type: 'Effect Monster', desc: 'Draw lock.', misc_info: [{tcg_date:'2010-05-25'}], card_images: [{ id:5555 }] }
};
const afterCutoff = { id: 3333, name: 'Post JUSH 2026 Card', type: 'Effect Monster', desc: 'Not in pool.', misc_info: [{tcg_date:'2026-02-07'}] };
const fetchOriginal = globalThis.fetch;
let fetchCount = 0;
globalThis.fetch = async (url, opts) => {
  url = new URL(url);
  if (!url.hostname.includes('ygoprodeck')) throw new Error(`Unexpected upstream: ${url}`);
  if (!url.searchParams.size) throw new Error('Bad card API URL');
  // Enforce hard cutoff on *every* upstream request.
  assert.equal(url.searchParams.get('enddate'), '2025-08-01');
  assert.equal(url.searchParams.get('format'), 'tcg');
  assert.equal(url.searchParams.get('dateregion'), 'tcg');
  assert.equal(url.searchParams.get('misc'), 'yes');
  fetchCount += 1;
  let cards = Object.values(eligible);
  const id = Number(url.searchParams.get('id'));
  if (id) cards = eligible[id] ? [eligible[id]] : id === 3333 ? [afterCutoff] : [];
  else {
    const q = String(url.searchParams.get('fname') || '').toLowerCase();
    cards = [...cards, afterCutoff].filter((c) => c.name.toLowerCase().includes(q));
  }
  return new Response(JSON.stringify({ data: cards }), { status: cards.length ? 200 : 400,
    headers: { 'Content-Type':'application/json' } });
};

// Browser PBKDF2 password derivation; Cloudflare only performs inexpensive HMAC.
async function passwordProof(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt: new TextEncoder().encode(salt), iterations:310_000, hash:'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits), (v)=>v.toString(16).padStart(2,'0')).join('');
}
const setupSalt = '1'.repeat(32);
const setupVerifier = await passwordProof('aVeryStrongPassword1', setupSalt);
const cookieName = 'gog_session';
let sessionCookie = '';
let csrf = '';
const base = 'https://gravetalestudios.com';
const contextBase = { env: { GOG_DB: D1, GOG_SETUP_TOKEN: 'test-setup-token', GOG_AUTH_PEPPER: 'permanent-test-pepper-very-long-string' } };
async function req(path, method='GET', body=null, { useSession = true, token = csrf, origin = base } = {}) {
  const headers = { Origin: origin };
  if (useSession && sessionCookie) headers.Cookie = sessionCookie;
  if (token) headers['X-CSRF-Token'] = token;
  if (body != null) headers['Content-Type'] = 'application/json';
  const request = new Request(`${base}/gog/api${path}`, { method, headers, body: body == null ? null : JSON.stringify(body) });
  return onRequest({ ...contextBase, request, params: { path: path.split('/').slice(1) } });
}
async function get(path) {
  const response = await req(path);
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}: ${await response.clone().text()}`);
  return response.json();
}

// Foundation: historical, exact and independent.
const config = await get('/config');
assert.equal(config.cardPool.cutoffDate, '2025-08-01');
assert.equal(config.version.effectiveDate, '2025-04-07');
assert.equal(config.adminConfigured, false);
const starting = await get('/list');
assert.equal(starting.entries.length, 207);
assert.equal(starting.entries.filter(e=>e.status==='forbidden').length,109);
assert.equal(starting.entries.filter(e=>e.status==='limited').length,82);
assert.equal(starting.entries.filter(e=>e.status==='semi_limited').length,16);
assert.equal(starting.entries.find(e=>e.name==='ABYSS DWELLER').status,'forbidden');
assert.equal(starting.entries.find(e=>e.name==='DIMENSION SHIFTER').status,'limited');
assert.equal(starting.entries.find(e=>e.name==='EXT RYZEAL').status,'semi_limited');
assert(!starting.entries.some(e=>e.name.includes('K9-04')));

const unauthed = await req('/admin/draft');
assert.equal(unauthed.status, 401);

const blockedSetup = await req('/setup', 'POST', { email:'admin@example.com', password:'aVeryStrongPassword1' });
assert.equal(blockedSetup.status,403);
const setup = await req('/setup', 'POST', { email:'admin@example.com',salt:setupSalt,passwordVerifier:setupVerifier,setupToken:'test-setup-token' });
assert.equal(setup.status,200, await setup.clone().text());
const auth = await setup.json();
csrf = auth.csrfToken;
sessionCookie = setup.headers.get('set-cookie').split(';')[0];
assert(sessionCookie.startsWith(cookieName+'='));
assert(setup.headers.get('set-cookie').includes('HttpOnly'));
assert(setup.headers.get('set-cookie').includes('Secure'));
const configAfter = await get('/config');
assert.equal(configAfter.adminConfigured, true);
const duplicate = await req('/setup', 'POST', { email:'other@example.com',password:'superStrongPassword!',setupToken:'test-setup-token' });
assert.equal(duplicate.status, 409);
assert.equal((await get('/auth/session')).authenticated, true);

const blockedCsrf = await req('/admin/settings', 'PATCH', {store_name:'Evil'}, {token:'wrong'});
assert.equal(blockedCsrf.status, 403);
const blockedOrigin = await req('/admin/settings', 'PATCH', {store_name:'Evil'}, {origin:'https://stranger.example'});
assert.equal(blockedOrigin.status, 403);
const draft = await get('/admin/draft');
assert.equal(draft.entries.length,207);
assert.equal(draft.changes.length,0);

// Eligible cards must appear; post-JUSH card searches and ID submissions must not,
// EVEN IF the upstream API returns post-cutoff cards incorrectly.
const jush = await get('/cards/search?q=Dracotail');
assert.equal(jush.results[0].name,'Dracotail Lukias');
assert.equal(jush.results[0].status,'unlimited');
const excluded = await get('/cards/search?q=Post%20JUSH');
assert.deepEqual(excluded.results,[]);
const noBypass = await req('/admin/draft/entry', 'POST', {card:afterCutoff,status:'forbidden'});
assert.equal(noBypass.status,422);
const originalFetchForOffline = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Simulated upstream outage'); };
const offline = await get('/cards/search?q=Lukias');
assert(offline.results.some(e => e.name === 'Dracotail Lukias'));
globalThis.fetch = originalFetchForOffline;
const spoofed = await req('/admin/draft/entry', 'POST', {card:{id:1111,name:'Post JUSH 2026 Card',category:'Trap'},status:'limited'});
assert.equal(spoofed.status,200);
let currentDraft = await get('/admin/draft');
assert.equal(currentDraft.entries.find(e=>e.name==='Dracotail Lukias').status,'limited');
assert(!currentDraft.entries.some(e=>e.name==='Post JUSH 2026 Card'));
// Then move to Unlimited: removes the explicit restriction, not the underlying card pool entry.
const remove = await req('/admin/draft/entry', 'POST', {card:{id:1111},status:'unlimited'});
assert.equal(remove.status,200);
assert(!((await get('/admin/draft')).entries.some(e=>e.name==='Dracotail Lukias')));
// Add two actual draft changes, one existing and one new.
const modify = await req('/admin/draft/entry-by-name','PATCH',{name:'ABYSS DWELLER',status:'limited',note:'House format decision.'});
assert.equal(modify.status,200);
const add = await req('/admin/draft/entry','POST',{card:{id:1111},status:'semi_limited'});
assert.equal(add.status,200);
assert.equal((await get('/list')).entries.find(e=>e.name==='ABYSS DWELLER').status,'forbidden');
currentDraft = await get('/admin/draft');
assert.equal(currentDraft.changes.length,2);
const preview = await req('/admin/export.csv');
assert.equal(preview.status,200);
assert((await preview.text()).includes('Dracotail Lukias'));
const publish = await req('/admin/publish','POST',{versionLabel:'JUSH Local v1',effectiveDate:'2025-08-01',summary:'Our house list.'});
assert.equal(publish.status,200);
const current = await get('/list');
assert.equal(current.version.label,'JUSH Local v1');
assert.equal(current.entries.find(e=>e.name==='ABYSS DWELLER').status,'limited');
assert.equal(current.entries.find(e=>e.name==='Dracotail Lukias').status,'semi_limited');
assert.equal(current.changes.length,2);
const versions = await get('/admin/versions');
assert.equal(versions.versions.filter(e=>e.status==='published').length,2);
const restore = await req('/admin/versions/1/restore','POST',{});
assert.equal(restore.status,200);
const restored = await get('/admin/draft');
assert.equal(restored.entries.length,207);
assert.equal(restored.entries.find(e=>e.name==='ABYSS DWELLER').status,'forbidden');
assert.equal((await get('/list')).version.label,'JUSH Local v1');
// Publish the restored older snapshot, then make a note-only draft.
const restoredPublish = await req('/admin/publish','POST',{versionLabel:'Restored foundation',effectiveDate:'2025-08-01',summary:'Restored the foundation.'});
assert.equal(restoredPublish.status,200);
await get('/admin/draft');
// Publishing a note change without a restriction status change must be possible too.
const noteOnly = await req('/admin/draft/entry-by-name','PATCH',{name:'DIMENSION SHIFTER',status:'limited',note:'Store note only.'});
assert.equal(noteOnly.status,200);
assert((await get('/admin/draft')).changes.some(e => e.changeType === 'note_updated'));
const notePublish = await req('/admin/publish','POST',{versionLabel:'Note update',effectiveDate:'2025-08-02',summary:'Updated a store note.'});
assert.equal(notePublish.status,200);
assert.equal((await get('/list')).version.label,'Note update');

const img = await req('/cards/1111/image');
assert.equal(img.headers.get('content-type'),'image/svg+xml'); // No R2 configured, never hotlinks.
const imgOutside = await req('/cards/3333/image');
assert.equal(imgOutside.headers.get('content-type'),'image/svg+xml');

const logout = await req('/auth/logout','POST',{});
assert.equal(logout.status,200);
assert.equal((await get('/auth/session')).authenticated,false);
const challenge = await get('/auth/password-salt?email=admin%40example.com');
assert.equal(challenge.salt, setupSalt);
const invalidLogin = await req('/auth/login','POST',{email:'admin@example.com',passwordVerifier:await passwordProof('bad password', challenge.salt)});
assert.equal(invalidLogin.status,401);
const correctLogin = await req('/auth/login','POST',{email:'admin@example.com',passwordVerifier:setupVerifier});
assert.equal(correctLogin.status,200);
csrf = (await correctLogin.clone().json()).csrfToken;
sessionCookie = correctLogin.headers.get('set-cookie').split(';')[0];
const newSalt = '2'.repeat(32);
const newVerifier = await passwordProof('changed-strong-password-42', newSalt);
const changePassword = await req('/admin/password','POST',{currentVerifier:setupVerifier,newVerifier,newSalt});
assert.equal(changePassword.status,200);
assert.equal((await get('/auth/password-salt?email=admin%40example.com')).salt,newSalt);
assert(fetchCount>0);
console.log(`Passed: 207-card foundation, JUSH cutoff, spoofing resistance, PBKDF2/HMAC browser auth, CSRF, password change, drafts, publication, restore, image safeguards (${fetchCount} simulated upstream requests).`);
globalThis.fetch = fetchOriginal;
