#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

// Run against an isolated Office instance connected to a disposable JUSH database.
const origin=process.argv[2]||'http://127.0.0.1:8791';
const token=process.env.JUSH_TEST_OFFICE_TOKEN;
if(!token || !['127.0.0.1','localhost'].includes(new URL(origin).hostname)) throw Error('Use a local test Office and its JUSH_TEST_OFFICE_TOKEN.');
const chromePath=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
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
const target = await pollJson(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${origin}/?workspace=jush&view=events#token=${encodeURIComponent(token)}`)}`, { method: 'PUT' });
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
  const newEvent='form[data-j-form="event"]:not(:has(input[name="path"]))';
  await waitFor(`document.querySelector(${JSON.stringify(newEvent)})`, 'Office event controls');
  const title='Office event smoke '+Date.now();
  const date=new Date(Date.now()+86400000).toISOString().slice(0,10);
  await setValue(newEvent+' [name="title"]',title);
  await setValue(newEvent+' [name="eventDate"]',date);
  await setValue(newEvent+' [name="startTime"]','18:00');
  await click(newEvent+' button');
  await waitFor(`Array.from(document.querySelectorAll('.jush-content summary')).some(s=>s.textContent.includes(${JSON.stringify(title)}))`,'new event');
  const chosen=`Array.from(document.querySelectorAll('.jush-content details')).find(d=>d.querySelector('summary')?.textContent.includes(${JSON.stringify(title)}))`;
  await evaluate(`${chosen}.querySelector('[data-j-action="event-delete"]').click()`);
  await waitFor(`!(${chosen})`,'event removal');
  const recurring='form[data-j-form="event"]:has(input[value*="/recurring/"])';
  await setValue(recurring+' [name="status"]','cancelled');
  await click(recurring+' button');
  await waitFor(`document.querySelector('[data-j-action="event-reset"]')`,'recurring exception');
  await click('[data-j-action="event-reset"]');
  await waitFor(`!document.querySelector('[data-j-action="event-reset"]')`,'restored recurring schedule');
  assert.deepEqual(errors,[]);assert.deepEqual(failedResponses,[]);
  console.log('Office event creation, deletion, recurring cancellation and restoration passed.');
} finally {
  try { socket.close(); } catch {}
  chrome.kill();
  await Promise.race([new Promise((resolvePromise) => chrome.once('exit', resolvePromise)), sleep(1500)]);
  const tempRoot = resolve(tmpdir()).replace(/[\\/]+$/, '');
  if (profile.startsWith(`${tempRoot}${sep}`)) await rm(profile, { recursive: true, force: true }).catch(() => {});
}
