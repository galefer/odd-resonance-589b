const GOG_BASE = '/gog';
const CARD_POOL_CUTOFF = '2025-08-01';
function cardImageUrl(id) { return `${GOG_BASE}/api/cards/${id || 0}/image`; }

// Perform the costly password derivation in the browser, not Cloudflare's
// 10 ms Free Worker CPU budget. The server verifies an HMAC of this proof.
function newPasswordSalt() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, '0')).join('');
}
async function passwordProof(password, salt) {
  if (!/^[a-f0-9]{32}$/.test(salt)) throw new Error('Invalid login salt.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 310_000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STATUS = {
  forbidden: { label: 'Forbidden', copies: 0 },
  limited: { label: 'Limited', copies: 1 },
  semi_limited: { label: 'Semi-Limited', copies: 2 },
  unlimited: { label: 'Unlimited', copies: 3 }
};

const state = {
  config: null,
  baseline: null,
  entries: [],
  changes: [],
  view: 'current',
  filters: { status: new Set(), category: new Set(), subtype: new Set() },
  sort: 'status-name',
  searchResults: [],
  searchIndex: -1,
  searchAbort: null,
  admin: {
    authenticated: false,
    email: null,
    csrf: null,
    draft: null,
    entries: [],
    changes: [],
    houseChanges: [],
    versions: [],
    section: 'editor',
    searchResults: []
  }
};

function normalise(value = '') {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

function smartTitle(value = '') {
  const lowerWords = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
  return value.split(/(\s+)/).map((token, index) => {
    if (/^\s+$/.test(token)) return token;
    const clean = token.replace(/^["'(<]+|["')>,.:;!?]+$/g, '');
    if (!clean) return token;
    if (/[0-9★☆]/.test(clean) || /^(XYZ|CXYZ|PSY|T\.G\.|M-X-SABER|K9|S0)$/i.test(clean) || /^<[A-Z]>$/.test(clean)) return token;
    const lower = token.toLowerCase();
    if (index > 0 && lowerWords.has(lower.replace(/[^a-z]/g, ''))) return lower;
    return lower.replace(/[a-z]/, (letter) => letter.toUpperCase());
  }).join('');
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function typeInitial(category) {
  return category === 'Spell' ? 'S' : category === 'Trap' ? 'T' : 'M';
}

function statusBadge(status) {
  const item = STATUS[status] || STATUS.unlimited;
  return `<span class="status-badge status-${status}">${item.label}</span>`;
}

function houseChangeBadge(card) {
  return card?.isHouseChange
    ? '<span class="house-change-badge" title="Different from the official JUSH baseline">NEW</span>'
    : '';
}

async function api(path, options = {}) {
  const config = { ...options, headers: { ...(options.headers || {}) } };
  if (config.body && typeof config.body !== 'string') {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(config.body);
  }
  if (path.startsWith('/api/admin/') || path === '/api/auth/logout') {
    if (state.admin.csrf && (config.method || 'GET') !== 'GET') config.headers['X-CSRF-Token'] = state.admin.csrf;
  }
  const routedPath = path.startsWith('/api/') ? `${GOG_BASE}${path}` : path;
  const response = await fetch(routedPath, config);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error || payload || `Request failed (${response.status})`);
  return payload;
}

function toast(message, type = 'success') {
  const region = $('#toast-region');
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<strong aria-hidden="true">${type === 'error' ? '!' : '✓'}</strong><span>${escapeHtml(message)}</span>`;
  region.append(element);
  setTimeout(() => element.remove(), 4200);
}

async function loadPublicData() {
  const [configPayload, listPayload] = await Promise.all([api('/api/config'), api('/api/list')]);
  state.config = configPayload;
  if (configPayload.cardPool?.cutoffDate !== CARD_POOL_CUTOFF) throw new Error('Card pool mismatch. The deployed list is not locked to Justice Hunters.');
  state.baseline = listPayload.baseline || null;
  state.entries = listPayload.entries || [];
  state.changes = listPayload.changes || [];
  state.config.version = listPayload.version || configPayload.version;
  applyConfig();
  renderList();
}

function applyConfig() {
  const settings = state.config?.settings || {};
  const version = state.config?.version;
  $('#brand-short-name').textContent = settings.format_short_name || 'House F&L';
  $('#brand-store-name').textContent = settings.store_name || 'Your Local Store';
  $('#format-name').textContent = settings.format_name || 'Local Store House Format';
  $('#format-description').textContent = settings.format_description || 'A standalone local format. Cards not listed here are Unlimited.';
  $('#accent-label').textContent = settings.accent_label || 'Independent Format';
  $('#footer-format-name').textContent = settings.format_name || 'Local Store House Format';
  $('#version-label').textContent = version?.label || 'Foundation';
  $('#effective-date').textContent = formatDate(version?.effectiveDate);
  $('#effective-date').dateTime = version?.effectiveDate || '';
  $('#footer-version').textContent = `Version ${version?.label || 'Foundation'}`;
  document.title = `${settings.format_name || 'House Format'} · Forbidden & Limited List`;
}

function currentDataset() {
  return state.view === 'changes' ? state.changes : state.entries;
}

function filteredDataset() {
  const data = currentDataset().filter((card) => {
    const statusOk = !state.filters.status.size || state.filters.status.has(card.status);
    const categoryOk = !state.filters.category.size || state.filters.category.has(card.category);
    const subtypeOk = !state.filters.subtype.size || (card.category === 'Monster' && state.filters.subtype.has(card.subtype));
    return statusOk && categoryOk && subtypeOk;
  });
  const order = { forbidden: 0, limited: 1, semi_limited: 2, unlimited: 3 };
  data.sort((a, b) => {
    if (state.sort === 'name') return a.name.localeCompare(b.name);
    if (state.sort === 'type') return `${a.category}-${a.subtype}-${a.name}`.localeCompare(`${b.category}-${b.subtype}-${b.name}`);
    return (order[a.status] - order[b.status]) || a.name.localeCompare(b.name);
  });
  return data;
}

function renderList() {
  const list = $('#card-list');
  const data = filteredDataset();
  const isChanges = state.view === 'changes';
  $('#changes-count').textContent = state.changes.length;
  $('#results-kicker').textContent = isChanges ? 'Compared with the official JUSH baseline' : 'Current restricted cards';
  $('#results-title').textContent = isChanges ? 'House Banlist Tweaks' : 'Forbidden & Limited List';
  $('#results-count').textContent = `${data.length} ${data.length === 1 ? 'card' : 'cards'} shown`;
  $('#results-panel').setAttribute('aria-labelledby', isChanges ? 'changes-tab' : 'current-tab');
  list.setAttribute('aria-busy', 'false');

  if (!data.length) {
    list.innerHTML = '';
    $('#empty-state').hidden = false;
    if (isChanges && state.changes.length === 0 && !activeFilterCount()) {
      $('#empty-state h3').textContent = 'This list matches the official baseline';
      $('#empty-state p').textContent = 'House tweaks will appear here whenever a published status differs from the official JUSH banlist.';
      $('#empty-clear').hidden = true;
    } else {
      $('#empty-state h3').textContent = 'No cards match those filters';
      $('#empty-state p').textContent = 'Clear a filter or choose another combination.';
      $('#empty-clear').hidden = false;
    }
    return;
  }
  $('#empty-state').hidden = true;
  if (state.sort === 'status-name') {
    const counts = data.reduce((map, card) => map.set(card.status, (map.get(card.status) || 0) + 1), new Map());
    let lastStatus = null;
    list.innerHTML = data.map((card) => {
      const heading = card.status !== lastStatus
        ? `<div class="status-section-heading"><strong>${STATUS[card.status]?.label || 'Cards'}</strong><span>${counts.get(card.status)} ${counts.get(card.status) === 1 ? 'card' : 'cards'}</span></div>`
        : '';
      lastStatus = card.status;
      return heading + renderCardRow(card);
    }).join('');
  } else {
    list.innerHTML = data.map(renderCardRow).join('');
  }
}

function renderCardRow(card) {
  const status = STATUS[card.status] || STATUS.unlimited;
  const note = card.note ? `<span class="card-note-preview">${escapeHtml(card.note)}</span>` : '';
  const changeMarkup = card.changeType === 'note_updated' ? '<span class="change-arrow">House-format note updated</span>' : card.previousStatus ? `
    <span class="change-arrow"><span class="old-status">${STATUS[card.previousStatus]?.label || 'Unlimited'}</span><span aria-hidden="true">→</span><span>${status.label}</span></span>` :
    `<small>${status.copies} ${status.copies === 1 ? 'copy' : 'copies'} maximum</small>`;
  return `
    <article class="card-row status-${card.status}${card.isHouseChange ? ' is-house-change' : ''}" data-card-name="${escapeHtml(card.name)}">
      <div class="type-emblem ${card.category.toLowerCase()}" aria-hidden="true">${typeInitial(card.category)}</div>
      <div>
        <h3 class="card-name">${escapeHtml(smartTitle(card.name))}${houseChangeBadge(card)}</h3>
        ${note}
      </div>
      <div class="card-type-cell"><strong>${escapeHtml(card.category)}</strong>${escapeHtml(card.subtype)}</div>
      <div class="status-cell">${statusBadge(card.status)}${changeMarkup}</div>
      <button class="card-open" type="button" data-open-card="${escapeHtml(card.name)}" aria-label="View ${escapeHtml(smartTitle(card.name))}">›</button>
    </article>`;
}

function activeFilterCount() {
  return state.filters.status.size + state.filters.category.size + state.filters.subtype.size;
}

function updateFilterUi() {
  const count = activeFilterCount();
  $('#filter-count').hidden = count === 0;
  $('#filter-count').textContent = count;
  const area = $('#active-filters');
  area.hidden = count === 0;
  area.innerHTML = []
    .concat([...state.filters.status].map((value) => ({ group: 'status', value, label: STATUS[value]?.label || value })))
    .concat([...state.filters.category].map((value) => ({ group: 'category', value, label: value })))
    .concat([...state.filters.subtype].map((value) => ({ group: 'subtype', value, label: value })))
    .map((item) => `<span class="active-filter-chip">${escapeHtml(item.label)}<button type="button" data-remove-filter="${item.group}:${escapeHtml(item.value)}" aria-label="Remove ${escapeHtml(item.label)} filter">×</button></span>`)
    .join('');
  updateUrl();
  renderList();
}

function clearFilters() {
  Object.values(state.filters).forEach((set) => set.clear());
  $$('[data-filter]').forEach((input) => { input.checked = false; });
  updateFilterUi();
}

function updateUrl() {
  const params = new URLSearchParams();
  if (state.view !== 'current') params.set('view', state.view);
  for (const [group, values] of Object.entries(state.filters)) if (values.size) params.set(group, [...values].join(','));
  if (state.sort !== 'status-name') params.set('sort', state.sort);
  const query = params.toString();
  try { history.replaceState(null, '', query ? `${location.pathname}?${query}` : location.pathname); } catch {}
}

function restoreUrlState() {
  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'changes') state.view = 'changes';
  for (const group of ['status', 'category', 'subtype']) {
    const values = params.get(group)?.split(',').filter(Boolean) || [];
    values.forEach((value) => state.filters[group].add(value));
    $$(`[data-filter="${group}"]`).forEach((input) => { input.checked = state.filters[group].has(input.value); });
  }
  const sort = params.get('sort');
  if (['status-name', 'name', 'type'].includes(sort)) state.sort = sort;
  $('#sort-select').value = state.sort;
  switchView(state.view, false);
  updateFilterUi();
}

function switchView(view, update = true) {
  state.view = view;
  $$('.view-tab').forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  if (update) {
    updateUrl();
    renderList();
  }
}

let publicSearchTimer;
async function runPublicSearch(query) {
  const clean = query.trim();
  $('#clear-search').hidden = !clean;
  if (clean.length < 2) {
    hideSuggestions();
    return;
  }
  $('#search-spinner').hidden = false;
  const local = state.entries
    .filter((card) => normalise(card.name).includes(normalise(clean)))
    .slice(0, 12)
    .map((card) => ({ ...card, id: card.cardId || null, cardType: card.cardType, copies: STATUS[card.status].copies }));
  renderSuggestions(local, true);
  try {
    if (state.searchAbort) state.searchAbort.abort();
    state.searchAbort = new AbortController();
    const payload = await api(`/api/cards/search?q=${encodeURIComponent(clean)}`, { signal: state.searchAbort.signal });
    const merged = new Map();
    for (const item of [...local, ...(payload.results || [])]) merged.set(normalise(item.name), item);
    state.searchResults = [...merged.values()].slice(0, 20);
    renderSuggestions(state.searchResults, false);
    $('#api-state').hidden = true;
  } catch (error) {
    if (error.name !== 'AbortError') {
      state.searchResults = local;
      renderSuggestions(local, false);
      $('#api-state').hidden = false;
    }
  } finally {
    $('#search-spinner').hidden = true;
  }
}

function renderSuggestions(results, pending) {
  const container = $('#search-suggestions');
  state.searchResults = results;
  state.searchIndex = -1;
  container.hidden = false;
  if (!results.length) {
    container.innerHTML = `<div class="suggestion-empty">${pending ? 'Searching the card catalogue…' : 'No card from the Justice Hunters-era pool matched your search.'}</div>`;
    return;
  }
  container.innerHTML = results.map((card, index) => `
    <button class="suggestion-row" type="button" role="option" aria-selected="false" data-suggestion-index="${index}">
      <img class="suggestion-thumb" src="${card.id ? cardImageUrl(card.id) : cardImageUrl(0)}" alt="" loading="lazy">
      <span><span class="suggestion-name">${escapeHtml(smartTitle(card.name))}</span><span class="suggestion-meta">${escapeHtml(card.cardType || `${card.category} · ${card.subtype}`)}</span></span>
      <span class="suggestion-status">${statusBadge(card.status || 'unlimited')}${houseChangeBadge(card)}</span>
    </button>`).join('');
}

function hideSuggestions() {
  $('#search-suggestions').hidden = true;
  state.searchIndex = -1;
}

function moveSuggestion(direction) {
  const rows = $$('.suggestion-row', $('#search-suggestions'));
  if (!rows.length) return;
  state.searchIndex = (state.searchIndex + direction + rows.length) % rows.length;
  rows.forEach((row, index) => row.setAttribute('aria-selected', String(index === state.searchIndex)));
  rows[state.searchIndex].scrollIntoView({ block: 'nearest' });
}

async function openCardDetail(cardOrName) {
  const cardName = typeof cardOrName === 'string' ? cardOrName : cardOrName.name;
  const local = state.entries.find((entry) => normalise(entry.name) === normalise(cardName)) ||
    state.changes.find((entry) => normalise(entry.name) === normalise(cardName));
  const supplied = typeof cardOrName === 'object' ? cardOrName : null;
  const dialog = $('#card-modal');
  $('#card-detail').hidden = true;
  $('#card-detail-loading').hidden = false;
  dialog.showModal();
  try {
    let card = supplied;
    if (!card?.description) {
      const payload = await api(`/api/cards/lookup?name=${encodeURIComponent(cardName)}`);
      card = payload.card || supplied || { name: cardName };
    }
    card = { ...card, ...local, status: local?.status || card?.status || 'unlimited' };
    populateCardDetail(card);
  } catch {
    populateCardDetail({ ...(local || {}), name: cardName, status: local?.status || 'unlimited' });
  }
}

function populateCardDetail(card) {
  const status = card.status || 'unlimited';
  const copies = STATUS[status].copies;
  $('#detail-name').textContent = smartTitle(card.name || 'Unknown card');
  $('#detail-status').className = `status-badge status-${status}`;
  $('#detail-status').textContent = STATUS[status].label;
  $('#detail-house-change').hidden = !card.isHouseChange;
  $('#detail-type').textContent = card.cardType || `${card.category || 'Card'} · ${card.subtype || ''}`;
  const stats = [];
  if (card.attribute) stats.push(card.attribute);
  if (card.race) stats.push(card.race);
  if (card.level != null) stats.push(`${card.subtype === 'Link' ? 'Link' : card.subtype === 'Xyz' ? 'Rank' : 'Level'} ${card.level}`);
  if (card.atk != null) stats.push(`ATK ${card.atk}`);
  if (card.def != null) stats.push(`DEF ${card.def}`);
  $('#detail-meta').textContent = stats.join(' · ') || `${card.category || 'Card'} · ${card.subtype || ''}`;
  $('#detail-copy-count').textContent = copies === 0 ? '0 copies permitted' : `Up to ${copies} ${copies === 1 ? 'copy' : 'copies'}`;
  $('#detail-description').textContent = card.description || 'Card text is unavailable for this card.';
  $('#detail-image').src = card.id ? cardImageUrl(card.id) : cardImageUrl(0);
  $('#detail-image').alt = `${smartTitle(card.name || 'Card')} card image`;
  const noteBox = $('#detail-note');
  noteBox.hidden = !card.note;
  $('p', noteBox).textContent = card.note || '';
  $('#card-detail-loading').hidden = true;
  $('#card-detail').hidden = false;
}

async function checkSession() {
  const payload = await api('/api/auth/session');
  state.admin.authenticated = payload.authenticated;
  state.admin.email = payload.email;
  state.admin.csrf = payload.csrfToken;
  return payload;
}

async function openAdmin() {
  const dialog = $('#admin-modal');
  dialog.showModal();
  const session = await checkSession();
  if (session.authenticated) return showAdminApp();
  showAdminAuth(!state.config?.adminConfigured);
}

function showAdminAuth(isSetup) {
  $('#admin-auth').hidden = false;
  $('#setup-token-label').hidden = !(isSetup && state.config?.setupTokenRequired);
  $('#setup-token').required = Boolean(isSetup && state.config?.setupTokenRequired);
  $('#admin-app').hidden = true;
  $('#login-form').hidden = isSetup;
  $('#setup-form').hidden = !isSetup;
  $('#auth-title').textContent = isSetup ? 'Create administrator' : 'Administrator login';
  $('#auth-description').textContent = isSetup
    ? 'Complete the one-time setup. After this account is created, public registration is disabled.'
    : 'Sign in to edit the draft list, review changes, and publish a new version.';
}

async function showAdminApp() {
  $('#admin-auth').hidden = true;
  $('#admin-app').hidden = false;
  $('#admin-email').textContent = state.admin.email || '';
  await Promise.all([loadDraft(), loadVersions()]);
  showAdminSection(state.admin.section);
  populateSettingsForm();
}

async function loadDraft() {
  const payload = await api('/api/admin/draft');
  state.admin.draft = payload.draft;
  state.admin.entries = payload.entries || [];
  state.admin.changes = payload.changes || [];
  state.admin.houseChanges = payload.houseChanges || [];
  renderDraftTable();
  renderChangeReview();
  $('#publish-date').value = state.admin.draft?.effectiveDate || new Date().toISOString().slice(0, 10);
}

function renderDraftTable() {
  const query = normalise($('#draft-filter').value);
  const rows = state.admin.entries
    .filter((card) => !query || normalise(card.name).includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));
  $('#draft-entry-count').textContent = `${state.admin.entries.length} restricted cards in this draft`;
  const body = $('#draft-table-body');
  body.innerHTML = rows.map((card) => `
    <tr data-draft-name="${escapeHtml(card.name)}">
      <td>${escapeHtml(smartTitle(card.name))}${houseChangeBadge(card)}</td>
      <td>${escapeHtml(card.category)} · ${escapeHtml(card.subtype)}</td>
      <td>
        <select data-draft-status="${escapeHtml(card.name)}" aria-label="Status for ${escapeHtml(smartTitle(card.name))}">
          <option value="forbidden" ${card.status === 'forbidden' ? 'selected' : ''}>Forbidden</option>
          <option value="limited" ${card.status === 'limited' ? 'selected' : ''}>Limited</option>
          <option value="semi_limited" ${card.status === 'semi_limited' ? 'selected' : ''}>Semi-Limited</option>
          <option value="unlimited">Unlimited / remove</option>
        </select>
      </td>
      <td><input type="text" value="${escapeHtml(card.note || '')}" data-draft-note="${escapeHtml(card.name)}" aria-label="Note for ${escapeHtml(smartTitle(card.name))}" placeholder="Optional public note"></td>
      <td class="row-save-state" aria-live="polite"></td>
    </tr>`).join('');
}

function renderChangeReview() {
  const container = $('#change-review-list');
  const changes = state.admin.changes || [];
  if (!changes.length) {
    container.innerHTML = '<div class="suggestion-empty">No status changes yet. The draft currently matches the live list.</div>';
    return;
  }
  container.innerHTML = changes.map((card) => `
    <div class="change-review-row">
      <div><strong>${escapeHtml(smartTitle(card.name))}</strong><small>${escapeHtml(card.category)} · ${escapeHtml(card.subtype)}</small></div>
      <div class="change-statuses"><span class="mini-status ${card.previousStatus}">${STATUS[card.previousStatus]?.label || 'Unlimited'}</span><span aria-hidden="true">→</span><span class="mini-status ${card.status}">${STATUS[card.status]?.label || 'Unlimited'}</span></div>
    </div>`).join('');
}

async function saveDraftRow(name, status, note, row) {
  const marker = $('.row-save-state', row);
  marker.textContent = '…';
  try {
    await api('/api/admin/draft/entry-by-name', { method: 'PATCH', body: { name, status, note } });
    marker.textContent = '✓';
    await loadDraft();
    setTimeout(() => { if (marker.isConnected) marker.textContent = ''; }, 1000);
  } catch (error) {
    marker.textContent = '!';
    toast(error.message, 'error');
  }
}

let adminSearchTimer;
async function runAdminSearch(query) {
  const clean = query.trim();
  const container = $('#admin-search-results');
  if (clean.length < 2) {
    state.admin.searchResults = [];
    container.innerHTML = '';
    return;
  }
  $('#admin-search-spinner').hidden = false;
  try {
    const payload = await api(`/api/cards/search?q=${encodeURIComponent(clean)}`);
    state.admin.searchResults = payload.results || [];
    container.innerHTML = state.admin.searchResults.length ? state.admin.searchResults.map((card, index) => `
      <div class="admin-search-card">
        <img src="${card.id ? cardImageUrl(card.id) : cardImageUrl(0)}" alt="" loading="lazy">
        <div><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(card.cardType)} · Currently ${STATUS[draftStatusFor(card.name)]?.label || 'Unlimited'}</small></div>
        <button class="button ghost-dark" type="button" data-admin-add-index="${index}">Apply status</button>
      </div>`).join('') : '<div class="suggestion-empty">No cards found.</div>';
  } catch (error) {
    container.innerHTML = `<div class="suggestion-empty">${escapeHtml(error.message)}</div>`;
  } finally {
    $('#admin-search-spinner').hidden = true;
  }
}

function draftStatusFor(name) {
  return state.admin.entries.find((entry) => normalise(entry.name) === normalise(name))?.status || 'unlimited';
}

async function applyAdminCard(card) {
  const status = $('#admin-status-select').value;
  try {
    await api('/api/admin/draft/entry', { method: 'POST', body: { card, status } });
    toast(`${card.name} set to ${STATUS[status].label}.`);
    await loadDraft();
    await runAdminSearch($('#admin-card-search').value);
  } catch (error) { toast(error.message, 'error'); }
}

async function loadVersions() {
  if (!state.admin.authenticated) return;
  const payload = await api('/api/admin/versions');
  state.admin.versions = payload.versions || [];
  renderVersions();
}

function renderVersions() {
  const container = $('#version-list');
  container.innerHTML = state.admin.versions.map((version) => `
    <div class="version-row">
      <div>
        <strong>${escapeHtml(version.versionLabel)}</strong>
        <p>${escapeHtml(version.summary || 'No public summary.')}</p>
        <div class="version-meta"><span class="version-pill">${escapeHtml(version.status)}</span><span>Effective ${formatDate(version.effectiveDate)}</span>${version.source ? `<span>${escapeHtml(version.source)}</span>` : ''}</div>
      </div>
      ${version.status === 'published' ? `<button class="button ghost-dark compact" type="button" data-restore-version="${version.id}">Restore as draft</button>` : ''}
    </div>`).join('');
}

function populateSettingsForm() {
  const settings = state.config?.settings || {};
  $('#setting-store-name').value = settings.store_name || '';
  $('#setting-format-name').value = settings.format_name || '';
  $('#setting-short-name').value = settings.format_short_name || '';
  $('#setting-accent-label').value = settings.accent_label || '';
  $('#setting-description').value = settings.format_description || '';
}

function showAdminSection(section) {
  state.admin.section = section;
  const titles = {
    editor: ['Draft workspace', 'List editor'],
    publish: ['Publication control', 'Review & publish'],
    history: ['Audit trail', 'Version history'],
    settings: ['Configuration', 'Format settings']
  };
  $$('.admin-nav button').forEach((button) => button.classList.toggle('active', button.dataset.adminSection === section));
  $$('[data-section-panel]').forEach((panel) => {
    const active = panel.dataset.sectionPanel === section;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  $('#admin-section-kicker').textContent = titles[section][0];
  $('#admin-section-title').textContent = titles[section][1];
  if (section === 'publish') renderChangeReview();
  if (section === 'history') loadVersions().catch((error) => toast(error.message, 'error'));
}

function wireEvents() {
  $('#rules-button').addEventListener('click', () => $('#rules-modal').showModal());
  $('#admin-button').addEventListener('click', () => openAdmin().catch((error) => toast(error.message, 'error')));
  $$('[data-rule-filter]').forEach((button) => button.addEventListener('click', () => {
    const status = button.dataset.ruleFilter;
    state.filters.status.clear();
    state.filters.status.add(status);
    $$('[data-filter="status"]').forEach((input) => { input.checked = input.value === status; });
    switchView(status === 'unlimited' ? 'changes' : 'current', false);
    updateFilterUi();
    $('.list-toolbar').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.closeDialog}`).close()));
  $$('.modal').forEach((dialog) => dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  }));

  $$('.view-tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));
  $('#filter-toggle').addEventListener('click', () => {
    const panel = $('#filters-panel');
    panel.classList.toggle('open');
    $('#filter-toggle').setAttribute('aria-expanded', String(panel.classList.contains('open')));
  });
  $$('[data-filter]').forEach((input) => input.addEventListener('change', () => {
    const set = state.filters[input.dataset.filter];
    input.checked ? set.add(input.value) : set.delete(input.value);
    updateFilterUi();
  }));
  $('#sort-select').addEventListener('change', (event) => { state.sort = event.target.value; updateUrl(); renderList(); });
  $('#clear-filters').addEventListener('click', clearFilters);
  $('#empty-clear').addEventListener('click', clearFilters);
  $('#active-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-filter]');
    if (!button) return;
    const [group, value] = button.dataset.removeFilter.split(':');
    state.filters[group].delete(value);
    const input = $$(`[data-filter="${group}"]`).find((item) => item.value === value);
    if (input) input.checked = false;
    updateFilterUi();
  });
  $('#card-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-card]');
    if (button) openCardDetail(button.dataset.openCard);
  });

  const cardSearch = $('#card-search');
  cardSearch.addEventListener('input', () => {
    clearTimeout(publicSearchTimer);
    publicSearchTimer = setTimeout(() => runPublicSearch(cardSearch.value), 260);
  });
  cardSearch.addEventListener('focus', () => { if (cardSearch.value.trim().length >= 2) runPublicSearch(cardSearch.value); });
  cardSearch.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSuggestion(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveSuggestion(-1); }
    else if (event.key === 'Enter' && state.searchIndex >= 0) {
      event.preventDefault();
      openCardDetail(state.searchResults[state.searchIndex]);
      hideSuggestions();
    } else if (event.key === 'Escape') hideSuggestions();
  });
  $('#clear-search').addEventListener('click', () => { cardSearch.value = ''; $('#clear-search').hidden = true; hideSuggestions(); cardSearch.focus(); });
  $('#search-suggestions').addEventListener('click', (event) => {
    const row = event.target.closest('[data-suggestion-index]');
    if (!row) return;
    openCardDetail(state.searchResults[Number(row.dataset.suggestionIndex)]);
    hideSuggestions();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.search-panel')) hideSuggestions();
  });

  $('#setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#setup-error');
    error.hidden = true;
    const password = $('#setup-password').value;
    if (password !== $('#setup-password-confirm').value) {
      error.textContent = 'Passwords do not match.'; error.hidden = false; return;
    }
    try {
      if (password.length < 12) throw new Error('Use a password of at least 12 characters.');
      const salt = newPasswordSalt();
      const passwordVerifier = await passwordProof(password, salt);
      const payload = await api('/api/setup', { method: 'POST', body: {
        email: $('#setup-email').value, salt, passwordVerifier, setupToken: $('#setup-token').value
      } });
      state.admin.authenticated = true;
      state.admin.email = payload.email;
      state.admin.csrf = payload.csrfToken;
      state.config.adminConfigured = true;
      toast('Administrator account created.');
      await showAdminApp();
    } catch (err) { error.textContent = err.message; error.hidden = false; }
  });

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#login-error');
    error.hidden = true;
    try {
      const email = $('#login-email').value;
      const { salt } = await api(`/api/auth/password-salt?email=${encodeURIComponent(email)}`);
      const passwordVerifier = await passwordProof($('#login-password').value, salt);
      const payload = await api('/api/auth/login', { method: 'POST', body: { email, passwordVerifier } });
      state.admin.authenticated = true;
      state.admin.email = payload.email;
      state.admin.csrf = payload.csrfToken;
      $('#login-password').value = '';
      await showAdminApp();
    } catch (err) { error.textContent = err.message; error.hidden = false; }
  });

  $('#logout-button').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    state.admin = { authenticated: false, email: null, csrf: null, draft: null, entries: [], changes: [], houseChanges: [], versions: [], section: 'editor', searchResults: [] };
    showAdminAuth(false);
    toast('Signed out.');
  });

  $$('.admin-nav button').forEach((button) => button.addEventListener('click', () => showAdminSection(button.dataset.adminSection)));

  $('#admin-card-search').addEventListener('input', (event) => {
    clearTimeout(adminSearchTimer);
    adminSearchTimer = setTimeout(() => runAdminSearch(event.target.value), 300);
  });
  $('#admin-search-results').addEventListener('click', (event) => {
    const button = event.target.closest('[data-admin-add-index]');
    if (!button) return;
    applyAdminCard(state.admin.searchResults[Number(button.dataset.adminAddIndex)]);
  });
  $('#draft-filter').addEventListener('input', renderDraftTable);
  $('#draft-table-body').addEventListener('change', (event) => {
    const select = event.target.closest('[data-draft-status]');
    if (!select) return;
    const row = select.closest('tr');
    const note = $('[data-draft-note]', row)?.value || '';
    saveDraftRow(select.dataset.draftStatus, select.value, note, row);
  });
  $('#draft-table-body').addEventListener('focusout', (event) => {
    const input = event.target.closest('[data-draft-note]');
    if (!input) return;
    const row = input.closest('tr');
    const select = $('[data-draft-status]', row);
    const current = state.admin.entries.find((entry) => normalise(entry.name) === normalise(input.dataset.draftNote));
    if ((current?.note || '') !== input.value) saveDraftRow(input.dataset.draftNote, select.value, input.value, row);
  });

  $('#publish-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#publish-error');
    error.hidden = true;
    if (!state.admin.changes.length) {
      error.textContent = 'There are no status changes to publish.'; error.hidden = false; return;
    }
    try {
      await api('/api/admin/publish', { method: 'POST', body: {
        versionLabel: $('#publish-version').value,
        effectiveDate: $('#publish-date').value,
        summary: $('#publish-summary').value
      }});
      toast('New house-format version published.');
      $('#publish-version').value = '';
      $('#publish-summary').value = '';
      await loadPublicData();
      await Promise.all([loadDraft(), loadVersions()]);
      showAdminSection('editor');
    } catch (err) { error.textContent = err.message; error.hidden = false; }
  });

  $('#version-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-restore-version]');
    if (!button) return;
    if (!confirm('Replace the current draft with a copy of this version? The live list will not change.')) return;
    try {
      await api(`/api/admin/versions/${button.dataset.restoreVersion}/restore`, { method: 'POST' });
      toast('Version restored as a new draft.');
      await loadDraft();
      showAdminSection('editor');
    } catch (error) { toast(error.message, 'error'); }
  });

  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#settings-error');
    error.hidden = true;
    try {
      const payload = await api('/api/admin/settings', { method: 'PATCH', body: {
        store_name: $('#setting-store-name').value,
        format_name: $('#setting-format-name').value,
        format_short_name: $('#setting-short-name').value,
        accent_label: $('#setting-accent-label').value,
        format_description: $('#setting-description').value
      }});
      state.config.settings = payload.settings;
      applyConfig();
      toast('Format settings saved.');
    } catch (err) { error.textContent = err.message; error.hidden = false; }
  });

  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#password-error');
    error.hidden = true;
    const next = $('#new-password').value;
    if (next !== $('#new-password-confirm').value) { error.textContent = 'New passwords do not match.'; error.hidden = false; return; }
    try {
      if (next.length < 12) throw new Error('Use a password of at least 12 characters.');
      const { salt } = await api(`/api/auth/password-salt?email=${encodeURIComponent(state.admin.email)}`);
      const currentVerifier = await passwordProof($('#current-password').value, salt);
      const newSalt = newPasswordSalt(), newVerifier = await passwordProof(next, newSalt);
      await api('/api/admin/password', { method: 'POST', body: { currentVerifier, newSalt, newVerifier } });
      event.target.reset();
      toast('Administrator password changed.');
    } catch (err) { error.textContent = err.message; error.hidden = false; }
  });
}

async function init() {
  wireEvents();
  restoreUrlState();
  try { await loadPublicData(); }
  catch (error) {
    $('#card-list').innerHTML = `<div class="empty-state"><h3>Could not load the house-format list</h3><p>${escapeHtml(error.message)}</p></div>`;
    toast(error.message, 'error');
  }
}

init();
