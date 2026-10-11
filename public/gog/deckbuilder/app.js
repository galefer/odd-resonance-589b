import {
  ZONES, DeckHistory, addIssue, defaultZoneFor, groupedCards, instanceFromCard,
  newDeck, portableDeck, unresolvedInstance
} from './state.js';
import { DeckDatabase, StorageConflictError, makeBackup, parseBackup, sanitiseDeck } from './persistence.js';
import { MAX_FILE_BYTES, encodeYdk, encodeYdke, parseYdk, parseYdke } from './deck-codecs.js';
import { atLeast } from './probability.js';

const API = '/gog/api';
const CARD_BACK = '/gog/deckbuilder/card-back.svg';
const $ = (id) => document.getElementById(id);
const zoneLabel = (zone) => zone === 'main' ? 'Main Deck' : zone === 'extra' ? 'Extra Deck' : 'Side Deck';
const statusLabel = (status) => ({ unlimited: 'Unlimited', semi_limited: 'Semi-Limited', limited: 'Limited', forbidden: 'Forbidden', unverified: 'Unverified' }[status] || 'Unverified');
const statusBadge = (status) => ({ forbidden: '0', limited: '1', semi_limited: '2' }[status] || '');
const clone = (value) => structuredClone(value);
const delay = (fn, milliseconds) => {
  let timer = 0;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), milliseconds); };
};

let database;
let history;
let currentDeckId = null;
let selectedCard = null;
let selectedInstanceId = null;
let grouped = false;
let saveTimer = 0;
let validationTimer = 0;
let validationSequence = 0;
let validationResult = null;
let validationIssues = new Map();
let catalogueCards = [];
let cataloguePage = 0;
let catalogueHasMore = false;
let catalogueMeta = null;
let catalogueRequest = null;
let activeCategory = '';
let pendingImport = null;
let pendingBackups = null;
let importTrigger = null;
let hand = [];
let handRemaining = [];
let toastTimer = 0;
let activeDrag = null;
let deckRenderPending = false;

function setSaveState(state, message) {
  const line = $('saved-label').parentElement;
  line.classList.remove('saving', 'saved', 'error');
  if (state) line.classList.add(state);
  $('saved-label').textContent = message;
}

function showToast(message, kind = '') {
  clearTimeout(toastTimer);
  const element = $('toast');
  element.textContent = message;
  element.className = `toast ${kind}`.trim();
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, 4200);
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  let data = null;
  try { data = await response.json(); } catch { /* A non-JSON edge response is handled below. */ }
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
  return data;
}

function cardImage(card, size = 'thumb') {
  const id = Number(card?.artworkId || card?.canonicalId);
  return Number.isInteger(id) && id > 0 ? `${API}/cards/${id}/image?size=${size}&v=2` : CARD_BACK;
}

function image(element, card, size = 'thumb') {
  const source = cardImage(card, size);
  if (element.dataset.imageSource === source) return;
  element.dataset.imageSource = source;
  element.src = source;
  element.addEventListener('error', () => {
    if (!element.src.endsWith(CARD_BACK)) { element.dataset.imageSource = CARD_BACK; element.src = CARD_BACK; }
  }, { once: true });
}

function findInstance(instanceId) {
  if (!history) return null;
  for (const zone of ZONES) {
    const index = history.deck[zone].findIndex((item) => item.instanceId === instanceId);
    if (index >= 0) return { zone, index, item: history.deck[zone][index] };
  }
  return null;
}

function selectedSource() {
  const found = selectedInstanceId && findInstance(selectedInstanceId);
  return found?.item || selectedCard;
}

function issueKey(zone, index) { return `${zone}:${index}`; }

function localIssueFor(card, zone) {
  return addIssue(history.deck, card, zone);
}

function dispatch(action, { select = null } = {}) {
  if (!history.dispatch(action)) return false;
  if (select) {
    selectedInstanceId = select;
    selectedCard = null;
  }
  resetHand();
  render();
  scheduleSave();
  scheduleValidation();
  return true;
}

function addCard(card, zone = defaultZoneFor(card), index = null) {
  const reason = localIssueFor(card, zone);
  if (reason) { showToast(reason, 'warning'); return; }
  const instance = instanceFromCard(card);
  dispatch({ type: 'ADD_INSTANCE', zone, instance, ...(Number.isInteger(index) ? { index } : {}) }, { select: instance.instanceId });
}

function moveInstance(instanceId, zone, index = null) {
  const found = findInstance(instanceId);
  if (!found || !ZONES.includes(zone)) return;
  if (found.zone === zone && index == null) return;
  if (found.zone !== zone) {
    if (history.deck[zone].length >= (zone === 'main' ? 60 : 15)) {
      showToast(`${zoneLabel(zone)} is full.`, 'warning'); return;
    }
    if (zone !== 'side' && found.item.placement !== zone) {
      showToast(`${found.item.name} belongs in the ${found.item.placement === 'extra' ? 'Extra' : 'Main'} Deck.`, 'warning'); return;
    }
  }
  dispatch({ type: 'MOVE_INSTANCE', instanceId, zone, ...(Number.isInteger(index) ? { index } : {}) });
}

function removeInstance(instanceId) {
  if (!findInstance(instanceId)) return;
  if (selectedInstanceId === instanceId) selectedInstanceId = null;
  dispatch({ type: 'REMOVE_INSTANCE', instanceId });
}

function removeSelected() { removeInstance(selectedInstanceId); }

function render() {
  if (!history) return;
  $('deck-name').textContent = history.deck.name;
  $('undo').disabled = !history.past.length;
  $('redo').disabled = !history.future.length;
  renderInspector();
  renderDeck();
  renderOverview();
  renderGroupsTarget();
}

function renderInspector() {
  const found = selectedInstanceId && findInstance(selectedInstanceId);
  if (selectedInstanceId && !found) selectedInstanceId = null;
  const card = found?.item || selectedCard;
  const selected = !!found;
  $('selection-label').textContent = card ? (selected ? 'DECK COPY SELECTED' : 'CATALOGUE CARD') : 'NOTHING SELECTED';
  image($('large-card'), card, 'full');
  $('large-card').alt = card ? `${card.name} card artwork` : 'No card selected';
  $('zoom').disabled = !card || !card.canonicalId;
  $('card-name').textContent = card?.name || 'Select a card';
  const details = [];
  if (card?.cardType) details.push(card.cardType);
  if (card?.attribute) details.push(card.attribute);
  if (card?.race) details.push(card.race);
  $('card-meta').textContent = details.join(' · ') || 'Search the eligible catalogue or select a card in your deck.';
  const status = card?.status || 'unverified';
  $('card-status').className = `restriction ${status}`;
  $('card-status').textContent = statusLabel(status);
  const copies = card ? history.deck.main.concat(history.deck.extra, history.deck.side)
    .filter((item) => item.copyLimitKey === card.copyLimitKey).length : 0;
  $('usage').textContent = card ? `${copies} / ${Number(card.copies ?? card.allowedCopies ?? 0)} copies used` : '';
  $('effect').textContent = card?.description || 'Verified effect text and house-format status will appear here.';
  const stats = [];
  if (card?.level != null) stats.push(['Level / Rank', card.level]);
  if (card?.linkRating != null) stats.push(['Link', card.linkRating]);
  if (card?.pendulumScale != null) stats.push(['Scale', card.pendulumScale]);
  if (card?.atk != null) stats.push(['ATK', card.atk]);
  if (card?.def != null) stats.push(['DEF', card.def]);
  $('card-stats').replaceChildren(...stats.map(([term, value]) => {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = term;
    const dd = document.createElement('dd'); dd.textContent = value;
    wrap.append(dt, dd); return wrap;
  }));
  const automaticZone = card ? defaultZoneFor(card) : 'main';
  const reason = card ? localIssueFor(card, automaticZone) : 'Select an eligible card.';
  $('add-reason').hidden = !card || !reason;
  $('add-reason').textContent = reason || '';
  $('add-auto').disabled = !card || !!reason;
  $('add-auto').textContent = card?.placement === 'extra' ? '＋ Extra Deck' : '＋ Main Deck';
  const sideReason = card ? localIssueFor(card, 'side') : 'Select an eligible card.';
  $('add-side').disabled = !card || !!sideReason;
  $('selected-instance-actions').hidden = !selected;
  $('copy-selected').disabled = !card || !!reason;
  if (selected) {
    const target = found.zone === 'side' ? found.item.placement : 'side';
    $('move-selected').disabled = !ZONES.includes(target);
    $('move-selected').textContent = target === 'side' ? 'Move to Side' : `Move to ${target === 'extra' ? 'Extra' : 'Main'}`;
    $('move-left').disabled = found.index === 0;
    $('move-right').disabled = found.index === history.deck[found.zone].length - 1;
  }
}

function renderDeck() {
  // Validation can finish while a card is being dragged. Keep the source and
  // insertion marker in the DOM until the drag completes or is cancelled.
  if (activeDrag) { deckRenderPending = true; return; }
  deckRenderPending = false;
  const container = $('deck-zones');
  container.replaceChildren(...ZONES.map((zone) => renderZone(zone)));
  $('mobile-count').textContent = `Main ${history.deck.main.length} · Extra ${history.deck.extra.length} · Side ${history.deck.side.length}`;
}

function renderZone(zone) {
  const section = document.createElement('section'); section.className = 'zone'; section.dataset.zone = zone;
  const header = document.createElement('header'); header.className = 'zone-header';
  const heading = document.createElement('h2'); heading.textContent = zoneLabel(zone);
  const count = document.createElement('span'); count.className = 'zone-counter';
  count.innerHTML = `${history.deck[zone].length} <span class="max">/ ${zone === 'main' ? '40–60' : '15'}</span>`;
  const info = document.createElement('span'); info.className = 'zone-info'; info.textContent = zone === 'main' ? 'Minimum 40 cards' : `Up to 15 cards`;
  const tools = document.createElement('span'); tools.className = 'zone-tools';
  const sort = document.createElement('button'); sort.type = 'button'; sort.textContent = 'Sort'; sort.addEventListener('click', () => dispatch({ type: 'SORT_ZONE', zone }));
  const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear'; clear.disabled = history.deck[zone].length === 0;
  clear.addEventListener('click', () => { if (confirm(`Remove every card from ${zoneLabel(zone)}?`)) dispatch({ type: 'CLEAR_ZONE', zone }); });
  tools.append(sort, clear); header.append(heading, count, info, tools);
  const grid = document.createElement('div'); grid.className = 'deck-grid'; grid.dataset.zone = zone;
  section.addEventListener('dragover', dragOverZone);
  section.addEventListener('dragleave', (event) => {
    if (!section.contains(event.relatedTarget)) clearDropPreview(grid);
  });
  section.addEventListener('drop', dropOnZone);
  const displays = grouped ? groupedCards(history.deck[zone]) : history.deck[zone].map((instance) => ({ instance, count: 1, instanceIds: [instance.instanceId] }));
  if (!displays.length) {
    const empty = document.createElement('p'); empty.className = 'empty-zone';
    empty.innerHTML = `<strong>${zoneLabel(zone)} is empty</strong><span>Add from the library or drop a card here.</span>`;
    grid.append(empty);
  } else displays.forEach((group) => grid.append(renderDeckCard(group, zone)));
  const marker = document.createElement('span'); marker.className = 'drop-insertion-line'; marker.hidden = true; marker.setAttribute('aria-hidden', 'true');
  grid.append(marker);
  section.append(header, grid); return section;
}

function renderDeckCard(group, zone) {
  const card = group.instance;
  const button = document.createElement('button');
  button.type = 'button'; button.className = `card-tile${selectedInstanceId && group.instanceIds.includes(selectedInstanceId) ? ' selected' : ''}`;
  button.draggable = true; button.dataset.instanceId = group.instanceIds[0];
  button.setAttribute('aria-label', `${card.name}, ${statusLabel(card.status)}, in ${zoneLabel(zone)}${group.count > 1 ? `, ${group.count} copies` : ''}`);
  const index = history.deck[zone].findIndex((item) => item.instanceId === group.instanceIds[0]);
  if (validationIssues.has(issueKey(zone, index))) button.setAttribute('aria-invalid', 'true');
  const art = document.createElement('img'); art.alt = ''; art.draggable = false; art.width = 421; art.height = 614; image(art, card);
  button.append(art);
  const badgeText = statusBadge(card.status);
  if (badgeText) {
    const badge = document.createElement('span'); badge.className = `limit-badge ${card.status}`; badge.textContent = badgeText;
    badge.title = statusLabel(card.status); button.append(badge);
  }
  if (group.count > 1) { const quantity = document.createElement('span'); quantity.className = 'quantity'; quantity.textContent = `×${group.count}`; button.append(quantity); }
  button.addEventListener('click', () => { selectedInstanceId = group.instanceIds[0]; selectedCard = null; render(); });
  button.title = `${card.name} — drag to move; right-click to remove one copy`;
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    removeInstance(group.instanceIds[0]);
  });
  button.addEventListener('dragstart', (event) => {
    startCardDrag(event, { instanceId: group.instanceIds[0], instanceIds: group.instanceIds });
  });
  button.addEventListener('dragend', endCardDrag);
  return button;
}

function startCardDrag(event, source) {
  activeDrag = source;
  event.dataTransfer.effectAllowed = source.card ? 'copy' : 'move';
  event.dataTransfer.setData('text/plain', source.card ? `library:${source.card.canonicalId}` : `instance:${source.instanceId}`);
  event.currentTarget.classList.add('dragging');
}

function endCardDrag() {
  activeDrag = null;
  document.querySelectorAll('.dragging').forEach((element) => element.classList.remove('dragging'));
  document.querySelectorAll('.deck-grid').forEach(clearDropPreview);
  if (deckRenderPending) renderDeck();
}

function clearDropPreview(grid) {
  grid.classList.remove('drag-over');
  grid.querySelector('.drop-insertion-line').hidden = true;
  grid.querySelectorAll('.drop-merge').forEach((tile) => tile.classList.remove('drop-merge'));
}

function dropAllowed(zone) {
  if (activeDrag.card) return !localIssueFor(activeDrag.card, zone);
  const found = findInstance(activeDrag.instanceId);
  return !!found && (found.zone === zone ||
    (history.deck[zone].length < (zone === 'main' ? 60 : 15) && (zone === 'side' || found.item.placement === zone)));
}

function dropPosition(grid, x, y) {
  const tiles = [...grid.querySelectorAll('.card-tile')].map((element) => ({ element, rect: element.getBoundingClientRect() }));
  const bounds = grid.getBoundingClientRect();
  if (!tiles.length) {
    const style = getComputedStyle(grid);
    const left = parseFloat(style.paddingLeft), top = parseFloat(style.paddingTop);
    return { index: 0, left: left - 4, top, height: Math.max(32, grid.clientHeight - top - parseFloat(style.paddingBottom)) };
  }
  // Pick the closest visual row, then the gap before/after the card midpoint.
  // Empty space after a short row stays attached to that row's final card.
  const rows = [];
  for (const tile of tiles) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].rect.top - tile.rect.top) < 2) row.push(tile);
    else rows.push([tile]);
  }
  const row = rows.reduce((best, candidate) => Math.abs(y - (candidate[0].rect.top + candidate[0].rect.height / 2)) <
    Math.abs(y - (best[0].rect.top + best[0].rect.height / 2)) ? candidate : best);
  const next = row.find((tile) => x < tile.rect.left + tile.rect.width / 2);
  const previous = next ? row[row.indexOf(next) - 1] : row.at(-1);
  const anchor = next || previous;
  const boundary = next || tiles[tiles.indexOf(previous) + 1];
  const index = boundary ? findInstance(boundary.element.dataset.instanceId).index : history.deck[grid.dataset.zone].length;
  const lineX = previous && next ? (previous.rect.right + next.rect.left) / 2 : next ? next.rect.left - 4 : previous.rect.right + 4;
  return { index, left: lineX - bounds.left - grid.clientLeft, top: anchor.rect.top - bounds.top - grid.clientTop, height: anchor.rect.height };
}

function dragOverZone(event) {
  if (!activeDrag) return;
  event.preventDefault();
  const grid = event.currentTarget.querySelector('.deck-grid');
  document.querySelectorAll('.deck-grid').forEach(clearDropPreview);
  if (!dropAllowed(grid.dataset.zone)) { event.dataTransfer.dropEffect = 'none'; return; }
  grid.classList.add('drag-over');
  // Library cards are copied into a deck; existing deck copies are moved.
  // A move-only drop target rejects a copy-only library drag in the browser.
  event.dataTransfer.dropEffect = activeDrag.card ? 'copy' : 'move';
  const from = activeDrag.instanceId && findInstance(activeDrag.instanceId);
  const card = activeDrag.card || from?.item;
  const merging = grouped && card?.canonicalId && from?.zone !== grid.dataset.zone && [...grid.querySelectorAll('.card-tile')]
    .find((tile) => findInstance(tile.dataset.instanceId).item.canonicalId === card?.canonicalId);
  if (merging) { merging.classList.add('drop-merge'); return; }
  const position = dropPosition(grid, event.clientX, event.clientY);
  const marker = grid.querySelector('.drop-insertion-line');
  marker.style.left = `${position.left}px`; marker.style.top = `${position.top}px`; marker.style.height = `${position.height}px`;
  marker.hidden = false;
}

function dropOnZone(event) {
  if (!activeDrag) return;
  event.preventDefault();
  const zone = event.currentTarget.dataset.zone;
  const grid = event.currentTarget.querySelector('.deck-grid');
  const position = dropPosition(grid, event.clientX, event.clientY);
  const source = activeDrag;
  endCardDrag();
  if (source.card) addCard(source.card, zone, position.index);
  else {
    const found = findInstance(source.instanceId);
    if (!found) return;
    // The preview uses gaps in the current layout; the reducer inserts after
    // removal. Subtract moved copies that originally precede that gap.
    const ids = grouped && found.zone === zone ? source.instanceIds : [source.instanceId];
    const removedBefore = found.zone === zone ? history.deck[zone].slice(0, position.index).filter((card) => ids.includes(card.instanceId)).length : 0;
    const index = position.index - removedBefore;
    if (ids.length > 1) dispatch({ type: 'REORDER_GROUP', zone, instanceIds: ids, index });
    else if (found.zone !== zone || index !== found.index) moveInstance(source.instanceId, zone, index);
  }
}

function renderOverview() {
  for (const zone of ZONES) $(`count-${zone}`).textContent = history.deck[zone].length;
  const main = history.deck.main;
  const countType = (type) => main.filter((card) => card.category === type).length;
  const counts = { Monster: countType('Monster'), Spell: countType('Spell'), Trap: countType('Trap') };
  $('monster-count').textContent = counts.Monster; $('spell-count').textContent = counts.Spell; $('trap-count').textContent = counts.Trap;
  const total = Math.max(1, main.length);
  $('monster-bar').style.width = `${counts.Monster / total * 100}%`;
  $('spell-bar').style.width = `${counts.Spell / total * 100}%`;
  $('trap-bar').style.width = `${counts.Trap / total * 100}%`;
  renderProbability();
}

function renderGroupsTarget() {
  const select = $('probability-target');
  const value = select.value;
  select.replaceChildren();
  const selected = document.createElement('option'); selected.value = 'selected'; selected.textContent = 'Selected card'; select.append(selected);
  for (const group of history.deck.groups) {
    const option = document.createElement('option'); option.value = `group:${group.id}`; option.textContent = group.name; select.append(option);
  }
  if ([...select.options].some((option) => option.value === value)) select.value = value;
}

function renderProbability() {
  const N = history.deck.main.length;
  let K = 0; let label = '';
  const target = $('probability-target').value;
  if (target === 'selected') {
    const card = selectedSource();
    if (card?.canonicalId) {
      K = history.deck.main.filter((item) => item.canonicalId === card.canonicalId).length;
      label = card.name;
    }
  } else if (target.startsWith('group:')) {
    const group = history.deck.groups.find((item) => item.id === target.slice(6));
    if (group) {
      K = history.deck.main.filter((item) => group.canonicalIds.includes(item.canonicalId)).length;
      label = group.name;
    }
  }
  const handSize = Number($('hand-size').value), minimum = Number($('minimum-copies').value);
  let value = 0;
  if (label && N >= handSize) value = atLeast(N, K, handSize, minimum);
  $('probability-value').textContent = `${(value * 100).toFixed(1)}%`;
  $('probability-bar').style.width = `${value * 100}%`;
  $('probability-caption').textContent = !label ? 'Choose a card or group.' : N < handSize
    ? `Main Deck has fewer than ${handSize} cards.` : `${minimum}+ of ${K} ${label} ${K === 1 ? 'copy' : 'copies'} in ${handSize} cards.`;
}

function scheduleSave() {
  clearTimeout(saveTimer); setSaveState('saving', 'Saving…');
  saveTimer = setTimeout(saveNow, 280);
}

async function saveNow() {
  clearTimeout(saveTimer); saveTimer = 0;
  if (!history) return false;
  if (!database) { setSaveState('error', 'Not saved — export a backup'); return false; }
  const snapshot = clone(history.deck);
  try {
    await database.save(snapshot);
    setSaveState('saved', 'Saved on this device');
    await renderDeckMenu();
    return true;
  } catch (error) {
    if (error instanceof StorageConflictError) {
      const branch = sanitiseDeck({ ...snapshot, name: `${snapshot.name} (conflict copy)` }, { newIdentity: true });
      await database.save(branch, { force: true });
      await switchDeck(branch, false);
      showToast('Another tab saved a newer revision. Your edits were preserved as a conflict copy.', 'warning');
      return true;
    } else {
      setSaveState('error', 'Could not save — export a backup');
      showToast(error.message || 'Local save failed. Export a backup before leaving.', 'error');
      return false;
    }
  }
}

function scheduleValidation() {
  clearTimeout(validationTimer);
  validationResult = null; validationIssues = new Map(); renderValidation('checking');
  validationTimer = setTimeout(validateCurrentDeck, 420);
}

async function validateCurrentDeck() {
  const sequence = ++validationSequence;
  const snapshot = clone(history.deck);
  try {
    const body = Object.fromEntries(ZONES.map((zone) => [zone, snapshot[zone].map((item) => item.originalImportId || item.canonicalId)]));
    const result = await api('/decks/validate', { method: 'POST', body: JSON.stringify(body) });
    if (sequence !== validationSequence || snapshot.id !== history.deck.id || snapshot.revision !== history.deck.revision) return;
    validationResult = result;
    validationIssues = new Map();
    for (const issue of result.issues || []) if (issue.zone && Number.isInteger(issue.index)) {
      const key = issueKey(issue.zone, issue.index);
      const existing = validationIssues.get(key) || []; existing.push(issue); validationIssues.set(key, existing);
    }
    renderValidation(result.verified ? (result.legal ? 'legal' : 'invalid') : 'unverified');
    renderDeck();
    $('footer-version').textContent = result.version ? `${result.version.label} · published rules` : 'Published list unavailable';
  } catch (error) {
    if (sequence !== validationSequence) return;
    validationResult = { verified: false, legal: false, issues: [{ code: 'service_unavailable', message: error.message }] };
    validationIssues = new Map(); renderValidation('unverified');
  }
}

function renderValidation(state = 'checking') {
  const banner = $('validation-banner'); banner.className = `validation-banner ${state}`;
  if (state === 'checking') {
    $('validation-icon').textContent = '…'; $('validation-title').textContent = 'Checking published house rules'; $('validation-summary').textContent = 'Validating every card and section.';
  } else if (state === 'legal') {
    $('validation-icon').textContent = '✓'; $('validation-title').textContent = 'Legal for the published house format'; $('validation-summary').textContent = `${validationResult.version.label} · checked ${new Date(validationResult.checkedAt).toLocaleString()}`;
  } else if (state === 'invalid') {
    $('validation-icon').textContent = '!'; $('validation-title').textContent = 'Deck needs attention'; $('validation-summary').textContent = `${validationResult.issues.length} ${validationResult.issues.length === 1 ? 'issue' : 'issues'} under ${validationResult.version.label}.`;
  } else {
    $('validation-icon').textContent = '?'; $('validation-title').textContent = 'Legality could not be verified'; $('validation-summary').textContent = validationResult?.issues?.[0]?.message || 'The current published list or catalogue could not be reached.';
  }
}

async function loadCatalogue({ append = false } = {}) {
  catalogueRequest?.abort(); catalogueRequest = new AbortController();
  const request = catalogueRequest;
  if (!append) {
    cataloguePage = 0; catalogueCards = [];
    $('library-grid').replaceChildren(...Array.from({ length: 12 }, () => { const item = document.createElement('span'); item.className = 'skeleton'; return item; }));
  }
  $('library-state').hidden = false; $('library-state').className = 'library-state'; $('library-state').textContent = 'Loading eligible catalogue…';
  const params = new URLSearchParams({ page: String(cataloguePage), limit: '48' });
  const query = $('search').value.trim(); if (query) params.set('q', query);
  if (activeCategory) params.set('category', activeCategory);
  if ($('status-filter').value) params.set('status', $('status-filter').value);
  if ($('subtype-filter').value) params.set('subtype', $('subtype-filter').value);
  if ($('attribute-filter').value) params.set('attribute', $('attribute-filter').value);
  try {
    const data = await api(`/catalogue?${params}`, { signal: request.signal });
    if (request !== catalogueRequest) return;
    catalogueCards = append ? catalogueCards.concat(data.cards) : data.cards;
    catalogueHasMore = data.hasMore; catalogueMeta = data.catalogue;
    $('library-total').textContent = data.catalogue.eligibleCards ? `${data.catalogue.eligibleCards.toLocaleString()} ELIGIBLE` : `${catalogueCards.length} LOADED`;
    $('library-state').hidden = catalogueCards.length > 0;
    $('library-state').textContent = catalogueCards.length ? '' : 'No eligible cards match these filters.';
    $('load-more').hidden = !catalogueHasMore;
    renderLibrary();
  } catch (error) {
    if (error.name === 'AbortError') return;
    $('library-grid').replaceChildren(); $('load-more').hidden = true;
    $('library-state').hidden = false; $('library-state').className = 'library-state error';
    $('library-state').textContent = `Card library unavailable: ${error.message}`;
  }
}

function renderLibrary() {
  $('library-grid').replaceChildren(...catalogueCards.map((card) => {
    const wrap = document.createElement('article'); wrap.className = 'library-card';
    const inspect = document.createElement('button'); inspect.type = 'button'; inspect.draggable = true;
    inspect.setAttribute('aria-label', `Inspect ${card.name}, ${statusLabel(card.status)}`);
    const art = document.createElement('img'); art.alt = ''; art.draggable = false; art.width = 421; art.height = 614; art.loading = 'lazy'; image(art, card);
    inspect.append(art);
    const badgeText = statusBadge(card.status);
    let badge = null;
    if (badgeText) { badge = document.createElement('span'); badge.className = `restriction-dot ${card.status}`; badge.textContent = badgeText; badge.title = statusLabel(card.status); }
    inspect.title = `${card.name} — right-click: ${zoneLabel(defaultZoneFor(card))}; Shift + right-click: Side Deck; click to inspect`;
    // Handle the secondary mouse button directly so Shift works even in
    // browsers that reserve Shift + contextmenu for their native menu.
    inspect.addEventListener('pointerdown', (event) => {
      if (event.button !== 2) return;
      event.preventDefault();
      addCard(card, event.shiftKey ? 'side' : defaultZoneFor(card));
    });
    inspect.addEventListener('contextmenu', (event) => event.preventDefault());
    inspect.addEventListener('pointerenter', () => { if (!selectedInstanceId) { selectedCard = card; renderInspector(); renderProbability(); } });
    inspect.addEventListener('focus', () => { if (!selectedInstanceId) { selectedCard = card; renderInspector(); renderProbability(); } });
    inspect.addEventListener('click', () => { selectedCard = card; selectedInstanceId = null; render(); if (matchMedia('(max-width:767px)').matches) setMobilePanel('card'); });
    inspect.addEventListener('dragstart', (event) => startCardDrag(event, { card }));
    inspect.addEventListener('dragend', endCardDrag);
    wrap.append(inspect); if (badge) wrap.append(badge); return wrap;
  }));
}

async function renderDeckMenu() {
  if (!database) return;
  const decks = await database.list();
  $('deck-menu-list').replaceChildren(...decks.map((deck) => {
    const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem';
    button.dataset.deckId = deck.id;
    if (deck.id === currentDeckId) button.classList.add('current');
    const name = document.createElement('span'); name.textContent = deck.name;
    const count = document.createElement('small'); count.textContent = `${deck.main.length + deck.extra.length + deck.side.length} cards`;
    button.append(name, count); button.addEventListener('click', () => switchDeck(deck)); return button;
  }));
}

async function switchDeck(deck, flush = true) {
  if (flush && history) await saveNow();
  const safe = sanitiseDeck(await database.get(deck.id) || deck);
  currentDeckId = safe.id; await database.setCurrentId(safe.id);
  history = new DeckHistory(safe, 100); bindHistory();
  selectedCard = null; selectedInstanceId = null; validationResult = null; validationIssues = new Map(); resetHand();
  closeMenus(); render(); scheduleValidation(); setSaveState('saved', 'Saved on this device'); await renderDeckMenu();
}

function bindHistory() {
  history.addEventListener('change', () => { /* Edits are rendered and persisted by dispatch(). */ });
}

async function createDeck(name = 'Untitled deck', { flush = true } = {}) {
  if (flush) await saveNow();
  const deck = newDeck(name);
  if (!database) {
    history = new DeckHistory(deck, 100); bindHistory(); selectedCard = null; selectedInstanceId = null; render(); scheduleValidation();
    setSaveState('error', 'Not saved — export a backup'); return;
  }
  await database.save(deck, { force: true }); await switchDeck(deck, false);
}

function toggleMenu(element, trigger) {
  const open = element.hidden;
  closeMenus(); element.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
}

function closeMenus() {
  $('deck-menu').hidden = true; $('export-menu').hidden = true;
  $('deck-menu-button').setAttribute('aria-expanded', 'false'); $('saved-decks-button').setAttribute('aria-expanded', 'false'); $('export-button').setAttribute('aria-expanded', 'false');
}

function openSaveDeck() {
  closeMenus();
  if (!database) { showToast('Local storage is unavailable. Export a backup to keep this deck.', 'error'); return; }
  $('save-deck-name').value = history.deck.name === 'Untitled deck' ? '' : history.deck.name;
  openDialog($('save-deck-dialog'), $('save-deck'));
  $('save-deck-name').focus(); $('save-deck-name').select();
}

function openDialog(dialog, trigger = document.activeElement) {
  dialog.dataset.triggerId = trigger?.id || ''; dialog.showModal();
}

function closeDialog(dialog) {
  dialog.close();
  if (dialog.dataset.triggerId) $(dialog.dataset.triggerId)?.focus();
}

function info(title, content) {
  $('info-title').textContent = title;
  const body = $('info-body'); body.replaceChildren();
  if (typeof content === 'string') { const p = document.createElement('p'); p.textContent = content; body.append(p); }
  else body.append(content);
  openDialog($('info-dialog'));
}

function validationDetails() {
  const wrap = document.createElement('div');
  if (!validationResult) { const p = document.createElement('p'); p.textContent = 'Validation is still running.'; wrap.append(p); }
  else {
    const lead = document.createElement('p'); lead.textContent = validationResult.verified
      ? `Checked against ${validationResult.version?.label || 'the published list'} and pool ${validationResult.poolRevision || 'revision unavailable'}.`
      : 'The page will not claim legality until the published list and complete JUSH catalogue are available.';
    wrap.append(lead);
    if (validationResult.issues?.length) {
      const list = document.createElement('ul');
      validationResult.issues.forEach((issue) => { const item = document.createElement('li'); item.textContent = issue.message; list.append(item); }); wrap.append(list);
    }
  }
  info('House-format validation', wrap);
}

function resetImport() {
  pendingImport = null; pendingBackups = null;
  $('import-preview').hidden = true; $('import-error').hidden = true; $('confirm-import').disabled = true;
  $('paste-input').value = ''; $('file-input').value = ''; $('backup-input').value = '';
  setImportTab('file');
}

function setImportTab(tab) {
  const controls = { file: $('drop-zone'), paste: $('paste-input'), backup: $('backup-zone') };
  for (const [name, control] of Object.entries(controls)) control.hidden = name !== tab;
  $('preview-paste').hidden = tab !== 'paste'; $('import-mode-wrap').hidden = tab === 'backup';
  for (const name of Object.keys(controls)) $(`${name}-tab`).classList.toggle('active', name === tab);
}

async function previewDeckText(text, source, suggestedName = 'Imported deck') {
  pendingBackups = null; $('import-error').hidden = true; $('confirm-import').disabled = true;
  try {
    const parsed = /^\s*ydke:\/\//i.test(text) ? parseYdke(text) : parseYdk(text);
    const ids = ZONES.flatMap((zone) => parsed.deck[zone]);
    const resolved = ids.length ? (await api('/cards/resolve', { method: 'POST', body: JSON.stringify({ ids }) })).results : [];
    let cursor = 0; const deck = newDeck(suggestedName);
    for (const zone of ZONES) deck[zone] = parsed.deck[zone].map(() => {
      const result = resolved[cursor++];
      if (result?.outcome === 'resolved') return instanceFromCard({ ...result.card, artworkId: result.artworkId || result.card.artworkId }, result.inputId);
      return unresolvedInstance(result?.inputId, result?.outcome || 'metadata_unavailable');
    });
    deck.originalImport = { source, importedAt: new Date().toISOString(), warnings: parsed.warnings || [] };
    const validationBody = Object.fromEntries(ZONES.map((zone) => [zone, parsed.deck[zone]]));
    const check = await api('/decks/validate', { method: 'POST', body: JSON.stringify(validationBody) });
    pendingImport = { deck, source, check, parseWarnings: parsed.warnings || [] };
    renderImportPreview();
  } catch (error) {
    pendingImport = null; $('import-preview').hidden = true; $('import-error').hidden = false; $('import-error').textContent = error.message; $('confirm-import').disabled = true;
  }
}

function renderImportPreview() {
  const { deck, source, check, parseWarnings } = pendingImport;
  $('import-preview').hidden = false; $('import-source').textContent = source.toUpperCase();
  $('import-counts').textContent = `Main ${deck.main.length} · Extra ${deck.extra.length} · Side ${deck.side.length}`;
  const issues = [...(check.issues || []).map((item) => item.message), ...parseWarnings.map((item) => item.code.replaceAll('_', ' ').toLowerCase())];
  $('import-issues').className = 'import-issues-list';
  $('import-issues').replaceChildren(...issues.slice(0, 100).map((message) => { const p = document.createElement('p'); p.textContent = message; return p; }));
  if (!issues.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'All entries resolved. Import will still be checked again against the current published list.'; $('import-issues').append(p); }
  $('confirm-import').textContent = 'Import deck'; $('confirm-import').disabled = false;
}

async function fileText(file) {
  if (!file) throw new Error('Choose a deck file first.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Deck input exceeds 128 KiB.');
  return file.text();
}

async function restoreBackupFile(file) {
  $('import-error').hidden = true;
  try {
    if (!file || file.size > 5 * 1024 * 1024) throw new Error('Choose a JSON backup no larger than 5 MiB.');
    pendingBackups = parseBackup(await file.text()); pendingImport = null;
    $('import-preview').hidden = false; $('import-source').textContent = 'JSON BACKUP';
    $('import-counts').textContent = `${pendingBackups.length} ${pendingBackups.length === 1 ? 'deck' : 'decks'} will be added as local copies.`;
    $('import-issues').replaceChildren(); $('confirm-import').textContent = 'Restore backup'; $('confirm-import').disabled = false;
  } catch (error) { $('import-error').hidden = false; $('import-error').textContent = error.message; $('confirm-import').disabled = true; }
}

async function confirmImport() {
  if (pendingBackups) {
    if (!database) { $('import-error').hidden = false; $('import-error').textContent = 'Local storage is unavailable, so a multi-deck backup cannot be restored in this session.'; return; }
    for (const deck of pendingBackups) await database.save(deck, { force: true });
    const first = pendingBackups[0]; closeDialog($('import-dialog'));
    if (first) await switchDeck(first);
    showToast(`${pendingBackups.length} ${pendingBackups.length === 1 ? 'deck' : 'decks'} restored as local copies.`); return;
  }
  if (!pendingImport) return;
  const mode = document.querySelector('input[name="import-mode"]:checked').value;
  let deck = pendingImport.deck;
  if (mode === 'replace') {
    if (!confirm(`Replace “${history.deck.name}”? You can undo this until the page closes.`)) return;
    deck.id = history.deck.id; deck.name = history.deck.name; deck.createdAt = history.deck.createdAt;
    deck.revision = Number(history.deck.revision || 0) + 1;
    dispatch({ type: 'IMPORT_DECK', deck });
  } else {
    if (database) { await saveNow(); await database.save(deck, { force: true }); await switchDeck(deck, false); }
    else { history.replace(deck, true); selectedCard = null; selectedInstanceId = null; render(); scheduleValidation(); }
  }
  closeDialog($('import-dialog')); showToast('Deck imported. Invalid entries were retained for repair.');
}

function exportWarning() {
  if (validationResult?.legal && validationResult?.verified) return true;
  const issue = validationResult?.issues?.[0]?.message || 'Legality has not been verified.';
  return confirm(`Export this draft anyway?\n\n${issue}\n\nThe complete deck shown will be exported; the file does not carry house-format rules.`);
}

function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(name) { return (name || 'jush-deck').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'jush-deck'; }

async function exportPortable(kind) {
  closeMenus();
  if (!exportWarning()) return;
  try {
    const snapshot = portableDeck(clone(history.deck));
    if (kind === 'ydk') { download(encodeYdk(snapshot), `${safeFilename(history.deck.name)}.ydk`, 'text/plain;charset=utf-8'); showToast('YDK downloaded.'); }
    if (kind === 'ydke') { await copyText(encodeYdke(snapshot), 'YDKE code'); }
  } catch (error) { showToast(error.message, 'error'); }
}

async function copyText(value, label) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.');
    await navigator.clipboard.writeText(value); showToast(`${label} copied.`);
  } catch {
    const wrap = document.createElement('div');
    const p = document.createElement('p'); p.textContent = `Copy this ${label.toLowerCase()} manually:`;
    const area = document.createElement('textarea'); area.value = value; area.readOnly = true; wrap.append(p, area);
    info(`Copy ${label}`, wrap); setTimeout(() => area.select(), 0);
  }
}

function readableList() {
  const lines = [`${history.deck.name}`, 'JUSH House Format', ''];
  for (const zone of ZONES) {
    lines.push(zoneLabel(zone));
    for (const group of groupedCards(history.deck[zone])) lines.push(`${group.count}x ${group.instance.name}${group.instance.resolution !== 'resolved' ? ` [${group.instance.originalImportId}: unverified]` : ''}`);
    lines.push('');
  }
  lines.push('Restrictions checked on the website; this text does not install the house list.');
  return lines.join('\n');
}

async function exportBackup() {
  closeMenus(); await saveNow();
  try { download(JSON.stringify(makeBackup(database ? await database.list() : [history.deck]), null, 2), `jush-decks-${new Date().toISOString().slice(0, 10)}.json`, 'application/json'); showToast('Complete local backup downloaded.'); }
  catch (error) { showToast(error.message, 'error'); }
}

function renderGroupsDialog() {
  const unique = new Map();
  history.deck.main.forEach((card) => { if (card.canonicalId) unique.set(card.canonicalId, card.name); });
  $('groups-list').replaceChildren(...history.deck.groups.map((group) => {
    const row = document.createElement('section'); row.className = 'group-row';
    const header = document.createElement('header'); const title = document.createElement('strong'); title.textContent = group.name;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
    remove.addEventListener('click', () => { dispatch({ type: 'SET_GROUPS', groups: history.deck.groups.filter((item) => item.id !== group.id) }); renderGroupsDialog(); });
    header.append(title, remove);
    const note = document.createElement('p'); note.textContent = 'Choose card identities. Every physical Main Deck copy counts.';
    const members = document.createElement('div'); members.className = 'group-members';
    for (const [id, name] of unique) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = name; button.classList.toggle('active', group.canonicalIds.includes(id));
      button.setAttribute('aria-pressed', String(group.canonicalIds.includes(id)));
      button.addEventListener('click', () => {
        const ids = group.canonicalIds.includes(id) ? group.canonicalIds.filter((value) => value !== id) : [...group.canonicalIds, id];
        const groups = history.deck.groups.map((item) => item.id === group.id ? { ...item, canonicalIds: ids } : item);
        dispatch({ type: 'SET_GROUPS', groups }); renderGroupsDialog();
      }); members.append(button);
    }
    if (!unique.size) { const empty = document.createElement('span'); empty.className = 'muted'; empty.textContent = 'Add cards to the Main Deck first.'; members.append(empty); }
    row.append(header, note, members); return row;
  }));
}

function randomIndex(max) {
  if (max <= 1) return 0;
  const ceiling = Math.floor(0x100000000 / max) * max;
  const values = new Uint32Array(1); let value;
  do { crypto.getRandomValues(values); value = values[0]; } while (value >= ceiling);
  return value % max;
}

function drawOpeningHand() {
  handRemaining = [...history.deck.main];
  for (let index = handRemaining.length - 1; index > 0; index--) {
    const target = randomIndex(index + 1); [handRemaining[index], handRemaining[target]] = [handRemaining[target], handRemaining[index]];
  }
  hand = handRemaining.splice(0, 5); renderHand();
}

function drawOne() { if (handRemaining.length) hand.push(handRemaining.shift()); renderHand(); }
function resetHand() { hand = []; handRemaining = []; if ($('sample-hand')) renderHand(); }
function renderHand() {
  $('sample-hand').replaceChildren(...hand.map((card) => {
    const figure = document.createElement('figure'); const art = document.createElement('img'); art.alt = `${card.name} card artwork`; image(art, card);
    const caption = document.createElement('figcaption'); caption.textContent = card.name; figure.append(art, caption); return figure;
  }));
  $('draw-one').disabled = !hand.length || !handRemaining.length; $('reset-hand').disabled = !hand.length;
  $('hand-caption').textContent = hand.length ? `${hand.length} cards seen · ${handRemaining.length} remain in this shuffled sample.` : 'Ready for a new sample hand.';
}

function setMobilePanel(panel) {
  document.body.dataset.panel = panel;
  document.querySelectorAll('.mobile-nav button').forEach((button) => button.classList.toggle('active', button.dataset.panel === panel));
  if (panel === 'card') renderInspector();
}

function wireEvents() {
  $('deck-menu-button').addEventListener('click', () => toggleMenu($('deck-menu'), $('deck-menu-button')));
  $('saved-decks-button').addEventListener('click', () => toggleMenu($('deck-menu'), $('saved-decks-button')));
  $('save-deck').addEventListener('click', openSaveDeck);
  $('cancel-save-deck').addEventListener('click', () => closeDialog($('save-deck-dialog')));
  $('save-deck-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('save-deck-name').value.trim();
    if (!name) { $('save-deck-name').focus(); return; }
    const button = $('confirm-save-deck'); button.disabled = true;
    try {
      if (name !== history.deck.name) dispatch({ type: 'RENAME_DECK', name });
      setSaveState('saving', 'Saving…');
      if (await saveNow()) {
        closeDialog($('save-deck-dialog'));
        showToast(`“${history.deck.name}” saved in this browser.`);
      }
    } finally { button.disabled = false; }
  });
  $('export-button').addEventListener('click', () => toggleMenu($('export-menu'), $('export-button')));
  document.addEventListener('click', (event) => {
    if (!$('deck-menu').contains(event.target) && !$('deck-menu-button').contains(event.target) && !$('saved-decks-button').contains(event.target) && !$('export-menu').contains(event.target) && !$('export-button').contains(event.target)) closeMenus();
  });
  $('new-deck').addEventListener('click', () => createDeck());
  $('duplicate-deck').addEventListener('click', async () => {
    const copy = sanitiseDeck({ ...history.deck, name: `${history.deck.name} (copy)`, revision: 0 }, { newIdentity: true });
    if (!database) { history = new DeckHistory(copy, 100); bindHistory(); render(); setSaveState('error', 'Not saved — export a backup'); }
    else { await database.save(copy, { force: true }); await switchDeck(copy); }
    showToast('Deck duplicated.');
  });
  $('rename-deck').addEventListener('click', () => { const name = prompt('Deck name', history.deck.name); if (name?.trim()) dispatch({ type: 'RENAME_DECK', name }); closeMenus(); });
  $('delete-deck').addEventListener('click', async () => {
    if (!database) { showToast('Local storage is unavailable. Start a new in-memory deck instead.', 'warning'); return; }
    if (!confirm(`Delete “${history.deck.name}” from this device? Download a JSON backup first if you need it elsewhere.`)) return;
    clearTimeout(saveTimer); saveTimer = 0;
    const id = history.deck.id; await database.delete(id); const decks = await database.list();
    if (decks.length) await switchDeck(decks[0], false); else await createDeck('Untitled deck', { flush: false }); showToast('Local deck deleted.');
  });
  $('undo').addEventListener('click', () => { if (history.undo()) { resetHand(); render(); scheduleSave(); scheduleValidation(); } });
  $('redo').addEventListener('click', () => { if (history.redo()) { resetHand(); render(); scheduleSave(); scheduleValidation(); } });
  $('copies-view').addEventListener('click', () => { grouped = false; $('copies-view').classList.add('active'); $('grouped-view').classList.remove('active'); renderDeck(); });
  $('grouped-view').addEventListener('click', () => { grouped = true; $('grouped-view').classList.add('active'); $('copies-view').classList.remove('active'); renderDeck(); });
  $('add-auto').addEventListener('click', () => { const card = selectedSource(); if (card) addCard(card); });
  $('add-side').addEventListener('click', () => { const card = selectedSource(); if (card) addCard(card, 'side'); });
  $('remove-selected').addEventListener('click', removeSelected);
  $('copy-selected').addEventListener('click', () => { const card = selectedSource(); if (card) addCard(card); });
  $('move-selected').addEventListener('click', () => { const found = findInstance(selectedInstanceId); if (found) moveInstance(found.item.instanceId, found.zone === 'side' ? found.item.placement : 'side'); });
  $('move-left').addEventListener('click', () => { const found = findInstance(selectedInstanceId); if (found) dispatch({ type: 'REORDER_INSTANCE', instanceId: found.item.instanceId, index: found.index - 1 }); });
  $('move-right').addEventListener('click', () => { const found = findInstance(selectedInstanceId); if (found) dispatch({ type: 'REORDER_INSTANCE', instanceId: found.item.instanceId, index: found.index + 1 }); });
  $('zoom').addEventListener('click', () => { const card = selectedSource(); if (!card) return; image($('art-dialog-image'), card, 'full'); $('art-dialog-image').alt = `${card.name} card artwork`; openDialog($('art-dialog'), $('zoom')); });
  const catalogueDebounce = delay(() => loadCatalogue(), 220);
  $('search').addEventListener('input', catalogueDebounce);
  document.querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => {
    activeCategory = button.dataset.category; document.querySelectorAll('[data-category]').forEach((item) => item.classList.toggle('active', item === button)); loadCatalogue();
  }));
  $('filters').addEventListener('click', () => { const hidden = !$('extra-filters').hidden; $('extra-filters').hidden = hidden; $('filters').setAttribute('aria-expanded', String(!hidden)); });
  for (const id of ['status-filter', 'subtype-filter', 'attribute-filter']) $(id).addEventListener('change', () => loadCatalogue());
  $('clear-library-filters').addEventListener('click', () => { $('status-filter').value = ''; $('subtype-filter').value = ''; $('attribute-filter').value = ''; loadCatalogue(); });
  $('load-more').addEventListener('click', () => { cataloguePage += 1; loadCatalogue({ append: true }); });
  $('validation-info').addEventListener('click', validationDetails);
  $('probability-target').addEventListener('change', renderProbability); $('hand-size').addEventListener('change', renderProbability); $('minimum-copies').addEventListener('change', renderProbability);
  $('probability-info').addEventListener('click', () => info('Opening probability', 'Exact hypergeometric probability using physical copies in the Main Deck. Extra and Side Deck cards are excluded. Groups may overlap, so each group is calculated on its own.'));
  $('groups-button').addEventListener('click', () => { renderGroupsDialog(); openDialog($('groups-dialog'), $('groups-button')); });
  $('add-group').addEventListener('click', () => {
    const name = $('group-name').value.trim(); if (!name) return;
    const groups = [...history.deck.groups, { id: crypto.randomUUID(), name: name.slice(0, 80), canonicalIds: [] }];
    dispatch({ type: 'SET_GROUPS', groups }); $('group-name').value = ''; renderGroupsDialog();
  });
  $('close-groups').addEventListener('click', () => closeDialog($('groups-dialog')));
  $('overview-tab').addEventListener('click', () => { $('overview').hidden = false; $('hand-tools').hidden = true; $('overview-tab').classList.add('active'); $('hand-tab').classList.remove('active'); });
  $('hand-tab').addEventListener('click', () => { $('overview').hidden = true; $('hand-tools').hidden = false; $('overview-tab').classList.remove('active'); $('hand-tab').classList.add('active'); });
  $('draw-hand').addEventListener('click', drawOpeningHand); $('draw-one').addEventListener('click', drawOne); $('reset-hand').addEventListener('click', resetHand);
  document.querySelectorAll('.mobile-nav button').forEach((button) => button.addEventListener('click', () => setMobilePanel(button.dataset.panel)));
  $('keyboard-help').addEventListener('click', () => {
    const list = document.createElement('ul'); ['/ — focus card search', 'Ctrl/⌘ + Z — undo', 'Ctrl/⌘ + Shift + Z or Ctrl/⌘ + Y — redo', 'Delete — remove the selected deck copy', 'Alt + ← / → — reorder the selected copy', 'Escape — close a menu or dialog'].forEach((text) => { const item = document.createElement('li'); item.textContent = text; list.append(item); }); info('Keyboard controls', list);
  });
  document.addEventListener('keydown', (event) => {
    const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
    if (!editing && event.key === '/') { event.preventDefault(); $('search').focus(); }
    if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); (event.shiftKey ? $('redo') : $('undo')).click(); }
    if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); $('redo').click(); }
    if (!editing && event.key === 'Delete' && selectedInstanceId) { event.preventDefault(); removeSelected(); }
    if (!editing && event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key) && selectedInstanceId) { event.preventDefault(); (event.key === 'ArrowLeft' ? $('move-left') : $('move-right')).click(); }
    if (event.key === 'Escape') closeMenus();
  });
  $('import-button').addEventListener('click', () => { importTrigger = $('import-button'); resetImport(); openDialog($('import-dialog'), importTrigger); });
  $('cancel-import').addEventListener('click', () => closeDialog($('import-dialog')));
  for (const tab of ['file', 'paste', 'backup']) $(`${tab}-tab`).addEventListener('click', () => setImportTab(tab));
  $('choose-file').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async () => { const file = $('file-input').files[0]; try { await previewDeckText(await fileText(file), 'ydk', file.name.replace(/\.[^.]+$/, '').slice(0, 100)); } catch (error) { $('import-error').hidden = false; $('import-error').textContent = error.message; } });
  $('preview-paste').addEventListener('click', () => previewDeckText($('paste-input').value, /^\s*ydke:/i.test($('paste-input').value) ? 'ydke' : 'ydk'));
  $('choose-backup').addEventListener('click', () => $('backup-input').click()); $('backup-input').addEventListener('change', () => restoreBackupFile($('backup-input').files[0]));
  $('drop-zone').addEventListener('dragover', (event) => event.preventDefault()); $('drop-zone').addEventListener('drop', async (event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; try { await previewDeckText(await fileText(file), 'ydk', file.name.replace(/\.[^.]+$/, '').slice(0, 100)); } catch (error) { $('import-error').hidden = false; $('import-error').textContent = error.message; } });
  $('backup-zone').addEventListener('dragover', (event) => event.preventDefault()); $('backup-zone').addEventListener('drop', (event) => { event.preventDefault(); restoreBackupFile(event.dataTransfer.files[0]); });
  $('confirm-import').addEventListener('click', confirmImport);
  $('download-ydk').addEventListener('click', () => exportPortable('ydk')); $('copy-ydke').addEventListener('click', () => exportPortable('ydke'));
  $('copy-list').addEventListener('click', () => { closeMenus(); copyText(readableList(), 'text list'); }); $('backup').addEventListener('click', exportBackup);
  database?.addEventListener('external-change', (event) => {
    if (event.detail?.id === currentDeckId && event.detail.type === 'saved' &&
      (Number(event.detail.revision) > Number(history.deck.revision) ||
        (Number(event.detail.revision) === Number(history.deck.revision) && event.detail.updatedAt !== history.deck.updatedAt))) {
      setSaveState('error', 'Newer revision saved in another tab'); showToast('This deck changed in another tab. Your next edit will be preserved as a conflict copy.', 'warning');
    }
  });
  window.addEventListener('beforeunload', () => { if (saveTimer) saveNow(); });
}

async function start() {
  try {
    database = await new DeckDatabase().open();
    const decks = await database.list(); const currentId = await database.getCurrentId();
    const deck = decks.find((item) => item.id === currentId) || decks[0] || newDeck();
    if (!decks.length) await database.save(deck, { force: true });
    currentDeckId = deck.id; await database.setCurrentId(deck.id);
    history = new DeckHistory(sanitiseDeck(deck), 100); bindHistory(); wireEvents(); render();
    setSaveState('saved', 'Saved on this device'); renderDeckMenu(); scheduleValidation(); loadCatalogue();
  } catch (error) {
    setSaveState('error', 'Could not open local storage');
    history = new DeckHistory(newDeck(), 100); database = null;
    wireEvents(); render(); scheduleValidation(); loadCatalogue();
    showToast(`${error.message} Deck editing remains available in memory; export before leaving.`, 'error');
  }
}

start();
