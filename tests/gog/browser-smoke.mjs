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
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(value)}`);
}
const click = (selector) => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing ${selector}'); e.click(); return true; })()`);
const setValue = (selector, value) => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing ${selector}'); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
const screenshot = async (name) => {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(resolve(artifacts, name), Buffer.from(result.data, 'base64'));
};
const counts = () => evaluate(`({main:Number(document.querySelector('#count-main').textContent),extra:Number(document.querySelector('#count-extra').textContent),side:Number(document.querySelector('#count-side').textContent)})`);

const point = (selector) => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing drag target'); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
async function dragCard(source, target, operation) {
  // Start a real mouse drag on the artwork, then deliver Chrome's native drag
  // data to the target. Synthetic DOM drops miss effectAllowed/dropEffect bugs.
  interceptedDrag = null;
  await send('Input.setInterceptDrags', { enabled: true });
  const from = await point(source), to = await point(target);
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
    for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, ...to, data: interceptedDrag });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', buttons: 0, clickCount: 1 });
  } finally {
    await send('Input.setInterceptDrags', { enabled: false });
  }
}
async function rightClick(selector) {
  const at = await point(selector);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'right', buttons: 2, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'right', buttons: 0, clickCount: 1 });
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
  assert.match(await evaluate(`document.querySelector('#library-total').textContent`), /ELIGIBLE/);
  assert.equal(await evaluate(`document.querySelector('#saved-label').textContent`), 'Saved on this device');
  assert.equal((await counts()).main, 0);
  evidence.checks.push('initial catalogue and IndexedDB state loaded');

  assert.equal(await evaluate(`document.querySelector('.quick-add')`), null, 'Library hover add controls should be removed');
  await dragCard('.library-card img', '.deck-grid[data-zone="main"]', 'copy');
  await waitFor(`document.querySelector('#count-main').textContent==='1'`, 'library artwork drag into empty deck');
  await click('#undo'); await waitFor(`document.querySelector('#count-main').textContent==='0'`, 'undo');
  await click('#redo'); await waitFor(`document.querySelector('#count-main').textContent==='1'`, 'redo');
  await dragCard('.library-card img', '.deck-grid[data-zone="main"] .card-tile img', 'copy');
  await waitFor(`document.querySelector('#count-main').textContent==='2'`, 'library drop onto existing card');
  await rightClick('.deck-grid[data-zone="main"] .card-tile img');
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

  await setValue('#search', 'Pot of Greed');
  await waitFor(`[...document.querySelectorAll('.library-card button[aria-label]')].some(e=>e.getAttribute('aria-label').startsWith('Inspect Pot of Greed,'))`, 'Forbidden card search');
  await evaluate(`(() => { const e=[...document.querySelectorAll('.library-card button[aria-label]')].find(e=>e.getAttribute('aria-label').startsWith('Inspect Pot of Greed,')); e.click(); return true; })()`);
  assert.equal(await evaluate(`document.querySelector('#card-status').textContent`), 'Forbidden');
  assert.equal(await evaluate(`document.querySelector('#add-auto').disabled`), true);
  await dragCard('.library-card img', '.deck-grid[data-zone="main"]', 'copy');
  assert.equal((await counts()).main, 1, 'Dragging cannot bypass Forbidden restrictions');
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
  const priorTimeOrigin = await evaluate('performance.timeOrigin');
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`performance.timeOrigin!==${JSON.stringify(priorTimeOrigin)} && document.readyState==='complete' && document.querySelector('#count-main')?.textContent==='3'`, 'IndexedDB refresh restore', 20_000);
  assert.deepEqual(await counts(), { main: 3, extra: 1, side: 1 });
  evidence.checks.push('refresh restores current local deck');

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
  for (const width of [320, 390, 768, 1024, 1180, 1440, 1920, 2048, 2560]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 768 });
    await sleep(180);
    const layout = await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,nav:getComputedStyle(document.querySelector('.mobile-nav')).display,workspace:getComputedStyle(document.querySelector('.workspace')).display})`);
    assert(layout.scrollWidth <= layout.width + 1, `${width}px horizontal overflow: ${layout.scrollWidth-layout.width}`);
    if (width >= 1180) assert(await evaluate(`document.querySelector('.workspace').getBoundingClientRect().width >= innerWidth-20`), 'Workspace should use the available width');
    if (width === 390) deckMobileHeader = await evaluate(`(() => { const h=document.querySelector('.gog-site-header').getBoundingClientRect(); const l=document.querySelector('.gog-brand img').getBoundingClientRect(); const b=document.querySelector('.gog-brand').getBoundingClientRect(); return {height:h.height,logoWidth:l.width,logoHeight:l.height,brandLeft:b.left,brandTop:b.top}; })()`);
    if (width === 2048) await screenshot('deckbuilder-2048.png');
    evidence.checks.push(`${width}px no horizontal overflow`);
  }

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(150); await click('.mobile-nav button[data-panel="library"]');
  assert.equal(await evaluate(`document.body.dataset.panel`), 'library');
  await setValue('#search', '1st Movement Solo');
  await waitFor(`document.querySelectorAll('.library-card').length===1`, 'mobile library result');
  const beforeMobile = await counts();
  await click('.library-card > button:first-child');
  assert.equal(await evaluate(`document.body.dataset.panel`), 'card');
  await click('#add-auto'); await click('.mobile-nav button[data-panel="deck"]');
  await waitFor(`document.body.dataset.panel==='deck'`, 'mobile deck panel');
  assert.equal((await counts()).main, beforeMobile.main + 1);
  await waitFor(`document.querySelector('#validation-title').textContent!=='Checking published house rules'`, 'mobile validation result');
  await waitFor(`document.querySelector('#saved-label').textContent==='Saved on this device'`, 'saved mobile screenshot state');
  await screenshot('deckbuilder-mobile.png');
  evidence.checks.push('mobile Library → Card → Add → Deck without drag');

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${origin}/gog/` });
  await waitFor(`document.readyState==='complete' && document.querySelectorAll('#event-grid .event-card').length>=2`, 'Guild of Games homepage events');
  const homeBrand = await evaluate(`({
    brand:document.querySelector('.gog-brand strong').textContent.trim(),
    navigation:[...document.querySelectorAll('.gog-primary-nav a')].map(a=>a.textContent.trim()),
    heading:document.querySelector('.hero-copy h1').textContent.trim(),
    events:[...document.querySelectorAll('.event-card')].map(card=>card.textContent.trim()),
    eventDates:[...document.querySelectorAll('.event-full-date')].map(e=>e.textContent.trim()),
    logoLoaded:document.querySelector('.hero-emblem').naturalWidth>0,
    overflow:document.documentElement.scrollWidth-innerWidth,
    header:(() => { const h=document.querySelector('.gog-site-header').getBoundingClientRect(); const l=document.querySelector('.gog-brand img').getBoundingClientRect(); const b=document.querySelector('.gog-brand').getBoundingClientRect(); return {height:h.height,logoWidth:l.width,logoHeight:l.height,brandLeft:b.left,brandTop:b.top}; })()
  })`);
  assert.equal(homeBrand.brand, 'Guild of Games');
  assert.deepEqual(homeBrand.navigation, ['Home','House Format','Deckbuilder']);
  assert(homeBrand.events.some(text=>text.includes('Yu-Gi-Oh! TCG Advanced')));
  assert(homeBrand.events.some(text=>text.includes('Yu-Gi-Oh! TCG House')));
  assert(homeBrand.eventDates.some(text=>text.startsWith('Thursday')));
  assert(homeBrand.eventDates.some(text=>text.startsWith('Friday')));
  assert(!homeBrand.events.some(text=>/every thursday|every friday/i.test(text)), 'Public cards should show one upcoming date, not promise a weekly schedule');
  assert(homeBrand.logoLoaded);
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
    subtitle:document.querySelector('.hero-subtitle').textContent.trim(),
    note:document.querySelector('.altered-list-note').textContent.trim(),
    logoLoaded:document.querySelector('.hero-logo').naturalWidth>0,
    homePath:new URL(document.querySelector('.gog-primary-nav a[href="/gog/"]').href).pathname,
    deckbuilderPath:new URL(document.querySelector('.gog-primary-nav a[href="/gog/deckbuilder/"]').href).pathname,
    overflow:document.documentElement.scrollWidth-innerWidth,
    background:getComputedStyle(document.body).backgroundColor,
    header:(() => { const h=document.querySelector('.gog-site-header').getBoundingClientRect(); const l=document.querySelector('.gog-brand img').getBoundingClientRect(); const b=document.querySelector('.gog-brand').getBoundingClientRect(); return {height:h.height,logoWidth:l.width,logoHeight:l.height,brandLeft:b.left,brandTop:b.top}; })()
  })`);
  assert.equal(cardListBrand.brand, 'Guild of Games');
  assert.equal(cardListBrand.heading, 'Yu-Gi-Oh! JUSH House Format');
  assert.equal(cardListBrand.subtitle, 'Justice Hunters House Format');
  assert.match(cardListBrand.note, /altered banlist based on the official JUSH-era list/i);
  assert(cardListBrand.logoLoaded, 'Guild of Games hero logo should load');
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
  assert.deepEqual(mobileCardList.header, deckMobileHeader, 'Mobile House Format and deckbuilder headers should match');
  await screenshot('card-list-mobile.png');
  await send('Page.navigate', { url: `${origin}/gog/` });
  await waitFor(`document.readyState==='complete' && document.querySelectorAll('#event-grid .event-card').length>=2`, 'mobile homepage events');
  const mobileHome = await evaluate(`({
    overflow:document.documentElement.scrollWidth-innerWidth,
    eventCards:document.querySelectorAll('#event-grid .event-card').length,
    navigation:[...document.querySelectorAll('.gog-mobile-nav a')].map(a=>({text:a.textContent.trim(),left:a.getBoundingClientRect().left,right:a.getBoundingClientRect().right,display:getComputedStyle(a).display})),
    admin:(() => { const a=document.querySelector('.gog-admin-link'); const r=a.getBoundingClientRect(); return {text:a.textContent.trim(),left:r.left,right:r.right,display:getComputedStyle(a).display}; })(),
    header:(() => { const h=document.querySelector('.gog-site-header').getBoundingClientRect(); const l=document.querySelector('.gog-brand img').getBoundingClientRect(); const b=document.querySelector('.gog-brand').getBoundingClientRect(); return {height:h.height,logoWidth:l.width,logoHeight:l.height,brandLeft:b.left,brandTop:b.top}; })()
  })`);
  assert(mobileHome.overflow <= 1, `Mobile homepage horizontal overflow: ${mobileHome.overflow}`);
  assert.equal(mobileHome.eventCards >= 2, true);
  assert.deepEqual(mobileHome.navigation.map(item=>item.text), ['Home','House Format','Deckbuilder']);
  assert(mobileHome.navigation.every(item=>item.display!=='none' && item.left>=0 && item.right<=391));
  assert(mobileHome.admin.display!=='none' && mobileHome.admin.left>=0 && mobileHome.admin.right<=391);
  assert.deepEqual(mobileHome.header, deckMobileHeader, 'Mobile homepage and deckbuilder headers should match');
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
