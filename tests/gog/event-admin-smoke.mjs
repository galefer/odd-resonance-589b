#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const origin = process.argv[2] || 'http://127.0.0.1:8791';
const setupToken = process.env.GOG_TEST_SETUP_TOKEN || 'local-event-test-setup-token';
const email = 'events-browser-test@example.com';
const password = 'LocalEventBrowserPassword1!';
const salt = 'ab'.repeat(16);
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function proof(value, valueSalt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(valueSalt), iterations: 310_000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const setupResponse = await fetch(`${origin}/gog/api/setup`, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, salt, passwordVerifier: await proof(password, salt), setupToken })
});
assert([200, 409].includes(setupResponse.status), `Admin setup returned ${setupResponse.status}: ${await setupResponse.text()}`);

const profile = await mkdtemp(join(tmpdir(), 'gog-events-chrome-'));
const debugPort = 9600 + Math.floor(Math.random() * 200);
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function pollJson(url, options) {
  let last;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const response = await fetch(url, options); if (response.ok) return response.json(); last = new Error(`HTTP ${response.status}`); }
    catch (error) { last = error; }
    await sleep(100);
  }
  throw last;
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
  const id = ++commandId;
  pending.set(id, { resolve: resolvePromise, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error.message)); else request?.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.text || 'Runtime exception');
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
  if (message.method === 'Network.responseReceived' && message.params.response.status >= 400)
    failedResponses.push({ status: message.params.response.status, url: message.params.response.url });
  if (message.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
};
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
async function waitFor(expression, label, timeout = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const setValue = (selector, value) => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);

try {
  await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable'), send('Log.enable')]);
  await waitFor(`document.readyState==='complete' && document.querySelectorAll('.event-card').length>=2`, 'homepage events');
  await click('#events-admin-link');
  await waitFor(`document.querySelector('#events-admin-dialog').open`, 'admin dialog');
  await setValue('#events-login-email', email);
  await setValue('#events-login-password', password);
  await click('#events-login-form button[type="submit"]');
  await waitFor(`!document.querySelector('#events-admin-app').hidden && document.querySelectorAll('[data-event-form]').length>=2`, 'event admin login');

  const recurringSelector = `[data-event-form^="recurring-"]`;
  await setValue(`${recurringSelector} select[name="status"]`, 'cancelled');
  await setValue(`${recurringSelector} input[name="startTime"]`, '18:30');
  await click(`${recurringSelector} button[type="submit"]`);
  await waitFor(`document.querySelector(${JSON.stringify(recurringSelector)})?.querySelector('[data-reset-override]') && [...document.querySelectorAll('.event-card')].some(e=>e.classList.contains('cancelled'))`, 'recurring cancellation');

  await click(`${recurringSelector} [data-reset-override]`);
  await waitFor(`!document.querySelector(${JSON.stringify(recurringSelector)})?.querySelector('[data-reset-override]') && ![...document.querySelectorAll('.event-card')].some(e=>e.classList.contains('cancelled'))`, 'recurring reset');

  const schedule = await (await fetch(`${origin}/gog/api/events`)).json();
  const tomorrow = new Date(`${schedule.generatedFor}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const eventDate = tomorrow.toISOString().slice(0, 10);
  await setValue('#add-event-form input[name="title"]', 'Browser QA one-off event');
  await setValue('#add-event-form input[name="eventDate"]', eventDate);
  await setValue('#add-event-form input[name="startTime"]', '14:00');
  await setValue('#add-event-form textarea[name="description"]', 'Created through the homepage admin UI.');
  await click('#add-event-form button[type="submit"]');
  await waitFor(`[...document.querySelectorAll('#special-admin-list .admin-event-card')].some(e=>e.textContent.includes('Browser QA one-off event')) && [...document.querySelectorAll('.event-card')].some(e=>e.textContent.includes('Browser QA one-off event'))`, 'one-off event creation');

  await evaluate(`(() => { const card=[...document.querySelectorAll('#special-admin-list .admin-event-card')].find(e=>e.textContent.includes('Browser QA one-off event')); card.querySelector('[data-delete-event]').click(); return true; })()`);
  await waitFor(`![...document.querySelectorAll('#special-admin-list .admin-event-card')].some(e=>e.textContent.includes('Browser QA one-off event')) && ![...document.querySelectorAll('.event-card')].some(e=>e.textContent.includes('Browser QA one-off event'))`, 'one-off event deletion');

  assert.deepEqual(failedResponses, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ chrome: version.Browser, checks: [
    'administrator login through homepage', 'recurring occurrence cancellation and reset', 'one-off event creation and deletion'
  ], failedResponses, consoleErrors: errors }, null, 2));
} finally {
  try { socket.close(); } catch {}
  chrome.kill();
  await Promise.race([new Promise((resolvePromise) => chrome.once('exit', resolvePromise)), sleep(1500)]);
  const tempRoot = resolve(tmpdir()).replace(/[\\/]+$/, '');
  if (profile.startsWith(`${tempRoot}${sep}`)) await rm(profile, { recursive: true, force: true }).catch(() => {});
}
