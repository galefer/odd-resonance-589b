// Browser rehearsal on a disposable event. Only loopback requests reach the fixture API.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { onRequest } from '../../functions/gog/api/[[path]].js';
import { env, testCookies, setEventTime, fixtureShare } from './event-app.mjs';
const root = resolve(import.meta.dirname, '../../public');
const mime = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:' + server.address().port);
    if (url.pathname.startsWith('/gog/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const r = await onRequest({
        env,
        request: new Request(url, {
          method: req.method,
          headers: req.headers,
          body: body.length ? body : undefined,
        }),
      });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const path = resolve(
      root,
      '.' + decodeURIComponent(url.pathname) + (url.pathname.endsWith('/') ? 'index.html' : ''),
    );
    if (!path.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    res
      .writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' })
      .end(await readFile(path));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const profile = await mkdtemp(join(tmpdir(), 'jush-event-test-'));
const chrome = spawn(
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--disable-background-networking',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    } catch {}
  }
  assert.ok(port, 'Chrome DevTools startup');
  const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let seq = 0;
  const calls = new Map(),
    errors = [];
  ws.onmessage = (e) => {
    const v = JSON.parse(e.data);
    if (v.id && calls.has(v.id)) {
      const [r, j] = calls.get(v.id);
      calls.delete(v.id);
      v.error ? j(Error(v.error.message)) : r(v.result);
    }
    if (v.method === 'Runtime.exceptionThrown')
      errors.push(v.params.exceptionDetails.exception?.description || v.params.exceptionDetails.text);
  };
  const send = (method, params = {}) =>
    new Promise((r, j) => {
      const id = ++seq;
      calls.set(id, [r, j]);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = async (exp) => {
    for (let i = 0; i < 100; i++) {
      if (await ev(exp)) return;
      await sleep(100);
    }
    throw Error('Timed out: ' + exp + '; page: ' + (await ev('document.body.innerText.slice(0,450)')));
  };
  const goto = async (path) => {
    await send('Page.navigate', { url: origin + path });
    await wait('location.pathname===' + JSON.stringify(path.split('?')[0]) + '&&document.readyState==="complete"');
  };
  const click = (selector) => ev('document.querySelector(' + JSON.stringify(selector) + ').click()');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');
  await send('Network.setCookie', {
    name: 'jush_member',
    value: testCookies[4].split('=')[1],
    url: origin,
    path: '/gog/api',
  });
  for (const width of [390, 1280]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 850,
      deviceScaleFactor: 1,
      mobile: width < 800,
    });
    await goto('/gog/duel/');
    await wait('document.querySelector("#find")&&document.querySelector("#standings .name")');
    assert.equal(await ev('document.querySelectorAll(".j-app-nav a").length'), 5);
    assert.ok(await ev('document.querySelector("#duel-controls").innerText.includes("4 of 4 places used")'));
    assert.ok(
      await ev(
        'document.querySelector("#duel-controls").getBoundingClientRect().bottom<=document.querySelector("#standings-title").getBoundingClientRect().top',
      ),
    );
    assert.ok(await ev('document.documentElement.scrollWidth<=innerWidth+1'));
    await click('#account');
    await wait(
      'document.querySelector("#player-dialog").open&&document.querySelector("#dialog-body").innerText.includes("Loss vs")',
    );
    await click('#close-dialog');
    setEventTime('22:00');
    await goto('/gog/duel/?closed=1');
    await wait('document.querySelector("#standings .name")');
    assert.equal(await ev('document.querySelector("#duel-controls").childElementCount'), 0);
    setEventTime('18:00');
  }
  const as = async (i) =>
    send('Network.setCookie', {
      name: 'jush_member',
      value: testCookies[i].split('=')[1],
      url: origin,
      path: '/gog/api',
    });
  await as(5);
  await goto('/gog/duel/');
  await wait('document.querySelector("#find")');
  await ev(
    "const field=document.querySelector('#find');field.value='Tester6';field.dispatchEvent(new Event('input',{bubbles:true}));",
  );
  await click('#opponents [data-profile]');
  await wait('document.querySelector("[data-action=choose-W]")');
  await click('[data-action=choose-W]');
  await click('[data-action=submit]');
  await wait(
    '!document.querySelector("dialog").open&&document.querySelector("#duel-controls").innerText.includes("Win vs Tester6")',
  );
  await as(6);
  await goto('/gog/duel/');
  await wait('document.querySelector("[data-action=review]")');
  await click('[data-action=review]');
  await click('[data-action=approve]');
  await wait(
    '!document.querySelector("dialog").open&&document.querySelector("#duel-controls").innerText.includes("Loss vs Tester5")',
  );
  assert.ok(await ev('document.querySelector("#duel-controls").innerText.includes("2 of 4 places used")'));
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await goto('/gog/deckbuilder/shared/?id=' + fixtureShare);
  await wait('!document.querySelector("#copy").hidden');
  assert.equal(await ev('document.querySelectorAll(".shared-cards figure").length'), 2);
  assert.equal(
    await ev('indexedDB.databases().then(rows=>rows.some(row=>row.name==="gog-jush-deckbuilder-v1"))'),
    false,
  );
  await click('#copy');
  await wait(
    'location.pathname==="/gog/deckbuilder/"&&document.querySelector("#deck-name")?.textContent==="Rehearsal deck"',
  );
  await send('Emulation.setTouchEmulationEnabled', {enabled: true});
  for (const [width, height] of [[320, 640], [390, 844], [740, 390], [800, 900]]) {
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: true});
    const measure = () => ev(`(() => {
      const rect = s => document.querySelector(s).getBoundingClientRect();
      const grip = rect('#mobile-workspace-splitter');
      return {x: grip.x + grip.width / 2, y: grip.y + grip.height / 2,
        library: rect('#card-library-panel').height, deck: rect('#deck-workspace').height,
        bottom: rect('#deck-workspace').bottom, nav: rect('.j-app-nav').top};
    })()`);
    await wait('document.querySelector("#mobile-workspace-splitter").getBoundingClientRect().height >= 44');
    await ev("document.querySelector('#mobile-workspace-splitter').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))");
    await wait("Math.abs(document.querySelector('#workspace').getBoundingClientRect().bottom - document.querySelector('.j-app-nav').getBoundingClientRect().top) < 4");
    await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const before = await measure();
    assert.ok(before.deck > 40 && before.library > 40 && before.bottom <= before.nav + 1, JSON.stringify(before));
    await send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: before.x, y: before.y}]});
    await send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: before.x, y: before.y - 36}]});
    await send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    const after = await measure();
    assert.ok(after.deck > before.deck + 15 && after.library < before.library - 15, JSON.stringify({before,after}));
  }
  await send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  await goto('/gog/voting/');
  await wait('document.querySelector("#catalogue")?.shadowRoot?.querySelector("#card-modal")');
  assert.equal(await ev('!!document.querySelector("#catalogue").shadowRoot.querySelector("#card-search")'), false);
  assert.equal(await ev('document.querySelector(".hero-meta a").pathname'), '/gog/cards/');
  await send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});
  await wait('document.querySelector("#catalogue").shadowRoot.querySelector("#card-search")');
  await send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  await wait('!document.querySelector("#catalogue").shadowRoot.querySelector("#card-search").getClientRects().length');
  await goto('/gog/cards/');
  await wait('document.querySelector(".card-row") && document.querySelector(".j-account img")');
  assert.equal(await ev("document.querySelector('.j-account').ariaLabel"), 'Account for Tester6');
  assert.match(await ev("document.querySelector('.j-account img').src"), /\/12\/image\?size=cover&purpose=profile$/);
  for (const [width, height] of [[320, 640], [390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: true});
    await ev('document.fonts.ready');
    const layout = await ev(`(() => {
      const rect = s => document.querySelector(s).getBoundingClientRect();
      const rows = [...document.querySelectorAll('.card-row')];
      return { first: rect('.card-row').top, shown: rows.filter(r => r.getBoundingClientRect().bottom <= rect('.j-app-nav').top).length,
        avatar: rect('.j-account').width, portrait: rect('.j-account-portrait').width,
        filter: rect('#filter-toggle').width, overflow: document.documentElement.scrollWidth > innerWidth };
    })()`);
    console.log('Cards at ' + width + 'x' + height, layout);
    assert.ok(layout.shown >= 6 && !layout.overflow, JSON.stringify(layout));
    assert.deepEqual([layout.avatar, layout.portrait, layout.filter], [48, 32, 48]);
  }
  await click('.catalogue-rules summary');
  assert.ok(await ev("document.querySelector('.catalogue-rules p').getClientRects().length > 0"));
  await click('.catalogue-rules summary');
  await click('#filter-toggle');
  await wait('document.querySelector("#filter-toggle").getAttribute("aria-expanded")==="true"');
  await click('#filter-toggle');
  await click('[data-list-view="changes"]');
  await wait('document.querySelector(".is-house-change .card-status-mobile .house-change-badge")?.getClientRects().length');
  assert.equal(await ev("document.querySelector('#results-count').textContent"), '1 card shown');
  assert.equal(await ev("document.querySelector('.card-name').innerText"), 'Rehearsal Card');
  assert.ok(await ev("document.querySelector('.card-metadata .change-context').innerText.includes('Limited')"));
  await click('[data-list-view="recent"]');
  await wait('document.querySelector("[data-list-view=recent]").getAttribute("aria-pressed")==="true"');
  await click('[data-list-view="current"]');
  const point = await ev(`(() => {const r=document.querySelector('.card-thumbnail').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[point]});
  await send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
  await wait('document.querySelector("#card-modal").open');
  await click('[data-close-dialog="card-modal"]');
  await send('Emulation.setDeviceMetricsOverride', {width:1280, height:900, deviceScaleFactor:1, mobile:false});
  assert.ok(await ev("document.querySelector('.ja-main > h1').getClientRects().length > 0"));
  assert.ok(await ev("document.querySelector('.card-metadata > span').getClientRects().length > 0"));
  assert.ok(await ev("document.querySelector('.status-cell .status-badge b').getClientRects().length > 0"));
  assert.equal(await ev("document.querySelector('.catalogue-rules').getClientRects().length"), 0);
  await send('Emulation.setDeviceMetricsOverride', {width:390, height:844, deviceScaleFactor:1, mobile:true});
  await click('.j-account');
  await wait('document.querySelector("#player-dialog")?.open && document.querySelector("#dialog-title").textContent==="My account"');
  await as(5);
  await goto('/gog/cards/');
  await wait('document.querySelector(".j-account-portrait")?.textContent==="T"');
  await send('Network.clearBrowserCookies');
  await goto('/gog/cards/');
  await wait('document.querySelector(".j-account")?.textContent==="Sign in"');
  await click('.j-account');
  await wait('document.querySelector("#auth")?.open');
  await goto('/gog/');
  await wait('document.querySelector("#home-standings .item")');
  assert.equal(await ev('!!document.querySelector("#card-search")'), false);
  assert.ok(await ev("document.querySelector('#home-standings').getBoundingClientRect().bottom < document.querySelector('.j-app-nav').getBoundingClientRect().top"));
  assert.ok(await ev("['.hero-mobile-actions','.event-deck-link','.jush-ballot-entry','.site-footer'].every(s=>!document.querySelector(s).getClientRects().length)"));
  await click('.mobile-format-summary summary');
  assert.ok(await ev("document.querySelector('.mobile-format-summary a[href=\"/gog/cookies/\"]').getClientRects().length > 0"));
  await goto('/gog/install/');
  await wait('document.querySelector(".ja-qr").naturalWidth>0');
  assert.deepEqual(errors, []);
  console.log(
    'Chrome passed: compact Cards and account states, desktop catalogue, Duel, reciprocal match history, Builder touch resizing, responsive Voting, Home and install QR.',
  );
} finally {
  ws?.close();
  chrome.kill();
  server.closeAllConnections();
  server.close();
  await new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once('exit', r)));
  if (resolve(profile).startsWith(resolve(tmpdir()) + sep))
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
}
