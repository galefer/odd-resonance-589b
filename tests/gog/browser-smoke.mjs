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

const evidence = { chrome: version.Browser, origin, checks: [], failedResponses, consoleErrors: errors };
try {
  await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable'), send('Log.enable')]);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${origin}/gog/deckbuilder/` });
  await waitFor(`document.readyState==='complete' && document.querySelectorAll('.library-card').length>0`, 'initial card catalogue');
  assert.match(await evaluate(`document.querySelector('#library-total').textContent`), /ELIGIBLE/);
  assert.equal(await evaluate(`document.querySelector('#saved-label').textContent`), 'Saved on this device');
  assert.equal((await counts()).main, 0);
  evidence.checks.push('initial catalogue and IndexedDB state loaded');

  await click('.library-card .quick-add');
  await waitFor(`document.querySelector('#count-main').textContent==='1'`, 'legal card add');
  await click('#undo'); await waitFor(`document.querySelector('#count-main').textContent==='0'`, 'undo');
  await click('#redo'); await waitFor(`document.querySelector('#count-main').textContent==='1'`, 'redo');
  evidence.checks.push('add, undo and redo');

  await setValue('#search', 'Pot of Greed');
  await waitFor(`[...document.querySelectorAll('.library-card button[aria-label]')].some(e=>e.getAttribute('aria-label').startsWith('Inspect Pot of Greed,'))`, 'Forbidden card search');
  await evaluate(`(() => { const e=[...document.querySelectorAll('.library-card button[aria-label]')].find(e=>e.getAttribute('aria-label').startsWith('Inspect Pot of Greed,')); e.click(); return true; })()`);
  assert.equal(await evaluate(`document.querySelector('#card-status').textContent`), 'Forbidden');
  assert.equal(await evaluate(`document.querySelector('#add-auto').disabled`), true);
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

  const desktopLayout = await evaluate(`({overflow:document.documentElement.scrollWidth-window.innerWidth,columns:getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns,dialogOpen:document.querySelector('#info-dialog').open})`);
  assert(desktopLayout.overflow <= 1, `Desktop horizontal overflow: ${desktopLayout.overflow}`);
  if (desktopLayout.dialogOpen) await evaluate(`document.querySelector('#info-dialog').close()`);
  await screenshot('deckbuilder-desktop.png');
  evidence.desktop = desktopLayout;

  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 768 });
    await sleep(180);
    const layout = await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,nav:getComputedStyle(document.querySelector('.mobile-nav')).display,workspace:getComputedStyle(document.querySelector('.workspace')).display})`);
    assert(layout.scrollWidth <= layout.width + 1, `${width}px horizontal overflow: ${layout.scrollWidth-layout.width}`);
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
