#!/usr/bin/env node
/** Browser-level template catalogue test with a static server and mocked read-only API. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const publicRoot = resolve(import.meta.dirname, '../../public');
const mime = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
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
  window.__houseVersion = 16;
  window.__templateDataFetches = [];
  window.__templateQualityAttempts = 0;
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
    if (!url.pathname.startsWith('/gog/api')) {
      if (/\\/gog\\/deckbuilder\\/template-(?:decks|presentation|quality)\\.json$/.test(url.pathname)) window.__templateDataFetches.push(url.pathname);
      if (url.pathname.endsWith('/template-quality.json')) {
        window.__templateQualityAttempts += 1;
        if (new URLSearchParams(location.search).has('quality-fail')) return new Response('Unavailable', {status:503});
      }
      return nativeFetch(input, options);
    }
    if (/\\/cards\\/\\d+\\/image$/.test(url.pathname)) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="14"/>',{status:200,headers:{'Content-Type':'image/svg+xml'}});
    if (url.pathname.endsWith('/config')) return json({version:{id:window.__houseVersion,label:'House List v' + window.__houseVersion},poolRevision:'fixture'});
    if (url.pathname.endsWith('/catalogue')) return json({cards:[],hasMore:false,catalogue:{eligibleCards:13266},version:{id:window.__houseVersion,label:'House List v' + window.__houseVersion}});
    if (url.pathname.endsWith('/cards/resolve')) {
      const map = await cardMap(); const ids = JSON.parse(options.body).ids;
      return json({results:ids.map(inputId=>{const source=map.get(Number(inputId));return source ? {inputId:Number(inputId),outcome:'resolved',artworkId:Number(inputId),card:{id:Number(inputId),canonicalId:Number(inputId),artworkId:Number(inputId),name:source.name,category:'Monster',subtype:source.placement==='extra'?'Fusion':'Effect',cardType:source.placement==='extra'?'Fusion Monster':'Effect Monster',placement:source.placement,copyLimitKey:String(inputId),status:'unlimited',copies:3,poolVerified:true,description:'Template browser fixture.'}}:{inputId:Number(inputId),outcome:'unknown_id'}})});
    }
    if (url.pathname.endsWith('/decks/validate')) return json({verified:true,legal:true,issues:[],cards:[],version:{id:window.__houseVersion,label:'House List v' + window.__houseVersion},poolRevision:'fixture',checkedAt:new Date().toISOString()});
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
  await waitFor(`document.querySelector('#template-result-count')?.textContent.startsWith('397 of 397 decks')`, '397 template decks');
  const initialCatalogue = await evaluate(`(() => {const list=document.querySelector('#template-list'),rows=document.querySelectorAll('.template-list-item,.template-group-item');return {mounted:rows.length,decks:document.querySelectorAll('.template-list-item').length,groups:document.querySelectorAll('.template-group-item').length,scrollHeight:list.scrollHeight,clientHeight:list.clientHeight,tags:[...document.querySelectorAll('#template-tag-options input')].map(input=>input.value),difficulty:document.querySelector('.template-difficulty'),heading:document.querySelector('.template-modal-header .eyebrow').textContent}})()`);
  assert(initialCatalogue.mounted > 0 && initialCatalogue.mounted < 30, 'The 397-deck catalogue should mount only the viewport and overscan');
  assert(initialCatalogue.scrollHeight > initialCatalogue.clientHeight * 10, 'Native scrollbar should represent the complete grouped catalogue');
  assert.equal(initialCatalogue.difficulty, null, 'Difficulty is not a browsing facet');
  assert.match(initialCatalogue.heading, /Find a starting deck/i);
  assert(initialCatalogue.tags.includes('Midrange') && initialCatalogue.tags.includes('Fusion') && initialCatalogue.tags.includes('Going second'));
  assert(!initialCatalogue.tags.includes('Mitsurugi') && !initialCatalogue.tags.some(tag => /Beginner|Intermediate|Advanced/.test(tag)), 'Tags exclude deck names and forced difficulty labels');
  await evaluate(`(() => {const list=document.querySelector('#template-list');list.scrollTop=list.scrollHeight;list.dispatchEvent(new Event('scroll'));return true})()`);
  await sleep(100);
  assert((await evaluate(`document.querySelectorAll('.template-list-item,.template-group-item').length`)) < 30, 'Virtualization stays bounded at the end of the catalogue');
  const desktopLayout = await evaluate(`(() => {const d=document.querySelector('#templates-dialog'),r=d.getBoundingClientRect();return {open:d.open,width:r.width,height:r.height,overflow:Math.max(d.scrollWidth-d.clientWidth,document.documentElement.scrollWidth-innerWidth)}})()`);
  assert(desktopLayout.open && desktopLayout.width > 1200 && desktopLayout.height > 650 && desktopLayout.overflow <= 1, 'Desktop catalogue should be a spacious, non-overflowing popout');
  await setValue('#template-engine-filter', 'Fiendsmith');
  await waitFor(`!document.querySelector('#template-result-count').textContent.startsWith('397 of 397')`, 'engine facet');
  assert(await evaluate(`document.querySelector('#template-result-count').textContent.includes('decks')`));
  await setValue('#template-engine-filter', '');
  await evaluate(`(() => {const input=[...document.querySelectorAll('#template-tag-options input')].find(item=>item.value==='Fusion');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await waitFor(`document.querySelector('#template-tag-summary').textContent === '1 selected'`, 'tag facet');
  assert(await evaluate(`document.querySelector('#template-result-count').textContent.startsWith('137 of 397')`));
  await click('#clear-template-filters');
  await setValue('#template-search', 'Ame no Habakiri');
  await waitFor(`document.querySelectorAll('.template-list-item').length > 0 && parseInt(document.querySelector('#template-result-count').textContent,10) < 397`, 'card-name search');
  await click('.template-list-item');
  assert.match(await evaluate(`document.querySelector('#template-detail-name').textContent`), /Mitsurugi/i);
  assert(await evaluate(`document.querySelector('#template-detail-cover').src.includes('size=cover') && document.querySelector('#template-detail-build').textContent === 'Source-adapted'`));
  assert.match(await evaluate(`document.querySelector('#template-detail-quality').textContent`), /Needs review/);
  await click('#template-tab-cards');
  assert(await evaluate(`document.querySelector('#template-cardlist-zone').textContent.includes('Ame no Habakiri')`));
  await click('#template-tab-sources');
  assert(await evaluate(`document.querySelector('#template-source-content a[href^="https://"]') !== null && document.querySelector('#template-source-content').textContent.includes('House-format changes') && document.querySelector('#template-source-content').textContent.includes('Construction review')`));
  await setValue('#template-search', 'Mitsurugi Fiendsmith');
  await waitFor(`[...document.querySelectorAll('.template-list-item strong')].some(node=>node.textContent==='Mitsurugi Fiendsmith')`, 'Mitsurugi Fiendsmith search');
  await evaluate(`[...document.querySelectorAll('.template-list-item')].find(node=>node.querySelector('strong')?.textContent==='Mitsurugi Fiendsmith').click()`);
  assert.equal(await evaluate(`document.querySelector('#template-detail-name').textContent`), 'Mitsurugi Fiendsmith');
  assert.match(await evaluate(`document.querySelector('#template-detail-quality').textContent`), /Needs review/);
  assert(await evaluate(`document.querySelector('#template-source-content').textContent.includes("Fiendsmith Engraver")`), 'Mitsurugi Fiendsmith source changes remain visible');
  await setValue('#template-search', 'White Forest');
  await waitFor(`[...document.querySelectorAll('.template-list-item strong')].some(node=>node.textContent==='White Forest')`, 'White Forest search');
  await evaluate(`[...document.querySelectorAll('.template-list-item')].find(node=>node.querySelector('strong')?.textContent==='White Forest').click()`);
  assert.match(await evaluate(`document.querySelector('#template-detail-quality').textContent`), /Experimental/);
  assert(await evaluate(`document.querySelector('#template-source-content').textContent.includes("resources available to the engine")`), 'Curated White Forest repair remains visible');
  await setValue('#template-search', 'Naturia');
  await waitFor(`[...document.querySelectorAll('.template-list-item strong')].some(node=>node.textContent==='Naturia')`, 'Naturia search');
  await evaluate(`[...document.querySelectorAll('.template-list-item')].find(node=>node.querySelector('strong')?.textContent==='Naturia').click()`);
  assert(await evaluate(`document.querySelector('#template-detail-notes').textContent.includes('Sacred Tree is now played at three')`), 'Naturia correction note remains visible');
  await click('#template-tab-cards');
  assert(await evaluate(`[...document.querySelectorAll('#template-cardlist-zone li')].some(node=>node.textContent.includes('3×Naturia Sacred Tree'))`), 'Naturia displays three Sacred Tree copies');
  await click('#template-tab-sources');
  assert(await evaluate(`document.querySelector('#template-source-content').textContent.includes('Add the two Trees')`), 'Naturia source changes include the Sacred Tree correction');
  await setValue('#template-search', 'Yummy Mitsurugi');
  await waitFor(`[...document.querySelectorAll('.template-list-item strong')].some(node=>node.textContent==='Yummy Mitsurugi')`, 'Yummy Mitsurugi search');
  await evaluate(`[...document.querySelectorAll('.template-list-item')].find(node=>node.querySelector('strong')?.textContent==='Yummy Mitsurugi').click()`);
  assert.equal(await evaluate(`document.querySelector('#template-detail-name').textContent`), 'Yummy Mitsurugi');
  assert.match(await evaluate(`document.querySelector('#template-detail-quality').textContent`), /Ready for review/);
  assert(await evaluate(`document.querySelector('#template-source-content').textContent.includes("THE Star Ham")`), 'Yummy Mitsurugi source changes remain visible');
  const selectedTemplateName = await evaluate(`document.querySelector('#template-detail-name').textContent`);
  await click('#template-tab-cards');
  await click('[data-template-card-zone="side"]');
  await evaluate(`(() => { window.__houseVersion = 17; window.dispatchEvent(new Event('online')); return true; })()`);
  await waitFor(`document.querySelector('#template-detail-quality')?.textContent.includes('Needs recheck')`, 'stale construction assessment');
  assert.equal(await evaluate(`document.querySelector('#template-detail-name').textContent`), selectedTemplateName, 'House-version refresh preserves the selected template');
  assert.equal(await evaluate(`document.querySelector('[data-template-card-zone="side"]').getAttribute('aria-selected')`), 'true', 'House-version refresh preserves the selected card zone');
  await click('#template-tab-overview');
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
  const templateLoads = await evaluate(`(() => ({decks:window.__templateDataFetches.filter(path=>path.endsWith('/template-decks.json')).length,presentation:window.__templateDataFetches.filter(path=>path.endsWith('/template-presentation.json')).length,quality:window.__templateDataFetches.filter(path=>path.endsWith('/template-quality.json')).length}))()`);
  assert.deepEqual(templateLoads, { decks: 1, presentation: 1, quality: 1 }, 'Reopening reuses the cached template data');
  await setValue('#template-search', 'Dark Magician Toy');
  await waitFor(`document.querySelectorAll('.template-list-item').length === 1`, 'mobile template search');
  await click('.template-list-item');
  assert(await evaluate(`document.querySelector('#templates-dialog').classList.contains('detail-open') && getComputedStyle(document.querySelector('#template-detail')).display !== 'none'`));
  const mobileOverflow = await evaluate(`Math.max(document.querySelector('#templates-dialog').scrollWidth-document.querySelector('#templates-dialog').clientWidth,document.documentElement.scrollWidth-innerWidth)`);
  assert(mobileOverflow <= 1, 'Mobile template detail must not overflow horizontally');
  await click('#template-back');
  assert.equal(await evaluate(`document.querySelector('#templates-dialog').classList.contains('detail-open')`), false);
  assert.equal(await evaluate(`document.querySelector('#template-search').value`), 'Dark Magician Toy', 'Mobile Back restores the browse state');
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  await sleep(150);
  const narrowOverflow = await evaluate(`Math.max(document.querySelector('#templates-dialog').scrollWidth-document.querySelector('#templates-dialog').clientWidth,document.documentElement.scrollWidth-innerWidth)`);
  assert(narrowOverflow <= 1, 'The browse flow must not overflow on a 320px phone');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  await click('#templates-dialog .close-button');
  await waitFor(`!document.querySelector('#templates-dialog').open`, 'closed mobile template catalogue');

  const splitBefore = await evaluate(`(() => {const l=document.querySelector('#card-library-panel').getBoundingClientRect(),d=document.querySelector('#deck-workspace').getBoundingClientRect(),splitter=document.querySelector('#mobile-workspace-splitter'),s=splitter.getBoundingClientRect();return {library:l.height,deck:d.height,splitter:{x:s.left+s.width/2,y:s.top+s.height/2,width:s.width,height:s.height},minimum:Number(splitter.getAttribute('aria-valuemin')),maximum:Number(splitter.getAttribute('aria-valuemax')),value:Number(splitter.getAttribute('aria-valuenow')),heading:getComputedStyle(document.querySelector('.library>.panel-heading')).display,total:document.querySelector('#library-total')}})()`);
  assert.equal(splitBefore.heading, 'none'); assert.equal(splitBefore.total, null);
  assert(splitBefore.splitter.height >= 44 && splitBefore.splitter.width >= 44, 'Resize handle needs a full touch target');
  assert(splitBefore.minimum > 0 && splitBefore.maximum < 100, 'Both panes should retain their primary controls at the collapse limits');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: splitBefore.splitter.x, y: splitBefore.splitter.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: splitBefore.splitter.x, y: splitBefore.splitter.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: splitBefore.splitter.x, y: splitBefore.splitter.y + 72, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: splitBefore.splitter.x, y: splitBefore.splitter.y + 72, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(100);
  const splitAfterDrag = await evaluate(`({library:document.querySelector('#card-library-panel').getBoundingClientRect().height,deck:document.querySelector('#deck-workspace').getBoundingClientRect().height,value:Number(document.querySelector('#mobile-workspace-splitter').getAttribute('aria-valuenow')),stored:sessionStorage.getItem('gog-deckbuilder-mobile-split')})`);
  assert(splitAfterDrag.library > splitBefore.library + 50 && splitAfterDrag.deck < splitBefore.deck - 50, 'Dragging down should give the library more space and the deck less');
  assert(splitAfterDrag.value > splitBefore.value && splitAfterDrag.stored, 'Drag position should be announced and retained for this session');
  await evaluate(`document.querySelector('#mobile-workspace-splitter').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  const splitAfterKey = await evaluate(`({library:document.querySelector('#card-library-panel').getBoundingClientRect().height,value:Number(document.querySelector('#mobile-workspace-splitter').getAttribute('aria-valuenow')),label:document.querySelector('#mobile-workspace-splitter').getAttribute('aria-valuetext')})`);
  assert(splitAfterKey.library < splitAfterDrag.library && splitAfterKey.value < splitAfterDrag.value && /Card library/.test(splitAfterKey.label), 'Arrow keys should provide an accessible resize alternative');
  const dragSplitterTo = async y => {
    const point = await evaluate(`(() => {const r=document.querySelector('#mobile-workspace-splitter').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(80);
  };
  const workspaceBounds = await evaluate(`(() => {const r=document.querySelector('#workspace').getBoundingClientRect();return {top:r.top,bottom:r.bottom}})()`);
  await dragSplitterTo(workspaceBounds.top - 80);
  const libraryCollapsed = await evaluate(`({library:document.querySelector('#card-library-panel').getBoundingClientRect().height,search:document.querySelector('.search-box').getBoundingClientRect().bottom-document.querySelector('#card-library-panel').getBoundingClientRect().top,results:document.querySelector('#library-results-scroll').getBoundingClientRect().height,deck:document.querySelector('#deck-workspace').getBoundingClientRect().height,value:Number(document.querySelector('#mobile-workspace-splitter').getAttribute('aria-valuenow'))})`);
  assert(libraryCollapsed.library >= libraryCollapsed.search && libraryCollapsed.library <= libraryCollapsed.search + 6 && libraryCollapsed.results <= 2, 'Library should stop just after the complete search row with no forced filter or card row');
  assert.equal(libraryCollapsed.value, splitBefore.minimum, 'Library collapse should reach the announced minimum');
  await dragSplitterTo(workspaceBounds.bottom + 80);
  const deckCollapsed = await evaluate(`({deck:document.querySelector('#deck-workspace').getBoundingClientRect().height,header:document.querySelector('.mobile-deck-bar').getBoundingClientRect().height,zones:document.querySelector('#deck-zones').getBoundingClientRect().height,library:document.querySelector('#card-library-panel').getBoundingClientRect().height,value:Number(document.querySelector('#mobile-workspace-splitter').getAttribute('aria-valuenow'))})`);
  assert(deckCollapsed.deck <= deckCollapsed.header + 2 && deckCollapsed.zones <= 2, 'Deck should collapse fully to its zone-tab header');
  assert.equal(deckCollapsed.value, splitBefore.maximum, 'Deck collapse should reach the announced maximum');

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${origin}/gog/deckbuilder/?quality-fail=1` });
  await waitFor(`document.querySelector('#saved-label')?.textContent.includes('Saved')`, 'quality-failure fixture');
  await click('#templates-button');
  await waitFor(`document.querySelector('#template-result-count')?.textContent.startsWith('397 of 397 decks')`, 'catalogue without quality response');
  await setValue('#template-search', 'Dark Magician Toy');
  await waitFor(`document.querySelectorAll('.template-list-item').length === 1`, 'quality-failure template search');
  await click('.template-list-item');
  assert.match(await evaluate(`document.querySelector('#template-detail-quality').textContent`), /Needs review/, 'Unavailable quality stays visibly unverified');
  assert.equal(await evaluate(`document.querySelector('#template-detail-quality').textContent.includes('Recommended')`), false, 'Unavailable quality cannot create a recommendation');
  await click('#templates-dialog .close-button');
  await click('#templates-button');
  await waitFor(`document.querySelector('#template-result-count')?.textContent.startsWith('1 of 397 decks')`, 'reopened catalogue after quality failure');
  const qualityFailureLoads = await evaluate(`({attempts:window.__templateQualityAttempts,decks:window.__templateDataFetches.filter(path=>path.endsWith('/template-decks.json')).length,presentation:window.__templateDataFetches.filter(path=>path.endsWith('/template-presentation.json')).length,quality:window.__templateDataFetches.filter(path=>path.endsWith('/template-quality.json')).length})`);
  assert.deepEqual(qualityFailureLoads, { attempts: 2, decks: 1, presentation: 1, quality: 2 }, 'A failed quality request retries without reloading the base catalogue');

  assert.deepEqual(consoleErrors, [], `No browser errors expected: ${consoleErrors.join(' | ')}`);
  const unexpectedFailures = failedResponses.filter(url => !url.includes('/template-quality.json'));
  assert.deepEqual(unexpectedFailures, [], `No unexpected failed responses expected: ${unexpectedFailures.join(' | ')}`);
  console.log(JSON.stringify({ chrome: version.Browser, templates: 397, templateLoads, qualityFailureLoads, desktop: desktopLayout, copied, mobileOverflow, narrowOverflow, splitBefore, splitAfterDrag, splitAfterKey, libraryCollapsed, deckCollapsed, checks: 'passed' }, null, 2));
} finally {
  socket.close(); chrome.kill(); server.close();
  await Promise.race([new Promise(done => chrome.once('exit', done)), sleep(1500)]);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
