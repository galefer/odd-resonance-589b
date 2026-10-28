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
const target = await pollJson(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${origin}/gog/deckbuilder/`)}`, { method: 'PUT' });
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolvePromise, reject) => { socket.onopen = resolvePromise; socket.onerror = reject; });
let commandId = 0;
const pending = new Map();
const events = [];
const errors = [];
const failedResponses = [];
let validationRequests = 0;
const validationBodies = [];
let interceptedDrag = null;
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
  events.push(message.method);
  if (message.method === 'Network.requestWillBeSent' && new URL(message.params.request.url).pathname === '/gog/api/decks/validate') { validationRequests++; validationBodies.push(message.params.request.postData); }
  if (message.method === 'Input.dragIntercepted') interceptedDrag = message.params.data;
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
  const debug = await evaluate(`(() => {const g=document.querySelector('.deck-grid[data-zone="main"]'),r=g?.getBoundingClientRect();return {url:location.href,title:document.title,ready:document.readyState,body:document.body?.innerText?.slice(0,300),library:document.querySelector('#library-state')?.textContent,libraryClass:document.querySelector('#library-state')?.className,saved:document.querySelector('#saved-label')?.textContent,counts:[...document.querySelectorAll('#count-main,#count-extra,#count-side')].map(e=>e.textContent),toast:document.querySelector('#toast')?.textContent,drag:document.body?.dataset.dragDebug,grid:r&&{left:r.left,top:r.top,width:r.width,height:r.height,at:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.className}}})()`).catch(() => null);
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(value)}. Debug: ${JSON.stringify(debug)}. Failed responses: ${JSON.stringify(failedResponses)}. Console: ${errors.join(' | ')}`);
}
const click = (selector) => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing ${selector}'); e.click(); return true; })()`);
const setValue = (selector, value) => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing ${selector}'); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
const screenshot = async (name) => {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(resolve(artifacts, name), Buffer.from(result.data, 'base64'));
};
const counts = () => evaluate(`({main:Number(document.querySelector('#count-main').textContent),extra:Number(document.querySelector('#count-extra').textContent),side:Number(document.querySelector('#count-side').textContent)})`);

const point = (selector) => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing drag target'); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
async function dragCard(source, target, operation, { xFraction = .5, preview, cancel = false } = {}) {
  // Start a real mouse drag on the artwork, then deliver Chrome's native drag
  // data to the target. Synthetic DOM drops miss effectAllowed/dropEffect bugs.
  interceptedDrag = null;
  await send('Input.setInterceptDrags', { enabled: true });
  const from = await point(source);
  const to = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect(); return {x:r.left+r.width*${xFraction},y:r.top+r.height/2};})()`);
  try {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 8; step++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x+(to.x-from.x)*step/8, y: from.y+(to.y-from.y)*step/8, button: 'left', buttons: 1 });
      await sleep(20);
      if (interceptedDrag) break;
    }
    if (!interceptedDrag) {
      console.log({ source, target, from, to });
      await screenshot('drag-failure.png');
    }
    assert(interceptedDrag, 'Artwork should start a native card drag');
    assert.equal(interceptedDrag.dragOperationsMask, operation === 'copy' ? 1 : 16);
    for (const type of ['dragEnter', 'dragOver']) await send('Input.dispatchDragEvent', { type, ...to, data: interceptedDrag });
    if (preview) await preview();
    await send('Input.dispatchDragEvent', { type: cancel ? 'dragCancel' : 'drop', ...to, data: interceptedDrag });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', buttons: 0, clickCount: 1 });
  } finally {
    await send('Input.setInterceptDrags', { enabled: false });
  }
  assert.equal(await evaluate(`document.querySelectorAll('.drop-insertion-line:not([hidden])').length`), 0, 'Insertion marker clears after drop or cancel');
}

async function checkInsertionLine(leftSelector, rightSelector) {
  const result = await evaluate(`(() => {
    const marker=document.querySelector('.drop-insertion-line:not([hidden])'); if(!marker) return null;
    const l=${leftSelector ? `document.querySelector(${JSON.stringify(leftSelector)}).getBoundingClientRect()` : 'null'};
    const r=${rightSelector ? `document.querySelector(${JSON.stringify(rightSelector)}).getBoundingClientRect()` : 'null'};
    const m=marker.getBoundingClientRect(), anchor=r||l;
    return {x:m.left+m.width/2,expectedX:l&&r?(l.right+r.left)/2:r?r.left-4:l.right+4,top:m.top,expectedTop:anchor.top,height:m.height,expectedHeight:anchor.height,color:getComputedStyle(marker).backgroundColor};
  })()`);
  assert(result, 'Valid drop should show a yellow insertion line');
  assert(Math.abs(result.x-result.expectedX)<1, 'Line should match the exact gap or card edge');
  assert(Math.abs(result.top-result.expectedTop)<1 && Math.abs(result.height-result.expectedHeight)<1, 'Line should follow the correct row and card height');
  assert.equal(result.color, 'rgb(255, 220, 85)');
}
async function rightClick(selector, shift = false) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);
  const at = await point(selector);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'right', buttons: 2, clickCount: 1, modifiers: shift ? 8 : 0 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'right', buttons: 0, clickCount: 1, modifiers: shift ? 8 : 0 });
}

async function touchDrag(source, target, { hold = 520, sourceY = .2 } = {}) {
  const from = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(source)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height*${sourceY}}})()`), to = await point(target);
  const touch = (x, y) => ({ x, y, id: 0, radiusX: 3, radiusY: 3, force: .8 });
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(from.x, from.y)] });
  await sleep(hold);
  for (let step = 1; step <= 5; step++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(from.x + (to.x - from.x) * step / 5, from.y + (to.y - from.y) * step / 5)] });
    await sleep(24);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function saveNamedDeck(name) {
  await click('#save-deck');
  await waitFor(`document.querySelector('#save-deck-dialog').open`, 'name and save dialog');
  await setValue('#save-deck-name', name); await click('#confirm-save-deck');
  await waitFor(`!document.querySelector('#save-deck-dialog').open && document.querySelector('#deck-name').textContent===${JSON.stringify(name)}`, 'named deck saved');
}

const evidence = { chrome: version.Browser, origin, checks: [], failedResponses, consoleErrors: errors };
try {
  await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable'), send('Log.enable')]);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${origin}/gog/deckbuilder/` });
  await waitFor(`document.readyState==='complete' && document.querySelectorAll('.library-card').length>0`, 'initial card catalogue');
  assert.equal(await evaluate(`document.querySelector('.gog-brand strong').textContent.trim()`), 'Guild of Games');
  assert(await evaluate(`document.querySelector('.gog-brand img').naturalWidth > 0`), 'Guild of Games logo should load in the deckbuilder header');
  assert.equal(await evaluate(`new URL(document.querySelector('.gog-primary-nav a:first-child').href).pathname`), '/gog/');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.gog-primary-nav a')].map(a=>a.textContent.trim())`), ['Home','House Format','Deckbuilder']);
  const deckHeader = await evaluate(`(() => { const header=document.querySelector('.gog-site-header').getBoundingClientRect(); const logo=document.querySelector('.gog-brand img').getBoundingClientRect(); const brand=document.querySelector('.gog-brand').getBoundingClientRect(); return {height:header.height,logoWidth:logo.width,logoHeight:logo.height,brandLeft:brand.left,brandTop:brand.top}; })()`);
  assert.equal(await evaluate(`document.querySelector('#library-total')`), null, 'Redundant eligible-count label is removed');
  assert.equal(await evaluate(`document.querySelector('#saved-label').textContent`), 'Saved on this device');
  assert.equal((await counts()).main, 0);
  evidence.checks.push('initial catalogue and IndexedDB state loaded');

  const originalEmptyId = await evaluate(`document.querySelector('#deck-menu-list button').dataset.deckId`);
  await click('#saved-decks-button'); await click('#delete-deck');
  await waitFor(`document.querySelector('#deck-menu-list button')?.dataset.deckId!==${JSON.stringify(originalEmptyId)} && document.querySelector('#deck-menu-list button')`, 'last deck deletion creates fresh empty deck');
  await sleep(350);
  assert.equal(await evaluate(`document.querySelectorAll('#deck-menu-list button').length`), 1, 'Deleted last deck must not be saved again');
  assert(await evaluate(`document.body.classList.contains('deck-is-empty') && document.querySelector('.empty-zone span').textContent==='Add a card from the library above.'`), 'Empty decks use neutral mobile-first guidance instead of drag-only wording');

  assert.equal(await evaluate(`document.querySelector('.quick-add')`), null, 'Library hover add controls should be removed');
  await dragCard('.library-card img', '.deck-grid[data-zone="main"]', 'copy');
  await waitFor(`document.querySelector('#count-main').textContent==='1'`, 'library artwork drag into empty deck');
  await click('#undo'); await waitFor(`document.querySelector('#count-main').textContent==='0'`, 'undo');
  await click('#redo'); await waitFor(`document.querySelector('#count-main').textContent==='1'`, 'redo');
  await dragCard('.library-card img', '.deck-grid[data-zone="main"] .card-tile img', 'copy');
  await waitFor(`document.querySelector('#count-main').textContent==='2'`, 'library drop onto existing card');
  await rightClick('.deck-grid[data-zone="main"] .card-tile:not(.selected) img');
  await waitFor(`document.querySelector('#count-main').textContent==='1'`, 'right-click removes hovered copy');
  assert.equal(await evaluate(`document.querySelectorAll('.card-tile.selected').length`), 1, 'Removing an unselected copy preserves the other selection');
  await click('#undo'); await waitFor(`document.querySelector('#count-main').textContent==='2'`, 'undo right-click deletion');
  await click('#grouped-view');
  await rightClick('.deck-grid[data-zone="main"] .card-tile img');
  await waitFor(`document.querySelector('#count-main').textContent==='1'`, 'right-click removes only one grouped copy');
  await click('#copies-view');
  await dragCard('.deck-grid[data-zone="main"] .card-tile img', '.deck-grid[data-zone="side"]', 'move');
  await waitFor(`document.querySelector('#count-main').textContent==='0' && document.querySelector('#count-side').textContent==='1'`, 'move copy to Side');
  await dragCard('.deck-grid[data-zone="side"] .card-tile img', '.deck-grid[data-zone="main"]', 'move');
  await waitFor(`document.querySelector('#count-main').textContent==='1' && document.querySelector('#count-side').textContent==='0'`, 'move copy back to Main');
  await dragCard('.library-card img', '.deck-grid[data-zone="extra"]', 'copy');
  assert.deepEqual(await counts(), { main: 1, extra: 0, side: 0 }, 'Drop must respect card placement');
  evidence.checks.push('native library drag to empty and populated zones; move between zones; invalid placement rejected');
  evidence.checks.push('right-click removes hovered copy, preserves selection, supports undo and grouped copies');

  await rightClick('.library-card img');
  assert.deepEqual(await counts(), { main: 2, extra: 0, side: 0 }, 'Right-click library spell adds one to Main');
  await rightClick('.library-card img', true);
  assert.deepEqual(await counts(), { main: 2, extra: 0, side: 1 }, 'Shift + right-click adds exactly one to Side');
  await rightClick('.library-card img');
  assert.deepEqual(await counts(), { main: 2, extra: 0, side: 1 }, 'Right-click enforces the combined three-copy limit');
  await click('#undo'); await click('#undo');
  assert.deepEqual(await counts(), { main: 1, extra: 0, side: 0 });
  // Use distinct cards across two rows to verify marker geometry and real order.
  const mainFixtureCards = await evaluate(`[...document.querySelectorAll('.library-card')].map((e,i)=>({index:i+1,main:e.querySelector('button').title.includes('right-click: Main Deck'),forbidden:!!e.querySelector('.restriction-dot.forbidden')})).filter(e=>e.main&&!e.forbidden).slice(1,10).map(e=>e.index)`);
  for (const n of mainFixtureCards) await rightClick(`.library-card:nth-child(${n}) img`);
  await evaluate(`document.querySelector('#library-results-scroll').scrollTop=0; window.scrollTo(0,0);`);
  const mainTile = (n) => `.deck-grid[data-zone="main"] .card-tile:nth-child(${n})`;
  const mainOrder = () => evaluate(`[...document.querySelectorAll('.deck-grid[data-zone="main"] .card-tile')].map(e=>e.dataset.instanceId)`);
  const originalOrder = await mainOrder();
  assert.equal(originalOrder.length, 10);
  await waitFor(`document.querySelector('#validation-title').textContent!=='Checking published house rules'`, 'fixture validation');
  const requestsBeforeReorder = validationRequests;
  await dragCard(`${mainTile(10)} img`, mainTile(3), 'move', { xFraction:.25, preview:async()=>{
    await checkInsertionLine(mainTile(2),mainTile(3));
    await sleep(650); // A pending server validation must not destroy the drag DOM.
    await checkInsertionLine(mainTile(2),mainTile(3));
    await screenshot('deckbuilder-insertion-between.png');
  }});
  assert.deepEqual(await mainOrder(), [...originalOrder.slice(0,2),originalOrder[9],...originalOrder.slice(2,9)]);
  await dragCard(`${mainTile(3)} img`, mainTile(10), 'move', { xFraction:1.7, preview:async()=>{
    await checkInsertionLine(mainTile(10),null); await screenshot('deckbuilder-insertion-end.png');
  }});
  assert.deepEqual(await mainOrder(), originalOrder, 'Trailing line appends after the last card');
  await dragCard(`${mainTile(1)} img`, mainTile(4), 'move', { xFraction:.25, preview:()=>checkInsertionLine(mainTile(3),mainTile(4)) });
  const forwardOrder = [originalOrder[1],originalOrder[2],originalOrder[0],...originalOrder.slice(3)];
  assert.deepEqual(await mainOrder(), forwardOrder, 'Forward moves adjust for the source leaving its old slot');
  await dragCard(`${mainTile(1)} img`, mainTile(9), 'move', { xFraction:.25, preview:()=>checkInsertionLine(null,mainTile(9)) });
  const wrappedOrder = [...forwardOrder.slice(1,8),forwardOrder[0],...forwardOrder.slice(8)];
  assert.deepEqual(await mainOrder(), wrappedOrder, 'Leading line on the second row inserts before that row');
  await dragCard(`${mainTile(1)} img`, mainTile(3), 'move', { xFraction:.25, cancel:true, preview:()=>checkInsertionLine(mainTile(2),mainTile(3)) });
  assert.deepEqual(await mainOrder(), wrappedOrder, 'Cancelling a drag preserves order');
  await sleep(700);
  assert.equal(validationRequests, requestsBeforeReorder, 'Same-section reorders and cancellation must not revalidate');
  await click('#undo'); await sleep(550);
  await click('#redo'); await sleep(550);
  assert.equal(validationRequests, requestsBeforeReorder, `Undo/redo of ordering changes must not revalidate: ${JSON.stringify(validationBodies)}`);
  assert.deepEqual(await mainOrder(), wrappedOrder);
  // Hold one actual server response while its deck is reordered. The response
  // must be remapped and accepted, without leaving the banner stuck on checking.
  await evaluate(`(() => {window.__originalFetch=window.fetch;window.fetch=async(...args)=>{const response=await window.__originalFetch(...args);if(String(args[0]).endsWith('/decks/validate')){await new Promise(resolve=>{window.__releaseValidation=resolve;window.__validationHeld=true;});}return response;};})()`);
  await dragCard('.library-card img', mainTile(2), 'copy', { xFraction:.25, preview:()=>checkInsertionLine(mainTile(1),mainTile(2)) });
  const withLibraryCopy = await mainOrder();
  assert.equal(withLibraryCopy.length, 11);
  assert.deepEqual(withLibraryCopy.filter((_,index)=>index!==1),wrappedOrder, 'Library card inserts at the marked gap');
  await waitFor(`window.__validationHeld===true`, 'pending added-card validation');
  assert(validationRequests>requestsBeforeReorder, 'A new copy must still trigger server validation');
  const requestsBeforeGroupedReorder = validationRequests;
  await click('#grouped-view');
  await dragCard(`.card-tile[data-instance-id="${withLibraryCopy[1]}"] img`, mainTile(1), 'move', { xFraction:.25, preview:()=>checkInsertionLine(null,mainTile(1)) });
  assert.equal(await evaluate(`document.querySelector('.deck-grid[data-zone="main"] .card-tile .quantity')?.textContent`), '×2', 'Grouped reorder places the complete stack at the marked gap');
  await sleep(550);
  assert.equal(validationRequests, requestsBeforeGroupedReorder, 'Grouped stack reorder must not revalidate');
  await evaluate(`window.fetch=window.__originalFetch;window.__releaseValidation();`);
  await waitFor(`document.querySelector('#validation-title').textContent!=='Checking published house rules'`, 'reordered pending validation result');
  evidence.checks.push('single/grouped reorders and their undo/redo make zero validation requests; new copies still validate and pending responses survive reordering');
  await click('#copies-view');
  await click('.zone[data-zone="main"] .zone-tools button:last-child');
  await waitFor(`document.querySelector('#count-main').textContent==='0'`, 'clear reorder fixture');
  await rightClick('.library-card img');
  evidence.checks.push('yellow insertion preview matches between-card, trailing and wrapped-row drops; forward/backward order, cancellation, library insertion and grouped stacks');
  await setValue('#search', 'Number 39: Utopia');
  await waitFor(`document.querySelector('.library-card button')?.getAttribute('aria-label').startsWith('Inspect Number 39: Utopia,')`, 'Extra Deck card search');
  await rightClick('.library-card img');
  assert.deepEqual(await counts(), { main: 1, extra: 1, side: 0 }, 'Right-click Xyz card adds to Extra');
  await rightClick('.library-card img', true);
  assert.deepEqual(await counts(), { main: 1, extra: 1, side: 1 }, 'Shift overrides Extra placement and adds to Side');
  await click('#undo'); await click('#undo');
  evidence.checks.push('library right-click adds to Main/Extra; Shift adds to Side; combined copy limits enforced');

  await setValue('#search', 'Pot of Greed');
  await waitFor(`[...document.querySelectorAll('.library-card button[aria-label]')].some(e=>e.getAttribute('aria-label').startsWith('Inspect Pot of Greed,'))`, 'Forbidden card search');
  await evaluate(`(() => { const e=[...document.querySelectorAll('.library-card button[aria-label]')].find(e=>e.getAttribute('aria-label').startsWith('Inspect Pot of Greed,')); e.click(); return true; })()`);
  assert.equal(await evaluate(`document.querySelector('#card-status').textContent`), 'Forbidden');
  assert.equal(await evaluate(`document.querySelector('#add-auto').disabled`), true);
  await dragCard('.library-card img', '.deck-grid[data-zone="main"]', 'copy');
  assert.equal((await counts()).main, 1, 'Dragging cannot bypass Forbidden restrictions');
  await rightClick('.library-card img'); await rightClick('.library-card img', true);
  assert.deepEqual(await counts(), { main: 1, extra: 0, side: 0 }, 'Neither right-click shortcut can add Forbidden cards');
  evidence.checks.push('search and Forbidden add rejection');

  await click('#import-button'); await click('#paste-tab');
  const ydk = '#main\n14558127\n14558127\n14558127\n#extra\n84013237\n!side\n27204311\n';
  await setValue('#paste-input', ydk); await click('#preview-paste');
  await waitFor(`!document.querySelector('#confirm-import').disabled`, 'YDK import preview', 20_000);
  assert.match(await evaluate(`document.querySelector('#import-counts').textContent`), /Main 3.*Extra 1.*Side 1/);
  await click('#confirm-import');
  await waitFor(`document.querySelector('#count-main').textContent==='3' && document.querySelector('#count-extra').textContent==='1' && document.querySelector('#count-side').textContent==='1'`, 'YDK import');
  evidence.checks.push('YDK preview and lossless three-section import');

  await waitFor(`document.querySelector('#saved-label').textContent==='Saved on this device'`, 'autosave');
  await saveNamedDeck('Browser QA deck');
  await click('#saved-decks-button');
  const savedDeckId = await evaluate(`document.querySelector('#deck-menu-list button.current').dataset.deckId`);
  await click('#new-deck');
  await waitFor(`document.querySelector('#count-main').textContent==='0' && document.querySelector('#deck-name').textContent==='Untitled deck'`, 'new separate deck');
  await saveNamedDeck('Second QA deck');
  await click('#saved-decks-button');
  await click(`#deck-menu-list button[data-deck-id="${savedDeckId}"]`);
  await waitFor(`document.querySelector('#deck-name').textContent==='Browser QA deck' && document.querySelector('#count-main').textContent==='3'`, 'reopen named deck');
  assert.deepEqual(await counts(), { main: 3, extra: 1, side: 1 });
  const priorTimeOrigin = await evaluate('performance.timeOrigin');
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`performance.timeOrigin!==${JSON.stringify(priorTimeOrigin)} && document.readyState==='complete' && document.querySelector('#count-main')?.textContent==='3'`, 'IndexedDB refresh restore', 20_000);
  assert.deepEqual(await counts(), { main: 3, extra: 1, side: 1 });
  assert.equal(await evaluate(`document.querySelector('#deck-name').textContent`), 'Browser QA deck');
  assert(await evaluate(`[...document.querySelectorAll('#deck-menu-list button')].some(e=>e.textContent.includes('Second QA deck'))`), 'Other saved decks survive refresh');
  evidence.checks.push('named decks saved locally, switched, reopened and retained across reload without accounts');

  await click('#export-button'); await click('#copy-ydke');
  await waitFor(`(!document.querySelector('#toast').hidden && /YDKE/.test(document.querySelector('#toast').textContent)) || document.querySelector('#info-dialog').open`, 'YDKE copy or manual fallback');
  if (await evaluate(`document.querySelector('#info-dialog').open`)) assert.match(await evaluate(`document.querySelector('#info-body textarea').value`), /^ydke:\/\//);
  evidence.checks.push('YDKE export with clipboard/manual success state');
  await waitFor(`document.querySelector('#validation-title').textContent!=='Checking published house rules'`, 'published validation result');
  await waitFor(`document.querySelector('#saved-label').textContent==='Saved on this device'`, 'saved desktop screenshot state');

  const desktopLayout = await evaluate(`({
    overflow:document.documentElement.scrollWidth-window.innerWidth,
    columns:getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns,
    dialogOpen:document.querySelector('#info-dialog').open,
    inspectorLeft:document.querySelector('.inspector').getBoundingClientRect().left,
    toolsLeft:document.querySelector('.tools-panel').getBoundingClientRect().left,
    deckLeft:document.querySelector('.deck-canvas').getBoundingClientRect().left,
    libraryLeft:document.querySelector('.library-panel').getBoundingClientRect().left,
    inspectorWidth:document.querySelector('.left-panel').getBoundingClientRect().width,
    libraryWidth:document.querySelector('.library-panel').getBoundingClientRect().width,
    libraryCard:(() => {
      const card=document.querySelector('.library-card');
      const button=card.querySelector('button');
      const image=card.querySelector('img');
      const c=card.getBoundingClientRect(),b=button.getBoundingClientRect(),i=image.getBoundingClientRect();
      return {cardHeight:c.height,buttonHeight:b.height,imageWidth:i.width,imageHeight:i.height};
    })()
  })`);
  assert(desktopLayout.overflow <= 1, `Desktop horizontal overflow: ${desktopLayout.overflow}`);
  assert(desktopLayout.inspectorLeft < desktopLayout.deckLeft && desktopLayout.toolsLeft < desktopLayout.deckLeft, 'Inspector and overview should be in the left sidebar');
  assert(desktopLayout.libraryLeft > desktopLayout.deckLeft, 'Card library should be in the right sidebar');
  assert(desktopLayout.inspectorWidth >= 300 && desktopLayout.libraryWidth >= 340, 'Desktop sidebars should be comfortably wide');
  assert(desktopLayout.libraryCard.imageWidth >= 85, 'Catalogue artwork should be readable at desktop size');
  assert(Math.abs(desktopLayout.libraryCard.imageHeight / desktopLayout.libraryCard.imageWidth - 614 / 421) < 0.03, 'Library artwork should keep the card aspect ratio');
  assert(desktopLayout.libraryCard.cardHeight <= desktopLayout.libraryCard.imageHeight + 1, 'Library grid row should not add vertical space around artwork');
  assert(desktopLayout.libraryCard.buttonHeight <= desktopLayout.libraryCard.imageHeight + 1, 'Library button should not stretch beyond artwork');
  if (desktopLayout.dialogOpen) await evaluate(`document.querySelector('#info-dialog').close()`);
  await screenshot('deckbuilder-desktop.png');
  evidence.desktop = desktopLayout;

  let deckMobileHeader = null;
  for (const width of [320, 390, 430, 767, 768, 1179, 1180, 1440, 1920, 2048]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 768 });
    await sleep(180);
    const layout = await evaluate(`(() => {const visible=e=>{const r=e.getBoundingClientRect();return getComputedStyle(e).display!=='none'&&r.width>0&&r.height>0},tracks=e=>getComputedStyle(e).gridTemplateColumns.split(' ').filter(Boolean).length,card=document.querySelector('.library-card'),libraryPanel=document.querySelector('.library-panel').getBoundingClientRect(),deckPanel=document.querySelector('.deck-canvas').getBoundingClientRect(),load=document.querySelector('#load-more').getBoundingClientRect(),cards=[...document.querySelectorAll('.library-card')].map(e=>e.getBoundingClientRect()),overlap=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,workspace:getComputedStyle(document.querySelector('.workspace')).display,oldNav:document.querySelector('.mobile-nav'),library:visible(document.querySelector('.library-panel')),deck:visible(document.querySelector('.deck-canvas')),actions:visible(document.querySelector('#mobile-actions-button')),save:visible(document.querySelector('#save-deck')),libraryColumns:tracks(document.querySelector('.library-grid')),deckColumns:tracks(document.querySelector('.deck-grid')),libraryCardWidth:card?.getBoundingClientRect().width||0,libraryHeight:libraryPanel.height,deckHeight:deckPanel.height,loadMoreOverlapsCard:cards.some(cardRect=>overlap(load,cardRect)),libraryOverflow:getComputedStyle(document.querySelector('#library-results-scroll')).overflowY}})()`);
    assert(layout.scrollWidth <= layout.width + 1, `${width}px horizontal overflow: ${layout.scrollWidth-layout.width}`);
    assert.equal(layout.oldNav, null, 'The retired Deck / Library / Card / Tools navigation should not remain');
    if (width < 768) {
      assert(layout.library && layout.deck && layout.actions && !layout.save, `${width}px should show the split workspace and compact action menu`);
      assert(await evaluate(`['deck-menu-button','undo','mobile-actions-button'].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width>=40&&r.left>=0&&r.right<=innerWidth;})`), 'Compact mobile header controls should stay reachable');
      assert(await evaluate(`(()=>{const h=document.querySelector('.gog-site-header').getBoundingClientRect(),t=document.querySelector('.deck-toolbar').getBoundingClientRect(),b=document.querySelector('.mobile-deck-bar').getBoundingClientRect(),v=document.querySelector('#validation-banner').getBoundingClientRect();return t.top>=h.top-1&&t.bottom<=h.bottom+1&&v.top>=b.top&&v.bottom<=b.bottom})()`), `${width}px should merge deck controls into the site header and validation into the deck header`);
      assert(await evaluate(`document.querySelector('#mobile-grouped-view').getAttribute('aria-checked')==='true' && document.querySelector('#mobile-copies-view').getAttribute('aria-checked')==='false'`), `${width}px should default the deck to grouped stacks`);
      assert(layout.libraryCardWidth > 0 && layout.libraryCardWidth <= 56, `${width}px catalogue cards should use the compact phone footprint`);
      assert.equal(layout.loadMoreOverlapsCard, false, 'Load more must not cover catalogue cards or their add controls');
      assert(['auto', 'scroll'].includes(layout.libraryOverflow), 'Catalogue results should own the library scroll region');
    } else {
      assert(layout.save, `${width}px should retain the desktop/tablet save controls`);
    }
    if (width === 320) assert.equal(layout.libraryColumns, 6, 'The narrowest phone should show six compact catalogue columns');
    if (width === 390) assert(layout.libraryColumns === 7 && layout.libraryHeight >= 420 && layout.libraryHeight <= 435 && layout.deckHeight >= 335, 'A typical phone should preserve the library height and give reclaimed chrome space to the deck');
    if (width === 767) assert(layout.libraryColumns >= 14 && layout.deckColumns >= 14, 'Wide mobile layouts should add columns instead of stretching cards');
    if (width >= 1180) assert(await evaluate(`document.querySelector('.workspace').getBoundingClientRect().width >= innerWidth-20`), 'Workspace should use the available width');
    if (width === 390) deckMobileHeader = await evaluate(`(() => { const h=document.querySelector('.gog-site-header').getBoundingClientRect(); const l=document.querySelector('.gog-brand img').getBoundingClientRect(); const b=document.querySelector('.gog-brand').getBoundingClientRect(); return {height:h.height,logoWidth:l.width,logoHeight:l.height,brandLeft:b.left,brandTop:b.top}; })()`);
    if (width === 2048) await screenshot('deckbuilder-2048.png');
    evidence.checks.push(`${width}px no horizontal overflow`);
  }

  await send('Emulation.setDeviceMetricsOverride', { width: 740, height: 390, deviceScaleFactor: 1, mobile: true });
  await sleep(180);
  const landscape = await evaluate(`(() => {const w=document.querySelector('.workspace').getBoundingClientRect(),l=document.querySelector('.library-panel').getBoundingClientRect(),d=document.querySelector('.deck-canvas').getBoundingClientRect(),s=document.querySelector('.search-box').getBoundingClientRect(),f=document.querySelector('.library-filters').getBoundingClientRect(),m=document.querySelector('#load-more').getBoundingClientRect(),tracks=e=>getComputedStyle(e).gridTemplateColumns.split(' ').filter(Boolean).length;return {overflow:document.documentElement.scrollWidth-innerWidth,header:getComputedStyle(document.querySelector('.gog-site-header')).display,workspace:w.height,library:l.height,deck:d.height,libraryColumns:tracks(document.querySelector('.library-grid')),deckColumns:tracks(document.querySelector('.deck-grid')),controlsDelta:Math.abs(s.top-f.top),loadMoreWidth:m.width}})()`);
  assert(landscape.overflow <= 1 && landscape.header === 'none' && landscape.library > 80 && landscape.deck > 80, 'Short landscape keeps both panes usable and removes nonessential site chrome');
  assert(landscape.libraryColumns >= 13 && landscape.deckColumns >= 13 && landscape.controlsDelta <= 1 && landscape.loadMoreWidth <= 120, 'Landscape keeps cards compact and places catalogue controls on one row');
  await screenshot('deckbuilder-mobile-landscape.png');
  evidence.checks.push('740×390 short landscape split workspace');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(180);
  await setValue('#search', '1st Movement Solo');
  await waitFor(`document.querySelectorAll('.library-card').length===1`, 'mobile library result');
  const beforeMobile = await counts();
  const inspectedIdentity = await evaluate(`document.querySelector('.library-card').dataset.cardIdentity`);
  await touchDrag('.library-card .library-inspect', '#search', { hold: 40 });
  await sleep(180);
  assert.deepEqual(await counts(), beforeMobile, 'An ordinary card-list swipe scrolls without editing the deck');
  assert.equal(await evaluate(`document.querySelector('#card-inspector-dialog').open`), false, 'A scrolling gesture does not inspect the card');
  await click('.library-card .library-inspect');
  assert(await evaluate(`document.querySelector('#card-inspector-dialog').open`), 'Library artwork opens the shared mobile inspector');
  assert(await evaluate(`['library-panel','deck-canvas'].every(c=>document.querySelector('.'+c).getBoundingClientRect().height>0)`), 'Split workspace remains mounted behind the inspector');
  await screenshot('deckbuilder-mobile-inspector.png');
  await click('.inspector-quantity-row .quantity-step.add');
  await waitFor(`document.querySelector('#count-main').textContent===${JSON.stringify(String(beforeMobile.main + 1))}`, 'inspector plus adds one Main Deck copy');
  assert(await evaluate(`document.querySelector('#card-inspector-dialog').open`), 'Inspector remains open after adding');
  assert.equal(await evaluate(`document.querySelector('.library-quantity').textContent`), '×1');
  await click('.inspector-quantity-row .quantity-step:not(.add)');
  await waitFor(`document.querySelector('#count-main').textContent===${JSON.stringify(String(beforeMobile.main))}`, 'inspector minus removes one copy');
  assert(await evaluate(`document.querySelector('#card-inspector-dialog').open && document.querySelector('#mobile-inspector-title').textContent.includes('1st Movement Solo')`), 'Removing the final copy keeps the same card inspectable');
  await click('.inspector-quantity-row .quantity-step.add');
  await click('#card-inspector-dialog .close-button');
  await waitFor(`!document.querySelector('#card-inspector-dialog').open`, 'mobile inspector close');
  await click('#zone-tab-side');
  const beforeSideQuickAdd = (await counts()).side;
  await click('.library-card .library-quick-add');
  await waitFor(`document.querySelector('#count-side').textContent===${JSON.stringify(String(beforeSideQuickAdd + 1))}`, 'Side-selected quick add destination');
  assert.equal(await evaluate(`document.body.dataset.deckZone`), 'side');
  assert.equal(await evaluate(`document.querySelector('#search').value`), '1st Movement Solo');
  assert.equal(await evaluate(`document.querySelector('#card-inspector-dialog').open`), false, 'Quick add does not open the inspector');
  await click('#undo');
  await waitFor(`document.querySelector('#count-side').textContent===${JSON.stringify(String(beforeSideQuickAdd))}`, 'Undo side quick add');
  assert.equal(await evaluate(`document.querySelector('.library-quantity').textContent`), '×1', 'Undo refreshes the live library quantity');
  await click('#zone-tab-main');
  await click('.library-card .library-quick-add');
  await waitFor(`document.querySelector('#count-main').textContent===${JSON.stringify(String(beforeMobile.main + 2))}`, 'Main quick add uses legal default destination');
  assert.equal(await evaluate(`document.querySelector('#mobile-grouped-view').getAttribute('aria-checked')`), 'true', 'Grouped stacks remain the mobile default');
  assert.equal(await evaluate(`[...document.querySelectorAll('.zone[data-zone="main"] .card-tile')].find(e=>e.dataset.cardIdentity===${JSON.stringify(inspectedIdentity)})?.querySelector('.quantity')?.textContent`), '×2', 'Matching mobile deck cards collapse into one quantity stack');
  await screenshot('deckbuilder-mobile-grouped.png');
  await evaluate(`[...document.querySelectorAll('.card-tile')].find(e=>e.dataset.cardIdentity===${JSON.stringify(inspectedIdentity)}).click()`);
  await waitFor(`document.querySelector('#card-inspector-dialog').open`, 'grouped deck card opens shared inspector');
  const groupedBefore = (await counts()).main;
  await click('.inspector-quantity-row .quantity-step:not(.add)');
  await waitFor(`document.querySelector('#count-main').textContent===${JSON.stringify(String(groupedBefore - 1))}`, 'grouped inspector decrement removes one physical copy');
  assert(await evaluate(`document.querySelector('#card-inspector-dialog').open`), 'Grouped decrement keeps inspector open');
  await click('#card-inspector-dialog .close-button');
  await click('#mobile-actions-button');
  assert(await evaluate(`document.querySelector('#mobile-actions-dialog').open && document.querySelectorAll('[data-mobile-command]').length>=10`), 'Compact menu exposes deck actions and tools');
  await click('[data-mobile-command="overview"]');
  await waitFor(`document.querySelector('#mobile-tools-dialog').open && document.querySelector('#overview').hidden===false`, 'mobile overview and probability tools');
  await click('#mobile-tools-dialog .close-button');
  await click('#mobile-zone-menu-button'); await click('#mobile-copies-view');
  await setValue('#search', '');
  await waitFor(`document.querySelectorAll('.library-card').length>=12`, 'restored mobile catalogue');
  await waitFor(`document.querySelector('#validation-title').textContent!=='Checking published house rules'`, 'mobile validation result');
  await click('#validation-info');
  assert(await evaluate(`document.querySelector('#info-dialog').open`), 'Compact mobile validation status opens its details');
  await click('#info-dialog .close-button');
  await evaluate(`document.querySelector('#toast').hidden=true`);
  await screenshot('deckbuilder-mobile-split.png');
  assert(await evaluate(`document.scrollingElement.scrollHeight<=innerHeight+1`), 'Normal mobile editing view has no competing page scrollbar');
  const normalDeckHeight = await evaluate(`document.querySelector('.deck-canvas').getBoundingClientRect().height`);
  await evaluate(`document.body.classList.add('search-keyboard-open')`);
  const keyboardLayout = await evaluate(`({deck:document.querySelector('.deck-canvas').getBoundingClientRect().height,zones:getComputedStyle(document.querySelector('#deck-zones')).display,search:document.querySelector('#search').getBoundingClientRect().top,zone:document.body.dataset.deckZone})`);
  assert(keyboardLayout.deck <= 52 && keyboardLayout.zones === 'none' && keyboardLayout.search >= 0, 'Search keyboard state keeps results/input visible and compacts the deck');
  await evaluate(`document.body.classList.remove('search-keyboard-open')`); await sleep(100);
  assert(await evaluate(`document.querySelector('.deck-canvas').getBoundingClientRect().height >= ${normalDeckHeight - 1} && document.body.dataset.deckZone==='main'`), 'Closing the keyboard state restores the split and active section');
  await waitFor(`document.querySelector('#saved-label').textContent==='Saved on this device'`, 'saved mobile screenshot state');
  await screenshot('deckbuilder-mobile.png');
  evidence.checks.push('mobile library-first workspace, shared inspector, quantity controls, active-zone quick add, grouped decrement, Undo, tools and keyboard-compact state');

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${origin}/gog/` });
  await waitFor(`document.readyState==='complete' && document.querySelectorAll('.event-groups .event-card').length>=2`, 'Guild of Games homepage events');
  const homeBrand = await evaluate(`({
    brand:document.querySelector('.gog-brand strong').textContent.trim(),
    navigation:[...document.querySelectorAll('.gog-primary-nav a')].map(a=>a.textContent.trim()),
    heading:document.querySelector('.hero-copy h1').textContent.trim(),
    eventsHeading:document.querySelector('#events-title').textContent.trim(),
    events:[...document.querySelectorAll('.event-card')].map(card=>card.textContent.trim()),
    eventDates:[...document.querySelectorAll('.event-full-date')].map(e=>e.textContent.trim()),
    advancedArtwork:document.querySelector('.event-card.advanced .event-artwork')?.getAttribute('src'),
    logoLoaded:document.querySelector('.hero-emblem').naturalWidth>0,
    overflow:document.documentElement.scrollWidth-innerWidth,
    header:(() => { const h=document.querySelector('.gog-site-header').getBoundingClientRect(); const l=document.querySelector('.gog-brand img').getBoundingClientRect(); const b=document.querySelector('.gog-brand').getBoundingClientRect(); return {height:h.height,logoWidth:l.width,logoHeight:l.height,brandLeft:b.left,brandTop:b.top}; })()
  })`);
  assert.equal(homeBrand.brand, 'Guild of Games');
  assert.deepEqual(homeBrand.navigation, ['Home','House Format','Deckbuilder']);
  assert(homeBrand.events.some(text=>text.includes('Yu-Gi-Oh! TCG Advanced')));
  assert(homeBrand.events.some(text=>text.includes('Yu-Gi-Oh! TCG House')));
  assert.equal(homeBrand.eventsHeading, 'Upcoming events');
  assert.equal(homeBrand.eventDates.length,5);
  assert(homeBrand.eventDates.every(text=>text.startsWith('Thursday')));
  assert.equal(homeBrand.advancedArtwork, '/gog/assets/magician-of-black-chaos-art.jpg');
  assert.equal(homeBrand.events.some(text=>text.includes('Earlier this month')),false);
  assert.equal(await evaluate(`document.querySelectorAll('#advanced-event-grid .event-card.advanced').length`),4);
  assert.equal(await evaluate(`document.querySelectorAll('#special-event-grid .event-card.house').length`),1);
  assert(homeBrand.logoLoaded);
  assert.equal(await evaluate(`document.querySelector('a[href="#upcoming-events"]')`),null);
  assert.equal(await evaluate(`document.querySelectorAll('#add-event-form input[name=endTime]').length`),1);
  await waitFor(`[...document.querySelectorAll('.event-artwork')].every(img=>img.complete && img.naturalWidth>0)`, 'event artwork');
  assert(await evaluate(`[...document.querySelectorAll('.event-card:not(.special) .event-time')].every(e=>e.textContent.includes('5:30pm – 9:00pm'))`));
  assert(homeBrand.overflow <= 1, `Homepage horizontal overflow: ${homeBrand.overflow}`);
  assert.deepEqual(homeBrand.header, deckHeader, 'Homepage and deckbuilder headers should have identical sizing and placement');
  await click('#events-admin-link');
  await waitFor(`document.querySelector('#events-admin-dialog').open`, 'event administrator dialog');
  assert(await evaluate(`document.querySelector('#events-admin-login img').naturalWidth>0`));
  await click('#events-admin-close');
  await screenshot('gog-home.png');
  evidence.home = homeBrand;

  await send('Page.navigate', { url: `${origin}/gog/house-format/` });
  await waitFor(`document.readyState==='complete' && document.querySelectorAll('#card-list .card-row').length>0`, 'branded card list');
  const cardListBrand = await evaluate(`({
    brand:document.querySelector('.gog-brand strong').textContent.trim(),
    heading:document.querySelector('#format-name').textContent.trim(),
    pool:document.querySelector('.pool-note').textContent.trim(),
    note:document.querySelector('#format-description').textContent.trim(),
    baselineNote:document.querySelector('.reference-note').textContent.trim(),
    logoLoaded:document.querySelector('.gog-brand img').naturalWidth>0,
    homePath:new URL(document.querySelector('.gog-primary-nav a[href="/gog/"]').href).pathname,
    deckbuilderPath:new URL(document.querySelector('.gog-primary-nav a[href="/gog/deckbuilder/"]').href).pathname,
    overflow:document.documentElement.scrollWidth-innerWidth,
    background:getComputedStyle(document.body).backgroundColor,
    header:(() => { const h=document.querySelector('.gog-site-header').getBoundingClientRect(); const l=document.querySelector('.gog-brand img').getBoundingClientRect(); const b=document.querySelector('.gog-brand').getBoundingClientRect(); return {height:h.height,logoWidth:l.width,logoHeight:l.height,brandLeft:b.left,brandTop:b.top}; })()
  })`);
  assert.equal(cardListBrand.brand, 'Guild of Games');
  assert.equal(cardListBrand.heading, 'Yu-Gi-Oh! JUSH House Format');
  assert.match(cardListBrand.pool, /Justice Hunters.*1 August 2025 inclusive/i);
  assert.match(cardListBrand.note, /altered/i);
  assert.match(cardListBrand.baselineNote, /fixed JUSH-era banlist.*Not just the latest update/i);
  assert(cardListBrand.logoLoaded, 'Guild of Games header logo should load');
  assert.equal(cardListBrand.homePath, '/gog/');
  assert.equal(cardListBrand.deckbuilderPath, '/gog/deckbuilder/');
  assert(cardListBrand.overflow <= 1, `Card-list horizontal overflow: ${cardListBrand.overflow}`);
  assert.deepEqual(cardListBrand.header, deckHeader, 'House Format and deckbuilder headers should have identical sizing and placement');
  assert.equal(await evaluate(`document.querySelector('#rules-button')`), null);
  await click('#admin-button');
  await waitFor(`document.querySelector('#admin-modal').open`, 'administrator dialog');
  assert(await evaluate(`document.querySelector('#admin-modal .brand-logo').naturalWidth>0`), 'Guild of Games logo should load in administrator login');
  assert.match(await evaluate(`getComputedStyle(document.querySelector('#admin-modal')).backgroundColor`), /^rgb\((1[0-9]|2[0-9]),/);
  await click('[data-close-dialog="admin-modal"]');
  await screenshot('card-list-branded.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(180);
  const mobileCardList = await evaluate(`({
    overflow:document.documentElement.scrollWidth-innerWidth,
    desktopNav:getComputedStyle(document.querySelector('.gog-primary-nav')).display,
    mobileNav:getComputedStyle(document.querySelector('.gog-mobile-nav')).display,
    logoLoaded:document.querySelector('.gog-brand img').naturalWidth>0,
    header:(() => { const h=document.querySelector('.gog-site-header').getBoundingClientRect(); const l=document.querySelector('.gog-brand img').getBoundingClientRect(); const b=document.querySelector('.gog-brand').getBoundingClientRect(); return {height:h.height,logoWidth:l.width,logoHeight:l.height,brandLeft:b.left,brandTop:b.top}; })()
  })`);
  assert(mobileCardList.overflow <= 1, `Mobile card-list horizontal overflow: ${mobileCardList.overflow}`);
  assert.equal(mobileCardList.desktopNav, 'none');
  assert.notEqual(mobileCardList.mobileNav, 'none');
  assert(mobileCardList.logoLoaded);
  assert(mobileCardList.header.height > deckMobileHeader.height && mobileCardList.header.logoWidth > deckMobileHeader.logoWidth,
    'Only the deckbuilder should use the compact mobile editing header');
  await screenshot('card-list-mobile.png');
  await send('Page.navigate', { url: `${origin}/gog/` });
  await waitFor(`document.readyState==='complete' && document.querySelectorAll('.event-groups .event-card').length>=2`, 'mobile homepage events');
  const mobileHome = await evaluate(`({
    overflow:document.documentElement.scrollWidth-innerWidth,
    eventCards:document.querySelectorAll('.event-groups .event-card').length,
    navigation:[...document.querySelectorAll('.gog-mobile-nav a')].map(a=>({text:a.textContent.trim(),left:a.getBoundingClientRect().left,right:a.getBoundingClientRect().right,display:getComputedStyle(a).display})),
    admin:(() => { const a=document.querySelector('.gog-admin-link'); const r=a.getBoundingClientRect(); return {text:a.textContent.trim(),left:r.left,right:r.right,display:getComputedStyle(a).display}; })(),
    header:(() => { const h=document.querySelector('.gog-site-header').getBoundingClientRect(); const l=document.querySelector('.gog-brand img').getBoundingClientRect(); const b=document.querySelector('.gog-brand').getBoundingClientRect(); return {height:h.height,logoWidth:l.width,logoHeight:l.height,brandLeft:b.left,brandTop:b.top}; })()
  })`);
  assert(mobileHome.overflow <= 1, `Mobile homepage horizontal overflow: ${mobileHome.overflow}`);
  assert.equal(mobileHome.eventCards >= 2, true);
  assert.deepEqual(mobileHome.navigation.map(item=>item.text), ['Home','House Format','Deckbuilder']);
  assert(mobileHome.navigation.every(item=>item.display!=='none' && item.left>=0 && item.right<=391));
  assert(mobileHome.admin.display!=='none' && mobileHome.admin.left>=0 && mobileHome.admin.right<=391);
  assert.deepEqual(mobileHome.header, mobileCardList.header, 'Non-editor Guild of Games pages keep the shared mobile header');
  await screenshot('gog-home-mobile.png');
  evidence.cardListBrand = cardListBrand;
  evidence.mobileCardList = mobileCardList;
  evidence.mobileHome = mobileHome;
  evidence.checks.push('shared Guild of Games branding and two-way navigation');

  const unexpectedFailures = failedResponses.filter(({ url, status }) => status >= 400 && !url.includes('/gog/api/cards/') && !url.endsWith('favicon.ico'));
  if (failedResponses.length || errors.length) console.log(JSON.stringify({ failedResponses, consoleErrors: errors }, null, 2));
  assert.deepEqual(unexpectedFailures, []);
  const nonResourceErrors = errors.filter((message) => !message.startsWith('Failed to load resource:'));
  assert.deepEqual(nonResourceErrors, []);
  await writeFile(resolve(artifacts, 'browser-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  try { socket.close(); } catch {}
  chrome.kill();
  await Promise.race([new Promise((resolvePromise) => chrome.once('exit', resolvePromise)), sleep(1500)]);
  const tempRoot = resolve(tmpdir()).replace(/[\\/]+$/, '');
  if (profile.startsWith(`${tempRoot}${sep}`)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await rm(profile, { recursive: true, force: true }); break; }
      catch { await sleep(500); }
    }
  }
}
