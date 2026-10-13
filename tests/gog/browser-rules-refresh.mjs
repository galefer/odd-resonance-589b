#!/usr/bin/env node
/** Dependency-free Chrome DevTools smoke test for the local Pages preview. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const origin = process.argv[2] || 'http://127.0.0.1:8790';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const artifacts = resolve(import.meta.dirname, 'artifacts');
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Mocked publication regression must run locally.');
const profile = await mkdtemp(join(tmpdir(), 'gog-deckbuilder-chrome-'));
const debugPort = 9300 + Math.floor(Math.random() * 300);
await mkdir(artifacts, { recursive: true });

const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--window-size=1440,1000', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeError = '';
chrome.stderr.on('data', (chunk) => { chromeError += chunk; });
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function pollJson(url, options) {
  let last;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const response = await fetch(url, options); if (response.ok) return response.json(); last = new Error(`HTTP ${response.status}`); }
    catch (error) { last = error; }
    await sleep(100);
  }
  throw last || new Error(`Timed out waiting for ${url}`);
}

const version = await pollJson(`http://127.0.0.1:${debugPort}/json/version`);
const target = await pollJson(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${origin}/gog/`)}`, { method: 'PUT' });
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolvePromise, reject) => { socket.onopen = resolvePromise; socket.onerror = reject; });
let commandId = 0;
const pending = new Map();
const errors = [];
const failedResponses = [];
const send = (method, params = {}) => new Promise((resolvePromise, reject) => {
  const id = ++commandId; pending.set(id, { resolve: resolvePromise, reject }); socket.send(JSON.stringify({ id, method, params }));
});
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error) request?.reject(new Error(`${message.error.message} (${message.error.code})`)); else request?.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.text || 'Runtime exception');
  if (message.method === 'Log.entryAdded' && ['error','warning'].includes(message.params.entry.level)) errors.push(message.params.entry.text);
  if (message.method === 'Network.responseReceived' && message.params.response.status >= 400)
    failedResponses.push({ status: message.params.response.status, url: message.params.response.url });
  if (message.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
};

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
async function waitFor(expression, label, timeout = 15_000) {
  const started = Date.now(); let value;
  while (Date.now() - started < timeout) {
    value = await evaluate(expression);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(value)}`);
}
const click = (selector) => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing ${selector}'); e.click(); return true; })()`);
const setValue = (selector, value) => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing ${selector}'); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
const screenshot = async (name) => {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(resolve(artifacts, name), Buffer.from(result.data, 'base64'));
};
// Exercise the real UI and IndexedDB against changing published-list fixtures.
// No administrator credentials or production mutations are involved.
const provider = () => {
  const original = window.fetch;
  const limits = { forbidden: 0, limited: 1, semi_limited: 2, unlimited: 3 };
  window.rulesRequests = { config: 0, catalogue: 0, validation: 0 };
  const version = () => ({ id: Number(sessionStorage.rulesVersion || 1), label: `Fixture v${sessionStorage.rulesVersion || 1}` });
  const card = () => ({ id: 93156774, canonicalId: 93156774, artworkId: 93156774,
    name: 'Vanquish Soul Hollie Sue', category: 'Monster', subtype: 'Effect', cardType: 'Effect Monster',
    placement: 'main', copyLimitKey: 'vanquish soul hollie sue', poolVerified: true,
    description: 'Publication refresh fixture.', status: sessionStorage.rulesStatus || 'limited',
    copies: limits[sessionStorage.rulesStatus || 'limited'] });
  window.fetch = async (input, options = {}) => {
    const url = new URL(input, location.href);
    if (url.pathname === '/gog/api/config') {
      window.rulesRequests.config++;
      return Response.json({ version: version() });
    }
    if (url.pathname === '/gog/api/catalogue') {
      window.rulesRequests.catalogue++;
      const filter = url.searchParams.get('status');
      return Response.json({ version: version(), cards: !filter || filter === card().status ? [card()] : [],
        catalogue: { complete: true, revision: 'fixture', eligibleCards: 1 }, hasMore: false });
    }
    if (url.pathname === '/gog/api/cards/resolve') {
      return Response.json({ results: [{ inputId: 93156774, outcome: 'resolved', card: card() }] });
    }
    if (url.pathname === '/gog/api/decks/validate') {
      window.rulesRequests.validation++;
      const body = JSON.parse(options.body), cards = [], issues = [{ code: 'deck_size', zone: 'main', message: 'Minimum 40 cards.' }];
      for (const zone of ['main','extra','side']) body[zone].forEach((inputId, index) => cards.push({
        zone, index, inputId, canonicalId: inputId, artworkId: inputId, outcome: 'resolved', card: card()
      }));
      if (cards.length > card().copies) issues.push({ code: 'too_many_copies', message: 'Too many Hollie Sue copies.' });
      return Response.json({ version: version(), verified: true, legal: false, checkedAt: new Date().toISOString(),
        catalogueComplete: true, cards, issues, counts: Object.fromEntries(['main','extra','side'].map(z => [z, body[z].length])) });
    }
    return original(input, options);
  };
};
try {
  await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable'), send('Log.enable')]);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${provider.toString()})()` });
  await send('Page.navigate', { url: `${origin}/gog/deckbuilder/` });
  await waitFor(`document.querySelector('.library-card button')`, 'fixture catalogue');
  await evaluate(`document.querySelector('.library-card button').dispatchEvent(new PointerEvent('pointerdown',{button:2,buttons:2,bubbles:true,cancelable:true}))`);
  await waitFor(`document.querySelector('#count-main').textContent==='1' && document.querySelector('#saved-label').textContent==='Saved on this device'`, 'saved Limited deck');
  await waitFor(`document.querySelector('#footer-version').textContent.includes('Fixture v1')`, 'first validation');
  assert.equal(await evaluate(`document.querySelector('.card-tile .limit-badge').textContent`), '1');
  const deckId = await evaluate(`document.querySelector('#deck-menu-list button').dataset.deckId`);
  await evaluate(`sessionStorage.rulesVersion='2'; sessionStorage.rulesStatus='unlimited'`);
  await send('Page.reload');
  await waitFor(`document.querySelector('#footer-version').textContent.includes('Fixture v2')`, 'new published version on saved-deck reload');
  assert.equal(await evaluate(`document.querySelectorAll('.card-tile .limit-badge').length`), 0, 'Saved Limited badge must disappear after current validation');
  assert.equal(await evaluate(`document.querySelector('#deck-menu-list button').dataset.deckId`), deckId);
  await click('.card-tile');
  assert.equal(await evaluate(`document.querySelector('#card-status').textContent`), 'Unlimited');
  for (let i=0;i<2;i++) await click('#copy-selected');
  assert.equal(await evaluate(`document.querySelector('#count-main').textContent`), '3');
  await waitFor(`document.querySelector('#validation-summary').textContent.includes('Fixture v2')`, 'three-copy validation');
  await click('#undo'); await click('#redo');
  assert.equal(await evaluate(`document.querySelectorAll('.card-tile .limit-badge').length`), 0);
  await evaluate(`sessionStorage.rulesVersion='3'; sessionStorage.rulesStatus='limited';
    window.dispatchEvent(new StorageEvent('storage',{key:'gog-published-list',newValue:'published-3'}))`);
  await waitFor(`document.querySelector('#footer-version').textContent.includes('Fixture v3')`, 'publication signal refresh');
  assert.equal(await evaluate(`document.querySelectorAll('.card-tile .limit-badge.limited').length`), 3);
  await click('.card-tile');
  assert.equal(await evaluate(`document.querySelector('#card-status').textContent`), 'Limited');
  assert.equal(await evaluate(`document.querySelectorAll('.library-card .restriction-dot.limited').length`), 1);
  assert.equal(await evaluate(`document.querySelector('#count-main').textContent`), '3', 'New limits preserve all deck copies');
  await click('#undo');
  assert.equal(await evaluate(`document.querySelectorAll('.card-tile .limit-badge.limited').length`), 2, 'Undo must retain current rules');
  await click('#redo');
  await waitFor(`document.querySelector('#footer-version').textContent.includes('Fixture v3') && !document.querySelector('#validation-banner').classList.contains('checking')`, 'settled validation');
  // Focus/visibility bursts are coalesced, and there is no continuous polling.
  await sleep(5100);
  const before = await evaluate(`({...window.rulesRequests})`);
  await evaluate(`for(let i=0;i<10;i++){window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));}`);
  await sleep(150);
  const after = await evaluate(`({...window.rulesRequests})`);
  assert.equal(after.config-before.config,1);
  assert.equal(after.validation,before.validation, 'An unchanged list needs no extra validation');
  assert.equal(after.catalogue,before.catalogue, 'An unchanged list needs no extra catalogue request');
  await evaluate(`sessionStorage.rulesVersion='4'; sessionStorage.rulesStatus='unlimited'`);
  await sleep(5000);
  assert.deepEqual(await evaluate(`({...window.rulesRequests})`),after,'No background polling');
  await evaluate(`window.dispatchEvent(new Event('focus'))`);
  await waitFor(`document.querySelector('#footer-version').textContent.includes('Fixture v4')`, 'return-to-tab refresh');
  assert.equal(await evaluate(`document.querySelectorAll('.card-tile .limit-badge').length`), 0);
  await click('.library-card button');
  await setValue('#status-filter','unlimited');
  await waitFor(`document.querySelector('.library-card button')`, 'filtered library selection');
  await evaluate(`sessionStorage.rulesVersion='5';sessionStorage.rulesStatus='limited';window.dispatchEvent(new StorageEvent('storage',{key:'gog-published-list',newValue:'published-5'}))`);
  await waitFor(`document.querySelector('#footer-version').textContent.includes('Fixture v5') && document.querySelector('#card-status').textContent==='Limited'`, 'filtered-out selection refreshed');
  assert.equal(await evaluate(`document.querySelectorAll('.library-card').length`),0);
  await screenshot('published-rules-refreshed.png');
  assert.deepEqual(errors,[]); assert.deepEqual(failedResponses,[]);
  console.log('Passed: persisted Limited badge repaired, inspector/copy limits, publish notification, return-to-tab refresh, undo/redo, preserved copies and coalesced requests (mocked API, real browser/IndexedDB).');
} finally {
  try { socket.close(); } catch {}
  chrome.kill();
  await Promise.race([new Promise(done => chrome.once('exit',done)),sleep(1500)]);
  const tempRoot=resolve(tmpdir()).replace(/[\\/]+$/,'');
  if (profile.startsWith(`${tempRoot}${sep}`)) await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:500});
}
