#!/usr/bin/env node
/** Browser-level template catalogue test with a static server and mocked read-only API. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const publicRoot = resolve(import.meta.dirname, '../../public');
const mime = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
    if (/^\/gog\/api\/cards\/\d+\/image$/.test(pathname)) {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="14"/>'); return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const relative = normalize(pathname).replace(/^[/\\]+/, '');
    const file = resolve(publicRoot, relative);
    if (!file.startsWith(publicRoot)) throw new Error('Invalid path');
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); response.end(body);
  } catch { response.writeHead(404).end('Not found'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = await mkdtemp(join(tmpdir(), 'gog-templates-chrome-'));
const debugPort = 9500 + Math.floor(Math.random() * 300);
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'],
{ stdio: ['ignore', 'ignore', 'pipe'] });
let chromeError = ''; chrome.stderr.on('data', chunk => { chromeError += chunk; });
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function pollJson(url, options) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const response = await fetch(url, options); if (response.ok) return response.json(); } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}. ${chromeError}`);
}

const version = await pollJson(`http://127.0.0.1:${debugPort}/json/version`);
const target = await pollJson(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
let commandId = 0; const pending = new Map(); const consoleErrors = []; const failedResponses = [];
const send = (method, params = {}) => new Promise((done, reject) => {
  const id = ++commandId; pending.set(id, { done, reject }); socket.send(JSON.stringify({ id, method, params }));
});
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error.message)); else request?.done(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
  else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(message.params.entry.text);
  else if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) failedResponses.push(message.params.response.url);
};
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
async function waitFor(expression, label, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = await evaluate(expression); if (value) return value; await sleep(100); }
  throw new Error(`Timed out waiting for ${label}. Console: ${consoleErrors.join(' | ')}`);
}
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const setValue = (selector, value) => evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);

const apiMock = `(() => {
  const nativeFetch = window.fetch.bind(window);
  const json = value => Promise.resolve(new Response(JSON.stringify(value), {status:200,headers:{'Content-Type':'application/json'}}));
  let cardMapPromise;
  const cardMap = () => cardMapPromise ||= nativeFetch('/gog/deckbuilder/template-decks.json').then(r=>r.json()).then(manifest => {
    const map = new Map();
    for (const deck of manifest.decks) for (const zone of ['main','extra','side']) for (const item of deck[zone]) {
      const current = map.get(item.id); const placement = zone === 'extra' ? 'extra' : current?.placement || 'main';
      map.set(item.id,{name:item.name,placement});
    }
    return map;
  });
  window.fetch = async (input, options={}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/gog/api')) return nativeFetch(input, options);
    if (/\\/cards\\/\\d+\\/image$/.test(url.pathname)) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="14"/>',{status:200,headers:{'Content-Type':'image/svg+xml'}});
    if (url.pathname.endsWith('/config')) return json({version:{id:13,label:'House List v1.0'},poolRevision:'fixture'});
    if (url.pathname.endsWith('/catalogue')) return json({cards:[],hasMore:false,catalogue:{eligibleCards:13266},version:{id:13,label:'House List v1.0'}});
    if (url.pathname.endsWith('/cards/resolve')) {
      const map = await cardMap(); const ids = JSON.parse(options.body).ids;
      return json({results:ids.map(inputId=>{const source=map.get(Number(inputId));return source ? {inputId:Number(inputId),outcome:'resolved',artworkId:Number(inputId),card:{id:Number(inputId),canonicalId:Number(inputId),artworkId:Number(inputId),name:source.name,category:'Monster',subtype:source.placement==='extra'?'Fusion':'Effect',cardType:source.placement==='extra'?'Fusion Monster':'Effect Monster',placement:source.placement,copyLimitKey:String(inputId),status:'unlimited',copies:3,poolVerified:true,description:'Template browser fixture.'}}:{inputId:Number(inputId),outcome:'unknown_id'}})});
    }
    if (url.pathname.endsWith('/decks/validate')) return json({verified:true,legal:true,issues:[],cards:[],version:{id:13,label:'House List v1.0'},poolRevision:'fixture',checkedAt:new Date().toISOString()});
    return json({error:'Unexpected API mock path'});
  };
})()`;

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: apiMock });
  await send('Page.navigate', { url: `${origin}/gog/deckbuilder/` });
  await waitFor(`document.querySelector('#saved-label')?.textContent.includes('Saved')`, 'deckbuilder storage');
  const order = await evaluate(`(() => {const t=document.querySelector('#templates-button').getBoundingClientRect(),i=document.querySelector('#import-button').getBoundingClientRect();return {template:t.left,import:i.left,visible:getComputedStyle(document.querySelector('#templates-button')).display}})()`);
  assert.notEqual(order.visible, 'none'); assert(order.template < order.import, 'Template Decks belongs to the left of Import');

  await click('#templates-button');
  await waitFor(`document.querySelector('#template-result-count')?.textContent === '397 of 397 decks'`, '397 template decks');
  assert.equal(await evaluate(`document.querySelectorAll('.template-list-item').length`), 397);
  const desktopLayout = await evaluate(`(() => {const d=document.querySelector('#templates-dialog'),r=d.getBoundingClientRect();return {open:d.open,width:r.width,height:r.height,overflow:Math.max(d.scrollWidth-d.clientWidth,document.documentElement.scrollWidth-innerWidth)}})()`);
  assert(desktopLayout.open && desktopLayout.width > 900 && desktopLayout.height > 650 && desktopLayout.overflow <= 1, 'Desktop catalogue should be a spacious, non-overflowing popout');
  await setValue('#template-search', 'Ame no Habakiri');
  await waitFor(`document.querySelectorAll('.template-list-item').length > 0 && document.querySelectorAll('.template-list-item').length < 397`, 'card-name search');
  await click('.template-list-item');
  assert.match(await evaluate(`document.querySelector('#template-detail-name').textContent`), /Mitsurugi/i);
  assert(await evaluate(`document.querySelector('#template-cardlist-zones').textContent.includes('Ame no Habakiri')`));
  await click('#copy-template');
  await waitFor(`!document.querySelector('#templates-dialog').open && document.querySelector('#deck-name').textContent.includes('Mitsurugi')`, 'template copy');
  const copied = await evaluate(`({name:document.querySelector('#deck-name').textContent,main:Number(document.querySelector('#count-main').textContent),extra:Number(document.querySelector('#count-extra').textContent),side:Number(document.querySelector('#count-side').textContent)})`);
  assert(copied.main >= 40 && copied.extra <= 15 && copied.side <= 15, 'Copied deck should open with complete legal-size sections');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(250); await click('#mobile-actions-button');
  await waitFor(`document.querySelector('#mobile-actions-dialog').open`, 'mobile actions');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#templates-button')).display`), 'none');
  assert.equal(await evaluate(`document.querySelector('[data-mobile-command="templates"] small').textContent`), 'Browse 397 starting lists');
  await click('[data-mobile-command="templates"]');
  await waitFor(`document.querySelector('#templates-dialog').open && document.querySelectorAll('.template-list-item').length > 0`, 'mobile template list');
  await setValue('#template-search', 'Dark Magician Toy');
  await waitFor(`document.querySelectorAll('.template-list-item').length === 1`, 'mobile template search');
  await click('.template-list-item');
  assert(await evaluate(`document.querySelector('#templates-dialog').classList.contains('detail-open') && getComputedStyle(document.querySelector('#template-detail')).display !== 'none'`));
  const mobileOverflow = await evaluate(`Math.max(document.querySelector('#templates-dialog').scrollWidth-document.querySelector('#templates-dialog').clientWidth,document.documentElement.scrollWidth-innerWidth)`);
  assert(mobileOverflow <= 1, 'Mobile template detail must not overflow horizontally');
  await click('#template-back');
  assert.equal(await evaluate(`document.querySelector('#templates-dialog').classList.contains('detail-open')`), false);

  assert.deepEqual(consoleErrors, [], `No browser errors expected: ${consoleErrors.join(' | ')}`);
  assert.deepEqual(failedResponses, [], `No failed responses expected: ${failedResponses.join(' | ')}`);
  console.log(JSON.stringify({ chrome: version.Browser, templates: 397, desktop: desktopLayout, copied, mobileOverflow, checks: 'passed' }, null, 2));
} finally {
  socket.close(); chrome.kill(); server.close();
  await Promise.race([new Promise(done => chrome.once('exit', done)), sleep(1500)]);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
