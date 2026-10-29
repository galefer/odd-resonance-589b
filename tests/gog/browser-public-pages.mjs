#!/usr/bin/env node
/** Dependency-free Chrome DevTools smoke test for the public JUSH pages. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const origin = process.argv[2] || 'http://127.0.0.1:8790';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const artifacts = resolve(import.meta.dirname, 'artifacts');
const profile = await mkdtemp(join(tmpdir(), 'gog-public-chrome-'));
const debugPort = 9300 + Math.floor(Math.random() * 300);
await mkdir(artifacts, { recursive: true });

const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter',
  '--hide-scrollbars', '--force-device-scale-factor=1',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--window-size=1536,1024', 'about:blank'
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

await pollJson(`http://127.0.0.1:${debugPort}/json/version`);
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
  await send('Page.navigate', { url: `${origin}/gog/` });
  await waitFor(`document.querySelectorAll('.card-row').length>0 && document.querySelector('#next-event-time').textContent!=='Checking schedule…'`, 'JUSH homepage');

  for (const width of [390,768,1440,1536,1920,2048]) {
    await send('Emulation.setDeviceMetricsOverride', { width,height:1024,deviceScaleFactor:1,mobile:width<600 });
    await evaluate('window.scrollTo(0,0)');
    await sleep(120);
    const geometry = await evaluate(`(() => {
      const hero=document.querySelector('.hero').getBoundingClientRect();
      const event=document.querySelector('.next-event-panel').getBoundingClientRect();
      const shell=document.querySelector('.search-zone .shell').getBoundingClientRect();
      const stage=document.querySelector('.hero-stage');
      const status=document.querySelector('.status-filter input');
      const statusRect=status.getBoundingClientRect();
      const statusStyle=getComputedStyle(status);
      const semi=document.querySelector('.status-filter .semi-limited span');
      const characterTreatment=(selector)=>{
        const wrapper=document.querySelector(selector);
        const image=wrapper.querySelector('img');
        const style=getComputedStyle(wrapper);
        const imageStyle=getComputedStyle(image);
        const before=getComputedStyle(wrapper,'::before');
        const after=getComputedStyle(wrapper,'::after');
        return {
          maskImage:style.maskImage,
          webkitMaskImage:style.webkitMaskImage,
          opacity:style.opacity,
          filter:style.filter,
          imageOpacity:imageStyle.opacity,
          imageFilter:imageStyle.filter,
          before:{content:before.content,backgroundImage:before.backgroundImage},
          after:{content:after.content,backgroundImage:after.backgroundImage}
        };
      };
      const build=[...document.querySelectorAll('a,button')].filter(e=>e.textContent.trim().toLowerCase()==='build a deck');
      const adminButton=document.querySelector('#admin-button');
      const adminRect=adminButton.getBoundingClientRect();
      return {
        viewport:innerWidth,
        overflow:document.documentElement.scrollWidth-innerWidth,
        clipped:[...document.querySelectorAll('main button,main input,main a,main h1,main h2,main h3')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.left<0||r.right>innerWidth+1)}).map(e=>e.id||e.className),
        rootFont:getComputedStyle(document.documentElement).fontSize,
        bodyFont:getComputedStyle(document.body).fontFamily,
        headingFont:getComputedStyle(document.querySelector('#search-heading')).fontFamily,
        hero:{height:hero.height,left:hero.left,right:hero.right}, event:{left:event.left,right:event.right,height:event.height},
        content:{left:shell.left,right:shell.right,width:shell.width,ratio:shell.width/innerWidth},
        stage:{background:getComputedStyle(stage).backgroundColor,overflow:getComputedStyle(stage).overflow},
        characterTreatment:{
          left:characterTreatment('.hero-character-left'),
          right:characterTreatment('.hero-character-right'),
          heroAfter:{backgroundImage:getComputedStyle(document.querySelector('.hero'),'::after').backgroundImage}
        },
        statusFilter:{width:statusRect.width,height:statusRect.height,opacity:statusStyle.opacity,position:statusStyle.position,appearance:statusStyle.appearance,semiWhiteSpace:getComputedStyle(semi).whiteSpace},
        defaultComparisonRows:document.querySelectorAll('.change-context').length,
        buildCount:build.length,
        adminButton:{text:adminButton.textContent.trim(),inHeader:Boolean(adminButton.closest('.gog-site-header')),right:adminRect.right,width:adminRect.width},
        oldNavigation:document.querySelectorAll('.gog-primary-nav,.gog-mobile-nav,.view-tabs,.feature-card,.hero-actions').length,
        filterDisplay:getComputedStyle(document.querySelector('#filters-panel')).display
      };
    })()`);
    assert(geometry.overflow<=1,`${width}px overflow`);
    assert.deepEqual(geometry.clipped,[],`${width}px clipped controls`);
    assert.equal(geometry.rootFont,'16px');
    assert.match(geometry.bodyFont,/Barlow/i);
    assert.match(geometry.headingFont,/Barlow Condensed/i);
    assert.equal(geometry.buildCount,1,`${width}px single Build a deck action`);
    assert.equal(geometry.adminButton.text,'Admin Login',`${width}px signed-out admin label`);
    assert.equal(geometry.adminButton.inHeader,true,`${width}px admin control should be in the header`);
    assert(geometry.adminButton.width>=90,`${width}px admin control should remain readable`);
    assert(geometry.adminButton.right<=width+1,`${width}px admin control should remain within the viewport`);
    assert.equal(geometry.oldNavigation,0,`${width}px obsolete navigation/components`);
    assert.equal(geometry.viewport,width,`${width}px controlled CSS viewport`);
    assert.equal(geometry.stage.background,'rgba(0, 0, 0, 0)',`${width}px transparent hero stage`);
    assert.equal(geometry.characterTreatment.left.maskImage,'none',`${width}px left character should preserve source alpha without an inward mask`);
    assert.equal(geometry.characterTreatment.right.maskImage,'none',`${width}px right character should preserve source alpha without an inward mask`);
    assert.equal(geometry.characterTreatment.left.webkitMaskImage,'none');
    assert.equal(geometry.characterTreatment.right.webkitMaskImage,'none');
    assert.equal(geometry.characterTreatment.left.imageOpacity,'1');
    assert.equal(geometry.characterTreatment.right.imageOpacity,'1');
    assert.equal(geometry.characterTreatment.left.imageFilter,'none');
    assert.equal(geometry.characterTreatment.right.imageFilter,'none');
    if (width > 820) {
      assert.match(geometry.characterTreatment.right.before.backgroundImage,/paint-frame-right-512\.webp/,`${width}px upper crop overlap`);
      assert.match(geometry.characterTreatment.right.after.backgroundImage,/paint-frame-right-512\.webp/,`${width}px lower crop overlap`);
    } else {
      assert.equal(geometry.characterTreatment.right.before.content,'none',`${width}px no crop overlap needed`);
      assert.equal(geometry.characterTreatment.right.after.content,'none',`${width}px no crop overlap needed`);
    }
    assert.equal(geometry.defaultComparisonRows,0,`${width}px concise default rows`);
    if (width === 1536) assert(geometry.content.ratio>=.88&&geometry.content.ratio<=.90,`1536px working width should be 88–90%, got ${geometry.content.ratio}`);
    if (width === 2048) assert(geometry.content.width>=1700&&geometry.content.width<=1800,`2048px working width should be 1700–1800px, got ${geometry.content.width}`);
    if (width <= 768) {
      assert.equal(geometry.filterDisplay,'none');
      await click('#filter-toggle');
      assert.equal(await evaluate(`document.querySelector('#filter-toggle').getAttribute('aria-expanded')`),'true');
      await click('#filter-toggle');
    } else {
      assert.notEqual(geometry.filterDisplay,'none');
      assert(geometry.statusFilter.width>=18&&geometry.statusFilter.height>=18,'Desktop status checkbox should be visibly sized');
      assert.equal(geometry.statusFilter.opacity,'1');
      assert.equal(geometry.statusFilter.position,'relative');
      assert.equal(geometry.statusFilter.semiWhiteSpace,'nowrap');
      const positions=await evaluate(`(() => {const f=document.querySelector('#filters-panel').getBoundingClientRect(),r=document.querySelector('.results-column').getBoundingClientRect();return {filterRight:f.right,resultsLeft:r.left}})()`);
      assert(positions.filterRight<positions.resultsLeft,'Desktop filters should sit beside results');
    }
    await screenshot(`jush-home-${width}.png`);
    evidence.viewports.push({width,...geometry});
  }

  await evaluate(`window.dispatchEvent(new CustomEvent('gog:admin-session',{detail:{authenticated:true,email:'admin@example.com',csrfToken:'test-token'}}))`);
  assert.equal(await evaluate(`document.querySelector('#admin-button').textContent.trim()`),'Admin Panel','Authenticated session should relabel the header control');
  assert.equal(await evaluate(`document.querySelector('#admin-button').dataset.authenticated`),'true');
  await evaluate(`window.dispatchEvent(new CustomEvent('gog:admin-session',{detail:{authenticated:false}}))`);
  assert.equal(await evaluate(`document.querySelector('#admin-button').textContent.trim()`),'Admin Login','Signed-out session should restore the login label');

  await click('.status-filter .forbidden');
  assert.equal(await evaluate(`document.querySelector('[data-filter="status"][value="forbidden"]').checked`),true,'Status label click should check the input');
  assert(await evaluate(`[...document.querySelectorAll('.card-row')].every(e=>e.classList.contains('status-forbidden'))`),'Status label click should filter results');
  const focusedStatus=await evaluate(`(() => {const e=document.querySelector('[data-filter="status"][value="forbidden"]');e.focus();const s=getComputedStyle(e);return {focused:document.activeElement===e,outline:s.outlineStyle,shadow:s.boxShadow};})()`);
  assert.equal(focusedStatus.focused,true);
  assert.notEqual(focusedStatus.outline,'none');
  await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  assert.equal(await evaluate(`document.querySelector('[data-filter="status"][value="forbidden"]').checked`),false,'Space should toggle the focused status input');

  await send('Emulation.setDeviceMetricsOverride', { width:1536,height:1024,deviceScaleFactor:1,mobile:false });
  await send('Page.navigate', { url: `${origin}/gog/house-format/?view=changes#list-workspace` });
  await waitFor(`location.pathname==='/gog/' && document.querySelectorAll('.card-row').length>0`, 'legacy route redirect');
  assert.equal(await evaluate(`location.search`),'?view=changes');
  assert.equal(await evaluate(`location.hash`),'#list-workspace');
  assert.equal(await evaluate(`document.querySelector('#changes-only').checked`),true);
  assert(await evaluate(`document.querySelectorAll('.change-context').length>0`),'Comparison view should show baseline-to-current context');
  assert.equal(await evaluate(`document.querySelector('#results-kicker').hidden`),false);
  await screenshot('jush-home-changes-1536.png');

  await click('[data-filter="status"][value="forbidden"]');
  await click('[data-filter="status"][value="limited"]');
  await click('[data-filter="category"][value="Spell"]');
  const filtered=await evaluate(`[...document.querySelectorAll('.card-row')].map(e=>({status:e.className,meta:e.querySelector('.card-metadata').textContent}))`);
  assert(filtered.length>0);
  assert(filtered.every(e=>/status-forbidden|status-limited/.test(e.status)&&e.meta.includes('Spell')));
  await click('#clear-filters');
  await click('#changes-only');
  assert.equal(await evaluate(`document.querySelector('#changes-only').checked`),false);
  await click('#changes-only');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('view')`),'changes');
  await click('[data-rule-filter="unlimited"]');
  assert(await evaluate(`document.querySelectorAll('.card-row.status-unlimited').length>0`),'Unlimited house changes must remain in the comparison set');
  assert.equal(await evaluate(`[...document.querySelectorAll('.house-change-badge')].every(e=>e.textContent.trim()==='House change')`),true);
  await click('#clear-filters');

  await setValue('#card-search','Pot of Greed');
  await waitFor(`[...document.querySelectorAll('.suggestion-name')].some(e=>e.textContent.toLowerCase()==='pot of greed')`,'restricted-card search');
  await click('#clear-search');
  await setValue('#card-search','Dracotail');
  await waitFor(`[...document.querySelectorAll('.suggestion-name')].some(e=>e.textContent.includes('Dracotail'))`,'eligible-card search');
  await click('.suggestion-row');
  await waitFor(`document.querySelector('#card-modal').open && !document.querySelector('#card-detail').hidden`,'card details');
  assert((await evaluate(`document.querySelector('#detail-name').textContent`)).includes('Dracotail'));
  await click('[data-close-dialog="card-modal"]');

  assert.equal(await evaluate(`document.querySelector('.event-deck-link').getAttribute('href')`),'/gog/deckbuilder/');
  await send('Page.navigate', { url: `${origin}/gog/deckbuilder/` });
  await waitFor(`document.querySelector('#workspace') && document.querySelector('#card-library-panel') && document.querySelectorAll('.library-card').length>0`, 'deckbuilder direct load');
  assert.equal(await evaluate(`document.querySelectorAll('.gog-primary-nav,.gog-mobile-nav').length`),0);
  assert.equal(await evaluate(`document.querySelector('.gog-back-link').getAttribute('href')`),'/gog/');

  evidence.checks.push('single JUSH homepage route, preserved legacy query/hash redirect and direct deckbuilder route');
  evidence.checks.push('one deck CTA, live JUSH event panel, house-change checkbox, combined filters, eligible search and card details');
  evidence.checks.push('390/768/1440/1536/1920/2048px layouts at 1× scale, local fonts, effective working width, no overflow or clipped controls');
  evidence.checks.push('visible status checkboxes, full-label activation, keyboard Space toggle and concise default comparison rows');
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
