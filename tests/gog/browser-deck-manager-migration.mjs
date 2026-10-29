#!/usr/bin/env node
/** Verifies the v1 -> v2 local-deck migration without touching production data. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const origin = process.argv[2] || 'http://127.0.0.1:8790';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Migration regression must run locally.');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = await mkdtemp(join(tmpdir(), 'gog-deck-migration-'));
const debugPort = 9600 + Math.floor(Math.random() * 200);
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--window-size=1280,900', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeError = '';
chrome.stderr.on('data', (chunk) => { chromeError += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollJson(url, options) {
  let last;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const response = await fetch(url, options); if (response.ok) return response.json(); last = new Error(`HTTP ${response.status}`); }
    catch (error) { last = error; }
    await sleep(100);
  }
  throw last || new Error(`Timed out waiting for ${url}`);
}

const target = await pollJson(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${origin}/gog/`)}`, { method: 'PUT' });
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let commandId = 0;
const pending = new Map();
const errors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++commandId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error.message)); else request?.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.text || 'Runtime exception');
  if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params.entry.level)) errors.push(message.params.entry.text);
};
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
async function waitFor(expression, label, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await waitFor(`location.pathname==='/gog/' && document.readyState==='complete'`, 'same-origin seed page');
  const legacy = [
    { id: 'legacy-alpha', name: 'Same name', revision: 7, createdAt: '2025-01-02T03:04:05.000Z', updatedAt: '2025-06-07T08:09:10.000Z' },
    { id: 'legacy-beta', name: 'Same name', revision: 2, createdAt: '2024-02-03T04:05:06.000Z', updatedAt: '2025-07-08T09:10:11.000Z' }
  ];
  await evaluate(`new Promise((resolve,reject)=>{const request=indexedDB.open('gog-jush-deckbuilder-v1',1);request.onupgradeneeded=()=>{const db=request.result;const decks=db.createObjectStore('decks',{keyPath:'id'});decks.createIndex('updatedAt','updatedAt');db.createObjectStore('meta',{keyPath:'key'});};request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction(['decks','meta'],'readwrite'),store=tx.objectStore('decks');for(const item of ${JSON.stringify(legacy)}) store.put({...item,schemaVersion:1,formatId:'gog-jush',main:[],extra:[],side:[],groups:[],notes:''});tx.objectStore('meta').put({key:'currentDeckId',value:'legacy-alpha'});tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error);};})`);
  await evaluate(`location.href=${JSON.stringify(`${origin}/gog/deckbuilder/`)}`);
  await waitFor(`location.pathname==='/gog/deckbuilder/' && document.querySelector('#saved-label')?.textContent.includes('Saved')`, 'migrated deckbuilder');
  await evaluate(`document.querySelector('#saved-decks-button').click()`);
  await waitFor(`document.querySelector('#deck-manager-dialog')?.open && document.querySelectorAll('.deck-manager-row').length===2`, 'two migrated duplicate-name decks');
  const result = await evaluate(`new Promise((resolve,reject)=>{const request=indexedDB.open('gog-jush-deckbuilder-v1');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,stores=[...db.objectStoreNames],tx=db.transaction(['decks','migrationBackups'],'readonly');Promise.all([new Promise((r,j)=>{const q=tx.objectStore('decks').getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)}),new Promise((r,j)=>{const q=tx.objectStore('migrationBackups').getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)})]).then(([decks,backups])=>resolve({version:db.version,stores,decks,backups})).catch(reject);};})`);
  assert.equal(result.version, 2);
  assert.deepEqual(['folders', 'recentDecks', 'migrationBackups'].filter((name) => !result.stores.includes(name)), []);
  assert.equal(result.decks.length, 2, 'Migration keeps duplicate-name decks separate');
  for (const source of legacy) {
    const migrated = result.decks.find((deck) => deck.id === source.id);
    assert(migrated, `Stable ID ${source.id} is preserved`);
    assert.equal(migrated.name, source.name); assert.equal(migrated.revision, source.revision);
    assert.equal(migrated.createdAt, source.createdAt); assert.equal(migrated.updatedAt, source.updatedAt);
    assert.equal(migrated.folderId, null);
    const backup = result.backups.find((entry) => entry.key === `pre-v2:${source.id}`);
    assert(backup, `Pre-migration backup for ${source.id} exists`);
    assert.equal(backup.deck.id, source.id); assert.equal(backup.deck.updatedAt, source.updatedAt);
  }
  assert.equal(errors.length, 0, `Console errors: ${errors.join(' | ')}`);
  console.log('PASS v1 -> v2 deck migration preserves duplicate names, IDs, timestamps, revisions and backups');
} finally {
  try { socket.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(async () => {
    if (process.platform === 'win32') await rm(`\\\\?\\${profile.split(sep).join('\\')}`, { recursive: true, force: true }).catch(() => {});
  });
  if (chrome.exitCode && chrome.exitCode !== 0) console.error(chromeError);
}
