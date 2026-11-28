import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { onRequest } from '../../functions/gog/api/[[path]].js';
import { settleDue } from '../../lib/jush-settlement.js';
import { tier, standings } from '../../lib/jush-standings.js';
const sql = new DatabaseSync(':memory:');
for (const name of [
  'schema.sql',
  ...['0012_community_votes', '0013_voted_changes', '0014_proposal_admin', '0015_jush_event_app'].map(
    (n) => 'migrations/' + n + '.sql',
  ),
])
  sql.exec(readFileSync(new URL('../../database/' + name, import.meta.url), 'utf8'));
sql.exec(
  "INSERT INTO special_events(title,event_date,start_time,end_time,created_at,updated_at) VALUES('Fixture House Format','2027-01-23','17:30','21:00','test','test')",
);
const RealDate = Date;
let hour = '16:59';
globalThis.Date = class extends RealDate {
  constructor(...a) {
    super(...(a.length ? a : ['2027-01-23T' + hour + ':00Z']));
  }
};
const prepare = (q, args = []) => ({
  bind: (...values) => prepare(q, values),
  first: () => sql.prepare(q).get(...args) ?? null,
  all: () => ({ results: sql.prepare(q).all(...args) }),
  run: () => ({ meta: sql.prepare(q).run(...args) }),
});
const db = {
  prepare,
  batch(xs) {
    sql.exec('BEGIN');
    try {
      const r = xs.map((x) => x.run());
      sql.exec('COMMIT');
      return r;
    } catch (e) {
      sql.exec('ROLLBACK');
      throw e;
    }
  },
};
const env = { GOG_DB: db, GOG_AUTH_PEPPER: 'a'.repeat(40), JUSH_OFFICE_KEY: 'b'.repeat(40) };
async function api(path, actor, body, status = 200) {
  const headers = { 'Content-Type': 'application/json', 'X-JUSH-Action': 'member' };
  if (actor === 'office') headers['X-JUSH-Office'] = env.JUSH_OFFICE_KEY;
  else if (actor) headers.Cookie = actor;
  const url = 'https://test.local/gog/api/' + (actor === 'office' ? 'admin/' : '') + 'community/' + path;
  const response = await onRequest({
    env,
    request: new Request(url, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, status, path + ' ' + JSON.stringify(result));
  return { ...result, cookie: response.headers.get('Set-Cookie') };
}
const a = [],
  event = 'special-1';
for (let i = 0; i < 7; i++) {
  const { code } = await api('issue', 'office', { label: 'Test' });
  const { cookie } = await api('join', null, {
    username: 'Tester' + i,
    code,
    salt: 'a'.repeat(32),
    proof: 'b'.repeat(64),
    remember: i === 0,
  });
  assert.equal(cookie.includes('Max-Age=2592000'), i === 0);
  a.push(cookie.split(';')[0]);
}
const board = (actor) => api('app/board', actor),
  check = (i, staff = false) => api('app/check-in', staff ? 'office' : a[i], { event, member: i + 1 });
const report = (i, j, status = 200, key = crypto.randomUUID()) =>
  api('app/report', a[i], { event, opponent: j + 1, result: 'W', requestId: key }, status);
assert.equal((await board(a[0])).live, false);
await api('app/check-in', a[0], { event }, 409);
hour = '17:00';
assert.equal((await board()).live, true);
assert.deepEqual((await board()).roster, []);
await check(0);
await report(0, 1, 409);
for (let i = 1; i < 7; i++) await check(i, i === 1);
for (let i = 0; i < 4; i++) {
  const key = crypto.randomUUID();
  await report(i, 4, 200, key);
  await report(i, 4, 200, key);
  await report(4, i, 409);
  const before = await board(a[4]),
    m = before.mine[0];
  assert.equal(m.peer.id, i + 1);
  assert.equal(m.result, 'L');
  assert.equal(m.status, 'pending');
  assert.equal(before.me.used, i + 1);
  await api('app/approve', a[i], { event, match: m.id, revision: m.revision }, 403);
  await api('app/approve', a[4], { event, match: m.id, revision: m.revision });
  const [own, rival] = await Promise.all([board(a[4]), board(a[i])]);
  assert.equal(own.me.used, i + 1);
  assert.equal(own.me.l, i + 1);
  assert.equal(own.mine[0].status, 'confirmed');
  assert.equal(own.mine.length, i + 1);
  assert.equal(rival.me.w, 1);
  assert.equal(rival.mine[0].result, 'W');
}
await report(5, 4, 409);
await report(4, 5, 409);
hour = '21:59';
assert.equal((await board()).live, true);
await report(0, 5);
let m = (await board(a[5])).mine[0];
hour = '22:00';
assert.equal((await board()).live, false);
assert.equal((await board()).players.length, 1);
await report(1, 5, 409);
await api('app/reject', a[5], { event, match: m.id, revision: m.revision });
let office = await api('app/office?event=' + event, 'office');
assert.equal(office.matches.find((row) => row.id === m.id).status, 'review');
await api('app/rule', 'office', {
  event,
  match: m.id,
  revision: m.revision + 1,
  result: 'D',
  reason: 'Confirmed draw',
});
assert.equal((await board(a[0])).me.d, 1);
await api(
  'app/rule',
  'office',
  { event, match: m.id, revision: m.revision + 1, result: 'void', reason: 'Stale tab' },
  409,
);
await api('app/rule', 'office', {
  event,
  match: m.id,
  revision: m.revision + 2,
  result: 'void',
  reason: 'Different pairing',
});
assert.equal((await board(a[0])).me.used, 1);
hour = '18:00';
await report(1, 6);
await api('app/event-mode', 'office', { event, mode: 'paused', reason: 'Connection lost' });
sql.exec("UPDATE jush_matches SET due=unixepoch()-2 WHERE status='pending'");
await settleDue(db, true);
assert.equal((await board(a[6])).mine[0].status, 'pending');
await api('app/event-mode', 'office', { event, mode: 'calendar', reason: 'Resumed' });
await settleDue(db, true);
assert.equal((await board(a[6])).mine[0].status, 'auto');
assert.equal((await board(a[6])).me.l, 1);
await api('app/profile', a[0], { name: 'Display', real: 'Private', revision: 0, art: null, showReal: false });
assert.equal((await api('app/profile?id=1', a[1])).real, '');
assert.equal((await api('app/profile?id=1')).real, '');
await api('app/favourite', a[0], { slot: 1, name: 'Deck', zones: { main: [11], extra: [], side: [] } });
const pub = (await api('app/profile?id=1')).favourites[0];
assert.deepEqual((await api('app/deck?share=' + pub.share)).zones.main, [11]);
await api('app/favourite', a[0], { slot: 1, previous: pub.share, remove: true });
await api('app/deck?share=' + pub.share, null, null, 404);
assert.deepEqual([1000, 1050, 1125, 1200, 1300].map(tier), [
  'Duelist',
  'Slifer Red',
  'Ra Gold',
  'Obelisk Diamond',
  'Pharoah',
]);
assert.equal(
  standings(
    [
      { id: 1, username: 'a' },
      { id: 2, username: 'b' },
    ],
    [{ event: 'e', reporter: 1, opponent: 2, result: 'W', status: 'confirmed' }],
  )[0].score,
  1020,
);
const aMatch = (await board(a[4])).mine[0];
await api('app/bye', 'office', { event, member: 5, reason: 'Extra' }, 409);
await api('app/bye', 'office', { event, member: 6, reason: 'Unrated bye' });
assert.equal((await board(a[5])).me.used, 1);
assert.equal((await board(a[5])).me.n, 0);
const bye = (await board(a[5])).byes[0];
await api('app/remove-bye', 'office', { event, bye: bye.id, reason: 'Opponent arrived' });
assert.equal((await board(a[5])).me.used, 0);
const preview = await api('app/preview', 'office', { event, match: aMatch.id, result: 'void' });
assert.ok(preview.changes.some((p) => p.from === 4 && p.to === 3));
await api(
  'app/reassign',
  'office',
  { event, match: aMatch.id, revision: aMatch.revision, opponent: 5, reason: 'Invalid same opponent' },
  400,
);
await api(
  'app/reassign',
  'office',
  { event, match: aMatch.id, revision: aMatch.revision, opponent: 90, reason: 'Not checked in' },
  409,
);
assert.equal((await board(a[4])).me.used, 4);
sql.exec(
  "INSERT INTO cards_cache(card_id,name,sort_name,category,subtype,card_type,pool_verified,tcg_date,updated_at) VALUES(11,'Rehearsal card','rehearsal card','Monster','Effect','Effect Monster',1,'2024-01-01','2024-01-01')",
);
sql.exec("INSERT INTO card_artworks(artwork_id,canonical_id,is_default,updated_at) VALUES(12,11,0,'2024-01-01')");
assert.deepEqual((await api('app/art?q=Rehearsal', a[6])).cards[0].art, [11, 12]);
await api('app/profile', a[6], { revision: 0, name: 'Tester6', real: 'Opted in', showReal: true, art: 12 });
assert.equal((await api('app/profile?id=7')).real, '');
assert.equal((await api('app/profile?id=7', a[5])).real, 'Opted in');
await api('app/favourite', a[6], {
  slot: 1,
  name: 'Rehearsal deck',
  zones: { main: [11, 12], extra: [], side: [] },
});
const fixtureShare = (await api('app/profile?id=7')).favourites[0].share;
assert.equal((await api('app/inbox')).player, null);
assert.deepEqual((await api('app/inbox', a[5])).player, { name: 'Tester5', art: null });
assert.deepEqual((await api('app/inbox', a[6])).player, { name: 'Tester6', art: 12 });
sql.exec(readFileSync(new URL('../../database/seed.sql', import.meta.url), 'utf8'));
sql.exec(`INSERT INTO versions(id,version_label,effective_date,status,previous_version_id,created_at)
  VALUES(2,'Rehearsal','2027-01-23','published',1,'2027-01-23');
  INSERT INTO entries SELECT 2,name,sort_name,card_id,category,subtype,card_type,status,note
    FROM entries WHERE version_id=1;
  INSERT INTO entries VALUES(2,'Rehearsal card','rehearsal card',11,'Monster','Effect','Effect Monster','limited',NULL);`);
export { env, a as testCookies, fixtureShare };
export function setEventTime(value) {
  hour = value;
}
console.log(
  'Event app passed: two-sided receipts, fourth incoming approval, cap, mirrored history, Office check-in and corrections, timer, hours, privacy and decks.',
);
