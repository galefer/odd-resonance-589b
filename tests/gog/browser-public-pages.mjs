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
const evidence = { origin, viewports: [], checks: [], failedResponses, consoleErrors: errors };
try {
  await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable'), send('Log.enable')]);
  await send('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
  const headers = new Map();
  for (const route of ['home','house-format']) {
    await send('Page.navigate', { url: `${origin}/gog/${route === 'home' ? '' : 'house-format/'}` });
    await waitFor(route === 'home' ? `document.querySelectorAll('.event-card').length>=2` : `document.querySelectorAll('.card-row').length>0`, route);
    for (const width of [375,768,1024,1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width,height:900,deviceScaleFactor:1,mobile:width<600 });
      await evaluate('window.scrollTo(0,0)');
      await sleep(100);
      const geometry = await evaluate(`(() => {
        const h=document.querySelector('.gog-site-header').getBoundingClientRect();
        const b=document.querySelector('.gog-brand').getBoundingClientRect();
        return {overflow:document.documentElement.scrollWidth-innerWidth,header:{height:h.height,left:b.left,top:b.top},
          clipped:[...document.querySelectorAll('main button,main input,main a,main h1,main h2,main h3')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.left<0||r.right>innerWidth+1)}).map(e=>e.id||e.className),
          font:getComputedStyle(document.querySelector('main h2')).fontFamily};
      })()`);
      assert(geometry.overflow<=1,`${route} ${width}px overflow`);
      assert.deepEqual(geometry.clipped,[],`${route} ${width}px clipped controls`);
      assert(!/Georgia|Times/.test(geometry.font));
      if (headers.has(width)) assert.deepEqual(geometry.header,headers.get(width),`Header consistency at ${width}px`);
      else headers.set(width,geometry.header);
      if (route==='home') {
        await evaluate(`document.querySelector('.event-groups').scrollIntoView({block:'center'})`);
        await waitFor(`[...document.querySelectorAll('.event-artwork')].every(img=>img.complete&&img.naturalWidth>0)`,'artwork');
        const times=await evaluate(`[...document.querySelectorAll('.event-card:not(.special) .event-time')].map(e=>e.textContent)`);
        assert(times.length>=4 && times.length<=5);
        assert(times.every(t=>t.includes('5:30pm – 9:00pm')));
        assert.equal(await evaluate(`[...document.querySelectorAll('.event-full-date')].every(e=>e.textContent.trim().startsWith('Thursday'))`),true);
        assert.equal(await evaluate(`document.querySelector('#events-title').textContent.trim()`),'Events this month');
        assert.equal(await evaluate(`document.querySelectorAll('#advanced-event-grid .event-card.advanced').length`),times.length-1);
        assert.equal(await evaluate(`document.querySelectorAll('#special-event-grid .event-card.house').length`),1);
        assert.equal(await evaluate(`document.body.textContent.includes('Earlier this month')`),false);
        const eventWidths=await evaluate(`({advanced:document.querySelector('#advanced-event-grid .event-card').getBoundingClientRect().width,special:document.querySelector('#special-event-grid .event-card').getBoundingClientRect().width})`);
        assert(Math.abs(eventWidths.advanced-eventWidths.special)<=1);
      } else {
        await evaluate(`document.querySelector('.list-toolbar').scrollIntoView()`);
        const panel = await evaluate(`getComputedStyle(document.querySelector('#filters-panel')).display`);
        if (width===375) {
          assert.equal(panel,'none');
          await click('#filter-toggle');
          assert.equal(await evaluate(`document.querySelector('#filter-toggle').getAttribute('aria-expanded')`),'true');
          await click('#filter-toggle');
        } else assert.notEqual(panel,'none');
        if (width===1440) {
          const positions=await evaluate(`(() => {const f=document.querySelector('#filters-panel').getBoundingClientRect(),r=document.querySelector('#results-panel').getBoundingClientRect();return {filterRight:f.right,resultsLeft:r.left}})()`);
          assert(positions.filterRight<positions.resultsLeft,'Desktop filters should sit beside the results');
        }
      }
      await screenshot(`${route}-${width}-details.png`);
      evidence.viewports.push({route,width,...geometry});
    }
  }
  await click('[data-filter="status"][value="forbidden"]');
  await click('[data-filter="status"][value="limited"]');
  await click('[data-filter="category"][value="Spell"]');
  const filtered=await evaluate(`[...document.querySelectorAll('.card-row')].map(e=>({status:e.className,type:e.querySelector('.card-type-cell strong').textContent}))`);
  assert(filtered.length>0);
  assert(filtered.every(e=>/status-forbidden|status-limited/.test(e.status)&&e.type==='Spell'));
  await click('#clear-filters');
  await click('#changes-tab');
  assert.equal(await evaluate(`document.querySelector('#results-title').textContent`),'House Banlist Tweaks');
  await click('#current-tab');
  await setValue('#card-search','Pot of Greed');
  await waitFor(`[...document.querySelectorAll('.suggestion-name')].some(e=>e.textContent.toLowerCase()==='pot of greed')`,'exact search');
  await click('#clear-search');
  await setValue('#card-search','Dracotail');
  await waitFor(`[...document.querySelectorAll('.suggestion-name')].some(e=>e.textContent.includes('Dracotail'))`,'partial search');
  await click('.suggestion-row');
  await waitFor(`document.querySelector('#card-modal').open && !document.querySelector('#card-detail').hidden`,'card details');
  assert((await evaluate(`document.querySelector('#detail-name').textContent`)).includes('Dracotail'));
  await click('[data-close-dialog="card-modal"]');
  evidence.checks.push('multi-status + card-type filters, persistent house-tweaks view, exact and partial search, eligible JUSH card details');
  evidence.checks.push('375/768/1024/1440px layouts, consistent headers, event artwork and full time ranges');
  assert.deepEqual(failedResponses,[]);
  assert.deepEqual(errors,[]);
  await writeFile(resolve(artifacts,'public-pages.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
} finally {
  try { socket.close(); } catch {}
  chrome.kill();
  await Promise.race([new Promise(resolvePromise=>chrome.once('exit',resolvePromise)),sleep(1500)]);
  const tempRoot=resolve(tmpdir()).replace(/[\\/]+$/,'');
  if (profile.startsWith(`${tempRoot}${sep}`)) {
    for (let attempt=0;attempt<5;attempt++) {
      try { await rm(profile,{recursive:true,force:true});break; } catch { await sleep(500); }
    }
  }
}
