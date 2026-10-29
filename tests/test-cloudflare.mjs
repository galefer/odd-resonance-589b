// Dependency-free local API regression suite using Node's built-in SQLite.
// Simulates Cloudflare Pages request routing, D1 and a release-aware YGOPRODeck API.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../functions/gog/api/[[path]].js';
import { blmmCards } from './gog/fixtures/blmm.mjs';

const db = new DatabaseSync(':memory:');
const schemaSql = readFileSync(new URL('../database/schema.sql', import.meta.url), 'utf8');
const storageMigration = readFileSync(new URL('../database/migrations/0006_image_storage_counter.sql', import.meta.url), 'utf8');
const coverMigration = readFileSync(new URL('../database/migrations/0010_template_cover_images.sql', import.meta.url), 'utf8');
// Upgrade populated ledgers without losing their data, and safely rerun migration.
const upgradeDb = new DatabaseSync(':memory:');
upgradeDb.exec(schemaSql.split('-- Additive migration: count existing artwork once')[0]);
upgradeDb.exec(`INSERT INTO image_cache VALUES(1,10,'fixture');
  INSERT INTO image_cache_v2 VALUES('cards-small/2.jpg',2,'thumb',20,'fixture');`);
upgradeDb.exec(storageMigration);
assert.equal(upgradeDb.prepare('SELECT size_bytes FROM image_storage_usage').get().size_bytes,30);
upgradeDb.exec(`UPDATE image_cache SET size_bytes=12 WHERE card_id=1;
  INSERT INTO image_cache_reservations VALUES('cards-small/3.jpg',4,'fixture','fixture');`);
upgradeDb.exec(storageMigration);
assert.equal(upgradeDb.prepare('SELECT size_bytes FROM image_storage_usage').get().size_bytes,36);
upgradeDb.exec(`DELETE FROM image_cache WHERE card_id=1;
  UPDATE image_cache_v2 SET size_bytes=25;
  DELETE FROM image_cache_reservations;`);
assert.equal(upgradeDb.prepare('SELECT size_bytes FROM image_storage_usage').get().size_bytes,25);

// Widen the populated image ledger for cropped covers without losing rows,
// reservations, exact storage accounting or the counter triggers.
const coverUpgradeDb = new DatabaseSync(':memory:');
coverUpgradeDb.exec(`CREATE TABLE image_cache(card_id INTEGER PRIMARY KEY,size_bytes INTEGER NOT NULL,cached_at TEXT NOT NULL);
  CREATE TABLE image_cache_v2(asset_key TEXT PRIMARY KEY,card_id INTEGER NOT NULL,variant TEXT NOT NULL CHECK(variant IN ('thumb','full')),size_bytes INTEGER NOT NULL,cached_at TEXT NOT NULL);
  CREATE INDEX idx_image_cache_v2_card ON image_cache_v2(card_id);
  CREATE TABLE image_cache_reservations(asset_key TEXT PRIMARY KEY,size_bytes INTEGER NOT NULL,token TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE image_storage_usage(id INTEGER PRIMARY KEY,size_bytes INTEGER NOT NULL);
  INSERT INTO image_cache VALUES(1,10,'fixture');
  INSERT INTO image_cache_v2 VALUES('cards-small/2.jpg',2,'thumb',20,'fixture');
  INSERT INTO image_cache_reservations VALUES('cards-cropped/3.jpg',25,'fixture','fixture');
  INSERT INTO image_storage_usage VALUES(1,55);`);
coverUpgradeDb.exec(coverMigration);
assert.equal(coverUpgradeDb.prepare('SELECT COUNT(*) AS n FROM image_cache_v2').get().n,1);
assert.equal(coverUpgradeDb.prepare('SELECT size_bytes FROM image_storage_usage WHERE id=1').get().size_bytes,55);
coverUpgradeDb.exec(`INSERT INTO image_cache_v2 VALUES('cards-cropped/4.jpg',4,'cover',7,'fixture')`);
assert.equal(coverUpgradeDb.prepare('SELECT size_bytes FROM image_storage_usage WHERE id=1').get().size_bytes,62);
coverUpgradeDb.close();
upgradeDb.close();
// Upgrade real pre-end-time tables without changing event customisations.
const eventUpgrade = new DatabaseSync(':memory:');
eventUpgrade.exec(schemaSql
  .replace(/ end_time TEXT NOT NULL DEFAULT '',\r?\n/g, '')
  .replace(/ recurrence_pattern[^\r\n]*\r?\n/, ''));
eventUpgrade.exec(`INSERT INTO recurring_events(slug,title,weekday,start_time,created_at,updated_at) VALUES
  ('yugioh-advanced-thursday','Advanced',4,'','fixture','fixture'),
  ('yugioh-house-friday','House',5,'','fixture','fixture'),
  ('other','Other',6,'10:00','fixture','fixture');
  INSERT INTO event_overrides(recurring_event_id,event_date,title,start_time,status,created_at,updated_at) VALUES
  (1,'2030-01-03','Cancelled title','','cancelled','fixture','fixture'),
  (2,'2030-01-04','Custom start','18:00','scheduled','fixture','fixture');
  INSERT INTO special_events(title,event_date,start_time,created_at,updated_at)
  VALUES ('One-off','2030-01-05','12:00','fixture','fixture');`);
eventUpgrade.exec(readFileSync(new URL('../database/migrations/0007_event_end_times.sql', import.meta.url), 'utf8'));
eventUpgrade.exec(readFileSync(new URL('../database/migrations/0009_monthly_event_schedule.sql', import.meta.url), 'utf8'));
eventUpgrade.exec(readFileSync(new URL('../database/migrations/0011_house_event_start.sql', import.meta.url), 'utf8'));
assert.deepEqual(eventUpgrade.prepare('SELECT start_time,end_time FROM recurring_events WHERE id=1').get(),
  Object.assign(Object.create(null), {start_time:'17:30',end_time:'21:00'}));
assert.deepEqual({...eventUpgrade.prepare('SELECT title,status,start_time,end_time FROM event_overrides WHERE recurring_event_id=1').get()},
  {title:'Cancelled title',status:'cancelled',start_time:'17:30',end_time:'21:00'});
assert.deepEqual({...eventUpgrade.prepare('SELECT start_time,end_time FROM event_overrides WHERE recurring_event_id=2').get()},
  {start_time:'18:00',end_time:''});
assert.equal(eventUpgrade.prepare('SELECT start_time FROM recurring_events WHERE id=3').get().start_time,'10:00');
assert.equal(eventUpgrade.prepare('SELECT start_time FROM special_events').get().start_time,'12:00');
assert.deepEqual({...eventUpgrade.prepare("SELECT weekday,recurrence_pattern FROM recurring_events WHERE slug='yugioh-advanced-thursday'").get()},
  {weekday:4,recurrence_pattern:'weekly_except_last'});
assert.deepEqual({...eventUpgrade.prepare("SELECT weekday,recurrence_pattern FROM recurring_events WHERE slug='yugioh-house-friday'").get()},
  {weekday:4,recurrence_pattern:'last'});
assert.equal(eventUpgrade.prepare("SELECT value FROM settings WHERE key='house_event_start'").get().value,'2026-11-26');
eventUpgrade.close();

db.exec(readFileSync(new URL('../database/schema.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../database/seed.sql', import.meta.url), 'utf8'));

const wrapStmt = (sql, args = []) => ({
  bind(...params) { return wrapStmt(sql, params); },
  first() { return db.prepare(sql).get(...args) ?? null; },
  async all() { return { results: db.prepare(sql).all(...args) }; },
  run() {
    if (failImageFinalisation && sql.includes('INSERT INTO image_cache_v2')) throw new Error('Injected accounting failure');
    const result = db.prepare(sql).run(...args);
    return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  }
});
let failImageFinalisation = false;
const preparedQueries = [];
const D1 = {
  prepare(sql) { preparedQueries.push(sql); return wrapStmt(sql); },
  async batch(stmts) {
    db.exec('BEGIN');
    try { const rows = []; for (const stmt of stmts) rows.push(stmt.run()); db.exec('COMMIT'); return rows; }
    catch(e) { db.exec('ROLLBACK'); throw e; }
  }
};
const eligible = {
  ...Object.fromEntries(blmmCards.map(card=>[card.id,card])),
  1111: { id: 1111, name: 'Dracotail Lukias', type: 'Effect Monster', desc: 'Fusion material effect.', misc_info: [{tcg_date:'2025-08-01'}], card_images: [{ id:1111 }] },
  2222: { id: 2222, name: 'Ash Blossom & Joyous Spring', type: 'Tuner Monster', desc: 'Hand trap.', misc_info: [{tcg_date:'2017-05-04'}], card_images: [{ id:2222 }] },
  4444: { id: 4444, name: 'Pot of Greed', type: 'Spell Card', desc: 'Draw two cards.', misc_info: [{tcg_date:'2002-03-08'}], card_images: [{ id:4444 }] },
  5555: { id: 5555, name: 'Droll & Lock Bird', type: 'Effect Monster', desc: 'Draw lock.', misc_info: [{tcg_date:'2010-05-25'}], card_images: [{ id:5555 }] },
  5370235: { id:5370235, name:'Cyberdark Chimera', type:'Effect Monster', desc:'Fixture effect.', misc_info:[{tcg_date:'2021-10-14'}], card_images:[{id:5370235}] },
  59983249: { id:59983249, name:'Monarchic Perfection', type:'Trap Card', desc:'Fixture effect.', misc_info:[{ocg_date:'2025-04-26'}], card_images:[{id:59983249}] },
  12067160: { id:12067160, name:'Gorgon of Zilofthonia', type:'Link Monster', desc:'Fixture effect.', misc_info:[{tcg_date:'2026-07-15'}], card_images:[{id:12067160}] },
  87640391: { id:87640391, name:'Migratory Zereort', type:'Effect Monster', desc:'Fixture effect.', misc_info:[{ocg_date:'2024-08-21'}], card_images:[{id:87640391}] },
  98349765: { id:98349765, name:'Layer 19: "Preventing the Invasion! The Pitch-Black Super Quantum!!"', type:'Spell Card', desc:'Fixture effect.', misc_info:[{ocg_date:'2025-04-26'}], card_images:[{id:98349765}] }
};
const afterCutoff = { id: 3333, name: 'Post JUSH 2026 Card', type: 'Effect Monster', desc: 'Not in pool.', misc_info: [{tcg_date:'2026-02-07',ocg_date:'2024-01-01'}] };
const fetchOriginal = globalThis.fetch;
let fetchCount = 0;
globalThis.fetch = async (url, opts) => {
  url = new URL(url);
  if (!url.hostname.includes('ygoprodeck')) throw new Error(`Unexpected upstream: ${url}`);
  if (!url.searchParams.size) throw new Error('Bad card API URL');
  // Enforce hard cutoff on *every* upstream request.
  assert.equal(url.searchParams.get('enddate'), '2025-08-01');
  assert.equal(url.searchParams.has('format'), false, 'Current-format filtering omits eligible historical cards');
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
assert.match(config.cardPool.releaseBasis,/any region, including North America/);
assert.equal(config.version.effectiveDate, '2025-04-07');
assert.equal(config.adminConfigured, false);
const starting = await get('/list');
assert.equal(starting.baseline.source, 'tcg-apr-2025');
assert.equal(starting.changes.length, 0);
assert.deepEqual(starting.recentChanges, []);
assert.equal(starting.entries.length, 207);
assert.equal(starting.entries.filter(e=>e.status==='forbidden').length,109);
assert.equal(starting.entries.filter(e=>e.status==='limited').length,82);
assert.equal(starting.entries.filter(e=>e.status==='semi_limited').length,16);
assert.equal(starting.entries.find(e=>e.name==='ABYSS DWELLER').status,'forbidden');
assert.equal(starting.entries.find(e=>e.name==='DIMENSION SHIFTER').status,'limited');
assert.equal(starting.entries.find(e=>e.name==='EXT RYZEAL').status,'semi_limited');
assert(!starting.entries.some(e=>e.name.includes('K9-04')));
assert(!starting.entries.some(e=>e.isHouseChange));

const eventsAtStart = await get('/events');
assert.equal(eventsAtStart.timezone, 'Europe/London');
const HOUSE_FORMAT_DEBUT = config.settings.house_event_start;
const addDays = (date, days) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate()+days);
  return value.toISOString().slice(0,10);
};
const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();
const lastThursday = date => {
  const [year,month] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year,month,0));
  value.setUTCDate(value.getUTCDate()-(value.getUTCDay()-4+7)%7);
  return value.toISOString().slice(0,10);
};
let advancedCursor = addDays(eventsAtStart.generatedFor,(4-weekday(eventsAtStart.generatedFor)+7)%7);
const expectedAdvancedDates = [];
while (expectedAdvancedDates.length<4) {
  if (!(advancedCursor>=HOUSE_FORMAT_DEBUT && advancedCursor===lastThursday(advancedCursor))) expectedAdvancedDates.push(advancedCursor);
  advancedCursor=addDays(advancedCursor,7);
}
const recurringEvents = eventsAtStart.events.filter(event=>event.source==='recurring');
const advancedEvents = recurringEvents.filter(event=>event.slug==='yugioh-advanced-thursday');
const houseEvents = recurringEvents.filter(event=>event.slug==='yugioh-house-friday');
assert.equal(recurringEvents.length,8);
assert.equal(advancedEvents.length,4);
assert.equal(houseEvents.length,4);
assert.deepEqual(advancedEvents.map(event=>event.eventDate),expectedAdvancedDates);
assert(recurringEvents.every(event=>weekday(event.eventDate)===4));
assert(recurringEvents.every(event=>event.eventDate>=eventsAtStart.generatedFor));
assert(houseEvents.every(event=>event.eventDate===lastThursday(event.eventDate)));
assert(houseEvents.every(event=>event.eventDate>=HOUSE_FORMAT_DEBUT));
if (eventsAtStart.generatedFor<=HOUSE_FORMAT_DEBUT) assert.equal(houseEvents[0].eventDate,HOUSE_FORMAT_DEBUT);
assert(!advancedEvents.some(event=>houseEvents.some(house=>house.eventDate===event.eventDate)));
assert(eventsAtStart.events.every(event=>event.source==='recurring' && event.status==='scheduled'));

async function eventsAt(iso) {
  const RealDate = globalThis.Date;
  const fixedTime = new RealDate(iso).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixedTime])); }
    static now() { return fixedTime; }
  };
  try { return await get('/events'); }
  finally { globalThis.Date = RealDate; }
}
const beforeHouseEnd = await eventsAt('2026-11-26T20:59:00Z');
assert.equal(beforeHouseEnd.events.find(event=>event.slug==='yugioh-house-friday')?.eventDate,'2026-11-26');
const afterHouseEnd = await eventsAt('2026-11-26T21:01:00Z');
assert.equal(afterHouseEnd.events.find(event=>event.slug==='yugioh-house-friday')?.eventDate,'2026-12-31');
const afterYearEnd = await eventsAt('2026-12-31T21:01:00Z');
assert.equal(afterYearEnd.events.find(event=>event.slug==='yugioh-house-friday')?.eventDate,'2027-01-28');
db.exec(`INSERT INTO special_events(title,event_date,start_time,end_time,location,description,status,created_at,updated_at)
  VALUES ('All-day JUSH fixture','2026-11-26','','','Guild of Games, Rotherham','','scheduled','fixture','fixture')`);
assert((await eventsAt('2026-11-26T23:59:00Z')).events.some(event=>event.title==='All-day JUSH fixture'));
assert(!(await eventsAt('2026-11-27T00:01:00Z')).events.some(event=>event.title==='All-day JUSH fixture'));
db.exec("DELETE FROM special_events WHERE title='All-day JUSH fixture'");

const unauthed = await req('/admin/draft');
assert.equal(unauthed.status, 401);
assert.equal((await req('/admin/events')).status, 401);

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

// Homepage events: recurring edits are occurrence-specific and one-off events
// are manageable by the same protected admin session for the upcoming schedule.
const eventAdmin = await get('/admin/events');
const advancedOccurrence = eventAdmin.events.find(event=>event.slug==='yugioh-advanced-thursday');
assert(eventAdmin.events.filter(event=>event.source==='recurring').every(event=>event.startTime==='17:30' && event.endTime==='21:00'));
assert.equal((await req(`/admin/events/recurring/${advancedOccurrence.seriesId}`, 'PATCH', {eventDate:advancedOccurrence.eventDate,endTime:'16:00'})).status,400);
const cancelledOccurrence = await req(`/admin/events/recurring/${advancedOccurrence.seriesId}`, 'PATCH', {
  title: advancedOccurrence.title, eventDate: advancedOccurrence.eventDate, startTime: '18:30',
  location: advancedOccurrence.location, description: 'Cancelled fixture.', status: 'cancelled'
});
assert.equal(cancelledOccurrence.status, 200);
let publicEvents = await get('/events');
assert.equal(publicEvents.events.find(event=>event.slug==='yugioh-advanced-thursday').status, 'cancelled');
assert.equal(publicEvents.events.find(event=>event.slug==='yugioh-advanced-thursday').startTime, '18:30');
assert.equal(publicEvents.events.find(event=>event.slug==='yugioh-advanced-thursday').endTime, '21:00');
assert.equal((await req(`/admin/events/recurring/${advancedOccurrence.seriesId}`, 'PATCH', {
  eventDate:advancedOccurrence.eventDate,endTime:'21:30'
})).status,200);
const partialOccurrence = (await get('/events')).events.find(event=>event.slug==='yugioh-advanced-thursday');
assert.equal(partialOccurrence.status,'cancelled');
assert.equal(partialOccurrence.startTime,'18:30');
assert.equal(partialOccurrence.description,'Cancelled fixture.');
assert.equal(partialOccurrence.endTime,'21:30');

assert.equal((await req(`/admin/events/recurring/${advancedOccurrence.seriesId}/override?date=${advancedOccurrence.eventDate}`, 'DELETE')).status, 200);
publicEvents = await get('/events');
assert.equal(publicEvents.events.find(event=>event.slug==='yugioh-advanced-thursday').status, 'scheduled');

const upcomingDate = addDays(eventsAtStart.generatedFor,1);
const createdEvent = await req('/admin/events', 'POST', { title:'One-off championship', eventDate:upcomingDate,
  startTime:'12:00', endTime:'16:00', location:'Guild of Games, Rotherham', description:'Single date.', status:'scheduled' });
assert.equal(createdEvent.status, 200);
const createdEventId = (await createdEvent.json()).eventId;
assert((await get('/events')).events.some(event=>event.eventId===createdEventId));
assert.equal((await get('/events')).events.find(event=>event.eventId===createdEventId).endTime,'16:00');
for (const values of [{endTime:'11:00'}, {endTime:'12:00'}, {endTime:'24:00'}, {endTime:'9pm'}, {startTime:'',endTime:'16:00'}]) {
  assert.equal((await req(`/admin/events/${createdEventId}`,'PATCH',values)).status,400);
}
assert.equal((await req(`/admin/events/${createdEventId}`,'PATCH',{endTime:'17:00'})).status,200);
assert.equal((await get('/events')).events.find(event=>event.eventId===createdEventId).endTime,'17:00');

assert.equal((await req(`/admin/events/${createdEventId}`, 'PATCH', { title:'Updated championship', eventDate:upcomingDate,
  startTime:'13:00', location:'Guild of Games, Rotherham', description:'Updated.', status:'cancelled' })).status, 200);
assert.equal((await get('/events')).events.find(event=>event.eventId===createdEventId).status, 'cancelled');
const pastDate = addDays(eventsAtStart.generatedFor,-1);
const earlierEvent = await req('/admin/events', 'POST', { title:'Earlier fixture', eventDate:pastDate,
  startTime:'', location:'Guild of Games, Rotherham', description:'', status:'scheduled' });
assert.equal(earlierEvent.status, 200);
assert(!(await get('/events')).events.some(event=>event.title==='Earlier fixture'));
assert.equal((await req(`/admin/events/${createdEventId}`, 'DELETE')).status, 200);
assert(!(await get('/events')).events.some(event=>event.eventId===createdEventId));
assert.equal((await req('/admin/events', 'POST', { title:'Blocked', eventDate:upcomingDate, location:'Shop' }, {token:'wrong'})).status, 403);
assert.equal((await req('/admin/events', 'POST', { title:'Impossible date', eventDate:'2026-02-31', location:'Shop' })).status, 400);

const blockedCsrf = await req('/admin/settings', 'PATCH', {store_name:'Evil'}, {token:'wrong'});
assert.equal(blockedCsrf.status, 403);
const blockedOrigin = await req('/admin/settings', 'PATCH', {store_name:'Evil'}, {origin:'https://stranger.example'});
assert.equal(blockedOrigin.status, 403);
const draft = await get('/admin/draft');
assert.equal(draft.entries.length,207);
assert.equal(draft.changes.length,0);
assert.equal(draft.houseChanges.length,0);

// Eligible cards must appear; post-JUSH card searches and ID submissions must not,
// EVEN IF the upstream API returns post-cutoff cards incorrectly.
const jush = await get('/cards/search?q=Dracotail');
assert.equal(jush.results[0].name,'Dracotail Lukias');
assert.equal(jush.results[0].status,'unlimited');
assert.equal(jush.results[0].isHouseChange,false);
const excluded = await get('/cards/search?q=Post%20JUSH');
assert.deepEqual(excluded.results,[]);
const chimeraSearch = await get('/cards/search?q=Cyberdark%20Chimera');
assert.equal(chimeraSearch.results[0].id,5370235);
assert.equal(chimeraSearch.results[0].tcgDate,'2021-10-14');
assert.equal(chimeraSearch.results[0].status,'unlimited');
assert.equal((await get('/catalogue?q=Chimera')).cards[0].id,5370235);
assert.equal((await req('/cards/resolve','POST',{ids:[5370235]})).status,200);
for (const [name,id,date] of [
  ['Monarchic Perfection',59983249,'2025-07-03'],
  ['Gorgon of Zilofthonia',12067160,'2025-07-03'],
  ['Migratory Zereort',87640391,'2025-05-01']
]) {
  const found=await get(`/cards/search?q=${encodeURIComponent(name)}`);
  assert.equal(found.results[0].id,id);
  assert.equal(found.results[0].tcgDate,date);
}
const translatedLayer=await get('/cards/search?q=Preventing%20the%20Invasion');
assert.equal(translatedLayer.results[0].name,'Layer 19 "Sudden Incursion! Super Quantum Black!!"');
assert.equal(translatedLayer.results[0].tcgDate,'2025-07-03');
// BLMM's North American date qualifies in search, the editor and deck resolution.
for (const card of blmmCards) {
  const found=await get(`/cards/search?q=${encodeURIComponent(card.name)}`);
  assert.equal(found.results[0].id,card.id);
  assert.equal(found.results[0].tcgDate,'2025-06-13');
  assert.equal(found.results[0].status,'unlimited');
  assert.equal((await get(`/catalogue?q=${encodeURIComponent(card.name)}`)).cards[0].id,card.id);
  const resolution=await req('/cards/resolve','POST',{ids:[card.id]});
  assert.equal((await resolution.json()).results[0].outcome,'resolved');
  assert.equal((await req('/admin/draft/entry','POST',{card:{id:card.id},status:'limited'})).status,200);
  assert.equal((await req('/admin/draft/entry','POST',{card:{id:card.id},status:'unlimited'})).status,200);
}
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
assert.equal(currentDraft.houseChanges.length,2);
assert(currentDraft.entries.find(e=>e.name==='ABYSS DWELLER').isHouseChange);
assert(currentDraft.entries.find(e=>e.name==='Dracotail Lukias').isHouseChange);
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
assert.equal(current.recentChanges.length,2);
assert.deepEqual(current.recentChanges.map(e=>e.name), ['ABYSS DWELLER','Dracotail Lukias']);
assert(current.changes.every(e=>e.isHouseChange));
assert.equal(current.changes.find(e=>e.name==='ABYSS DWELLER').baselineStatus,'forbidden');
assert.equal(current.changes.find(e=>e.name==='Dracotail Lukias').baselineStatus,'unlimited');

// A later publication must keep every deviation from the fixed foundation marked,
// even when only one additional card changed since the previous house version.
await get('/admin/draft');
const addSecondVersion = await req('/admin/draft/entry','POST',{card:{id:5555},status:'limited'});
assert.equal(addSecondVersion.status,200);
const secondDraft = await get('/admin/draft');
assert.equal(secondDraft.changes.length,1);
assert.equal(secondDraft.houseChanges.length,3);
const secondPublish = await req('/admin/publish','POST',{versionLabel:'JUSH Local v2',effectiveDate:'2025-08-02',summary:'One more house tweak.'});
assert.equal(secondPublish.status,200);
const secondCurrent = await get('/list');
assert.equal(secondCurrent.changes.length,3);
assert.deepEqual(secondCurrent.changes.map(e=>e.name), ['ABYSS DWELLER','Dracotail Lukias','Droll & Lock Bird']);
assert.deepEqual(secondCurrent.recentChanges.map(e=>e.name), ['Droll & Lock Bird']);
assert.equal(secondCurrent.recentChanges[0].previousStatus,'unlimited');
assert.equal(secondCurrent.recentChanges[0].status,'limited');
const versions = await get('/admin/versions');
assert.equal(versions.versions.filter(e=>e.status==='published').length,3);
const restore = await req('/admin/versions/1/restore','POST',{});
assert.equal(restore.status,200);
const restored = await get('/admin/draft');
assert.equal(restored.entries.length,207);
assert.equal(restored.entries.find(e=>e.name==='ABYSS DWELLER').status,'forbidden');
assert.equal((await get('/list')).version.label,'JUSH Local v2');
// Publish the restored older snapshot, then make a note-only draft.
const restoredPublish = await req('/admin/publish','POST',{versionLabel:'Restored foundation',effectiveDate:'2025-08-01',summary:'Restored the foundation.'});
assert.equal(restoredPublish.status,200);
const restoredCurrent = await get('/list');
assert.equal(restoredCurrent.changes.length,0);
assert.equal(restoredCurrent.recentChanges.length,3);
await get('/admin/draft');
// Publishing a note change without a restriction status change must be possible too.
const noteOnly = await req('/admin/draft/entry-by-name','PATCH',{name:'DIMENSION SHIFTER',status:'limited',note:'Store note only.'});
assert.equal(noteOnly.status,200);
assert((await get('/admin/draft')).changes.some(e => e.changeType === 'note_updated'));
const notePublish = await req('/admin/publish','POST',{versionLabel:'Note update',effectiveDate:'2025-08-02',summary:'Updated a store note.'});
assert.equal(notePublish.status,200);
const noteOnlyCurrent = await get('/list');
assert.equal(noteOnlyCurrent.version.label,'Note update');
assert.equal(noteOnlyCurrent.changes.length,0);
assert.equal(noteOnlyCurrent.recentChanges.length,1);
assert.equal(noteOnlyCurrent.recentChanges[0].name,'DIMENSION SHIFTER');
assert.equal(noteOnlyCurrent.recentChanges[0].changeType,'note_updated');

// Deckbuilder catalogue: complete local metadata, artwork aliases, explicit pool
// evidence and published restrictions. The draft below must remain invisible.
const catalogueCards = [
  [1111,'Dracotail Lukias','dracotail lukias','Monster','Effect','Effect Monster','2025-08-01','main','dracotail lukias'],
  [2222,'Ash Blossom & Joyous Spring','ash blossom & joyous spring','Monster','Tuner','Tuner Monster','2017-05-04','main','ash blossom & joyous spring'],
  [4444,'Pot of Greed','pot of greed','Spell','Spell','Spell Card','2002-03-08','main','pot of greed'],
  [6666,'Fixture Fusion Pendulum','fixture fusion pendulum','Monster','Fusion','Pendulum Effect Fusion Monster','2020-01-01','extra','fixture fusion pendulum']
];
const upsertCatalogue = db.prepare(`INSERT INTO cards_cache
  (card_id,name,sort_name,category,subtype,card_type,description,canonical_id,artwork_ids_json,tcg_date,placement,copy_limit_key,pool_verified,metadata_revision,updated_at)
  VALUES (?,?,?,?,?,?,'Fixture text',?,?,?,?,?,1,'test-catalogue',?)
  ON CONFLICT(card_id) DO UPDATE SET canonical_id=excluded.canonical_id,artwork_ids_json=excluded.artwork_ids_json,
  tcg_date=excluded.tcg_date,placement=excluded.placement,copy_limit_key=excluded.copy_limit_key,
  pool_verified=1,metadata_revision=excluded.metadata_revision`);
for (const row of catalogueCards) {
  const [id,name,sortName,category,subtype,cardType,tcgDate,placement,copyKey] = row;
  const artworks = id === 1111 ? '[1111,9111]' : `[${id}]`;
  upsertCatalogue.run(id,name,sortName,category,subtype,cardType,id,artworks,tcgDate,placement,copyKey,new Date().toISOString());
  const searchWords = sortName.split(' ').filter(Boolean);
  for (let index = 0; index < searchWords.length; index += 1)
    db.prepare('INSERT OR IGNORE INTO card_name_search(search_text,card_id) VALUES(?,?)').run(searchWords.slice(index).join(' '),id);
  db.prepare('INSERT OR REPLACE INTO card_id_evidence(input_id,canonical_id,tcg_date,eligible,reason,updated_at) VALUES(?,?,?,1,\'eligible\',?)').run(id,id,tcgDate,new Date().toISOString());
  db.prepare('INSERT OR REPLACE INTO card_artworks(artwork_id,canonical_id,is_default,updated_at) VALUES(?,?,1,?)').run(id,id,new Date().toISOString());
}
db.prepare('INSERT OR REPLACE INTO card_id_evidence(input_id,canonical_id,tcg_date,eligible,reason,updated_at) VALUES(9111,1111,\'2025-08-01\',1,\'eligible\',?)').run(new Date().toISOString());
db.prepare('INSERT OR REPLACE INTO card_artworks(artwork_id,canonical_id,is_default,updated_at) VALUES(9111,1111,0,?)').run(new Date().toISOString());
db.prepare('INSERT OR REPLACE INTO card_id_evidence(input_id,canonical_id,tcg_date,eligible,reason,updated_at) VALUES(3333,3333,\'2026-02-07\',0,\'outside_pool\',?)').run(new Date().toISOString());
for (const [key,value] of [['complete','1'],['revision','test-catalogue'],['eligible_cards','4'],['source','fixture']])
  db.prepare('INSERT OR REPLACE INTO catalogue_meta(key,value) VALUES(?,?)').run(key,value);

await get('/admin/draft');
assert.equal((await req('/admin/draft/entry','POST',{card:{id:1111},status:'forbidden'})).status,200);
const catalogue = await get('/catalogue?q=dracotail&limit=10');
assert.equal(catalogue.catalogue.complete,true);
assert.equal(catalogue.cards.length,1);
assert.equal(catalogue.cards[0].name,'Dracotail Lukias');
assert.equal(catalogue.cards[0].status,'unlimited'); // unpublished draft ignored
assert.equal(catalogue.cards[0].placement,'main');
assert.deepEqual(catalogue.cards[0].artworkIds,[1111,9111]);
const wordPartialCatalogue = await get('/catalogue?q=luk&limit=10');
assert.equal(wordPartialCatalogue.cards[0].name,'Dracotail Lukias');

const filteredCatalogue = await get('/catalogue?category=Monster&subtype=Fusion&attribute=DARK&limit=10');
assert.equal(filteredCatalogue.cards.length,0);
const statusCatalogue = await get('/catalogue?status=forbidden&q=pot');
assert.equal(statusCatalogue.cards[0].name,'Pot of Greed');

const resolvedResponse = await req('/cards/resolve','POST',{ids:[1111,9111,3333,999999]});
assert.equal(resolvedResponse.status,200);
const resolved = (await resolvedResponse.json()).results;
assert.deepEqual(resolved.map(item=>item.outcome),['resolved','resolved','outside_pool','unknown_id']);
assert.equal(resolved[1].canonicalId,1111);
assert.equal(resolved[1].artworkId,9111);

const rejectedResolution = await req('/cards/resolve','POST',{ids:Array(513).fill(1111)});
assert.equal(rejectedResolution.status,400);
const validationResponse = await req('/decks/validate','POST',{
  main:[1111,9111,1111,1111,6666,3333,999999,4444], extra:[], side:[]
});
assert.equal(validationResponse.status,200);
const validation = await validationResponse.json();
assert.equal(validation.verified,true);
assert.equal(validation.legal,false);
assert.equal(validation.version.label,'Note update');
assert(validation.issues.some(issue=>issue.code==='too_many_copies' && issue.name==='Dracotail Lukias'));
assert(validation.issues.some(issue=>issue.code==='wrong_section' && issue.name==='Fixture Fusion Pendulum'));
assert(validation.issues.some(issue=>issue.code==='outside_pool'));
assert(validation.issues.some(issue=>issue.code==='unknown_id'));
assert(validation.issues.some(issue=>issue.code==='forbidden' && issue.name==='Pot of Greed'));

const noBindingImage = await req('/cards/1111/image?size=thumb&v=2');
assert.equal(noBindingImage.status,503);
assert.equal(noBindingImage.headers.get('cache-control'),'no-store');
const noBindingCover = await req('/cards/1111/image?size=cover&v=2');
assert.equal(noBindingCover.status,503, 'Eligible cropped cover art uses the private image cache path');
const unknownVersionedImage = await req('/cards/3333/image?size=full&v=2');
assert.equal(unknownVersionedImage.status,404);

const img = await req('/cards/1111/image');
assert.equal(img.headers.get('content-type'),'image/svg+xml'); // No R2 configured, never hotlinks.
const imgOutside = await req('/cards/3333/image');
assert.equal(imgOutside.headers.get('content-type'),'image/svg+xml');

// With R2 bound, the first eligible request populates the private cache and later
// requests are served from it without another artwork-host request.
const imageObjects = new Map();
let imageReads = 0;
let imageFetches = 0;
contextBase.env.GOG_IMAGES = {
  async get(key) { imageReads += 1; const body = imageObjects.get(key); return body ? { body, size: body.byteLength } : null; },
  async put(key, value) { imageObjects.set(key, value); },
  async delete(key) { imageObjects.delete(key); }
};
const catalogueFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (!String(url).startsWith('https://images.ygoprodeck.com/')) return catalogueFetch(url);
  assert(String(url).includes('/images/cards_small/'), `Unexpected thumbnail URL: ${url}`);
  imageFetches += 1;
  return new Response(new Uint8Array([0xff,0xd8,0xff,0xd9]), { headers: { 'Content-Type':'image/jpeg' } });
};
const storedImage = await req('/cards/1111/image');
assert.equal(storedImage.headers.get('content-type'),'image/jpeg');
assert.equal(storedImage.headers.get('x-gog-image-cache'),'stored');
const cachedImage = await req('/cards/1111/image');
assert.equal(cachedImage.headers.get('content-type'),'image/jpeg');
assert.equal(cachedImage.headers.get('x-gog-image-cache'),'hit');
assert.equal(imageFetches,1);
let operationUsage = db.prepare('SELECT class_a_operations,class_b_operations FROM r2_operation_usage').get();
assert.equal(operationUsage.class_a_operations,1);
assert.equal(operationUsage.class_b_operations,2);

// A confirmed R2 object left behind by an interrupted ledger write is adopted
// without another provider fetch, and its conservative reservation is released.
const recoveredCoverBytes = new Uint8Array([0xff,0xd8,0x01,0xff,0xd9]);
imageObjects.set('cards-cropped/1111.jpg', recoveredCoverBytes);
db.prepare(`INSERT INTO image_cache_reservations(asset_key,size_bytes,token,created_at) VALUES(?,?,?,?)`)
  .run('cards-cropped/1111.jpg', recoveredCoverBytes.byteLength, 'cover-recovery', new Date().toISOString());
const fetchesBeforeRecovery = imageFetches;
const recoveredCover = await req('/cards/1111/image?size=cover&v=2');
assert.equal(recoveredCover.headers.get('x-gog-image-cache'),'hit');
assert.equal(imageFetches,fetchesBeforeRecovery);
assert.equal(db.prepare(`SELECT variant FROM image_cache_v2 WHERE asset_key='cards-cropped/1111.jpg'`).get().variant,'cover');
assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM image_cache_reservations WHERE asset_key='cards-cropped/1111.jpg'`).get().n,0);

// The cache never writes beyond 5 GB; artwork still renders when storage is full.
imageObjects.clear();
db.prepare('DELETE FROM image_cache').run();
db.prepare('INSERT INTO image_cache(card_id,size_bytes,cached_at) VALUES(9999,5000000000,?)').run(new Date().toISOString());
const cappedImage = await req('/cards/1111/image');
assert.equal(cappedImage.headers.get('content-type'),'image/jpeg');
assert.equal(cappedImage.headers.get('x-gog-image-cache'),'bypass-limit');
assert.equal(imageObjects.size,0);
assert.equal(imageFetches,2);

// R2 operations stop at conservative monthly ceilings, leaving 90% of each
// Cloudflare allowance available for billing-cycle overlap and maintenance.
const usageMonth = new Date().toISOString().slice(0,7);
db.prepare('DELETE FROM image_cache').run();
db.prepare('UPDATE r2_operation_usage SET class_a_operations=100000,class_b_operations=3 WHERE usage_month=?').run(usageMonth);
const classACappedImage = await req('/cards/1111/image');
assert.equal(classACappedImage.headers.get('content-type'),'image/jpeg');
assert.equal(classACappedImage.headers.get('x-gog-image-cache'),'bypass-operation-limit');
assert.equal(imageObjects.size,0);
assert.equal(imageFetches,3);
operationUsage = db.prepare('SELECT class_a_operations,class_b_operations FROM r2_operation_usage WHERE usage_month=?').get(usageMonth);
assert.equal(operationUsage.class_a_operations,100000);
assert.equal(operationUsage.class_b_operations,4);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_cache_reservations').get().n,0, 'Class A cap releases unused storage reservation');

db.prepare('UPDATE r2_operation_usage SET class_b_operations=1000000 WHERE usage_month=?').run(usageMonth);
const readsBeforeCap = imageReads;
const fetchesBeforeCap = imageFetches;
const classBCappedImage = await req('/cards/1111/image');
assert.equal(classBCappedImage.headers.get('content-type'),'image/svg+xml');
assert.equal(classBCappedImage.headers.get('x-gog-image-cache'),'operation-limit');
assert.equal(imageReads,readsBeforeCap);
assert.equal(imageFetches,fetchesBeforeCap);

// Cloudflare's edge cache is checked before D1 and R2. A second request at the
// same edge therefore consumes no R2 operation at all.
db.prepare('DELETE FROM image_cache').run();
db.prepare('UPDATE r2_operation_usage SET class_a_operations=0,class_b_operations=0 WHERE usage_month=?').run(usageMonth);
imageObjects.clear();
const originalCaches = globalThis.caches;
const edgeObjects = new Map();
globalThis.caches = { default: {
  async match(key) { return edgeObjects.get(key.url)?.clone() || null; },
  async put(key, value) { edgeObjects.set(key.url, value.clone()); }
} };
const readsBeforeEdge = imageReads;
const edgeStoredImage = await req('/cards/1111/image');
assert.equal(edgeStoredImage.headers.get('x-gog-image-cache'),'stored');
imageObjects.clear();
const edgeCachedImage = await req('/cards/1111/image');
assert.equal(edgeCachedImage.headers.get('content-type'),'image/jpeg');
assert.equal(edgeCachedImage.headers.get('x-gog-image-cache'),'edge');
assert.equal(imageReads,readsBeforeEdge+1);
if (originalCaches === undefined) delete globalThis.caches;
else globalThis.caches = originalCaches;
const resetImageCache = () => {
  imageObjects.clear();
  db.exec('DELETE FROM image_cache; DELETE FROM image_cache_v2; DELETE FROM image_cache_reservations; DELETE FROM r2_operation_usage;');
  assert.equal(db.prepare('SELECT size_bytes FROM image_storage_usage').get().size_bytes,0);
};
const storageBytes = () => db.prepare('SELECT size_bytes FROM image_storage_usage').get().size_bytes;
resetImageCache();
db.prepare('INSERT INTO image_cache VALUES(9999,4999999996,?)').run(new Date().toISOString());
const imageQueryStart = preparedQueries.length;
const racingImages = await Promise.all([1111,2222,4444].map(id=>req(`/cards/${id}/image`)));
assert(racingImages.every(response=>response.headers.get('content-type')==='image/jpeg'));
assert.equal(imageObjects.size,1, 'Concurrent images reserve the final four bytes only once');
assert.equal(storageBytes(),5000000000);
assert.equal(db.prepare('SELECT class_a_operations FROM r2_operation_usage').get().class_a_operations,1);
assert(!preparedQueries.slice(imageQueryStart).some(sql=>/SUM\s*\(size_bytes\)/i.test(sql)), 'Image requests never rescan the storage ledgers');

resetImageCache();
await Promise.all([req('/cards/1111/image'),req('/cards/1111/image')]);
assert.equal(storageBytes(),4, 'Concurrent requests for the same key reserve and store it once');
assert.equal(db.prepare('SELECT class_a_operations FROM r2_operation_usage').get().class_a_operations,1);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_cache_reservations').get().n,0);

resetImageCache();
failImageFinalisation = true;
const finalisationFailed = await req('/cards/1111/image');
failImageFinalisation = false;
assert.equal(finalisationFailed.headers.get('x-gog-image-cache'),'bypass-error');
assert.equal(imageObjects.size,1);
assert.equal(storageBytes(),4, 'A rolled-back accounting batch retains reserved bytes for the uploaded object');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_cache_reservations').get().n,1);
assert.equal((await req('/cards/1111/image')).headers.get('x-gog-image-cache'),'hit');
assert.equal(storageBytes(),4);

const workingPut = contextBase.env.GOG_IMAGES.put;
for (const committed of [false,true]) {
  resetImageCache();
  contextBase.env.GOG_IMAGES.put = async (key,value) => {
    if (committed) imageObjects.set(key,value);
    throw new Error('Uncertain R2 upload outcome');
  };
  assert.equal((await req('/cards/1111/image')).headers.get('content-type'),'image/jpeg');
  assert.equal(storageBytes(),4, 'Uncertain upload outcomes remain conservatively counted');
}
contextBase.env.GOG_IMAGES.put = workingPut;
resetImageCache();
globalThis.fetch = catalogueFetch;
delete contextBase.env.GOG_IMAGES;

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
console.log(`Passed: homepage event recurrence/admin controls, 207-card foundation, persistent baseline markers, JUSH cutoff, spoofing resistance, PBKDF2/HMAC browser auth, CSRF, drafts, publication, restore, edge caching, and R2 storage/operation caps (${fetchCount} simulated upstream requests).`);
globalThis.fetch = fetchOriginal;
