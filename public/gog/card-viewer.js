import { catalogueMarkup, cardDetailMarkup } from './card-viewer-markup.js?v=compact-cards';

const GOG_BASE = '/gog';
const CARD_POOL_CUTOFF = '2025-08-01';
function cardImageUrl(id) { return `${GOG_BASE}/api/cards/${Number(id) || 0}/image`; }

const mobileHouseLayout = window.matchMedia('(max-width: 600px)');

const STATUS = {
  forbidden: { label: 'Forbidden', copies: 0 },
  limited: { label: 'Limited', copies: 1 },
  semi_limited: { label: 'Semi-Limited', copies: 2 },
  unlimited: { label: 'Unlimited', copies: 3 }
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

function typeInitial(category) {
  return category === 'Spell' ? 'S' : category === 'Trap' ? 'T' : 'M';
}

function statusBadge(status) {
  const item = STATUS[status] || STATUS.unlimited;
  return `<span class="status-badge status-${escapeHtml(status)}"><b>${item.copies}</b><span>${item.label}</span></span>`;
}

function houseChangeBadge(card) {
  return card?.isHouseChange
    ? '<span class="house-change-badge" title="Different from the fixed JUSH-era baseline">House change</span>'
    : '';
}

async function api(path, options = {}) {
  const config = { ...options, headers: { ...(options.headers || {}) } };
  if (config.body && typeof config.body !== 'string') {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(config.body);
  }
  const routedPath = path.startsWith('/api/') ? `${GOG_BASE}${path}` : path;
  const response = await fetch(routedPath, config);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error || payload || `Request failed (${response.status})`);
  return payload;
}

export function mountCardViewer(container, { onConfig, onPropose, canPropose, catalogueHeading = true, catalogueMedia } = {}) {
  container.innerHTML = cardDetailMarkup;
  const $ = (selector, root = container) => root.querySelector(selector);
  const $$ = (selector, root = container) => [...root.querySelectorAll(selector)];
  const state = {
    config: null,
    baseline: null,
    entries: [],
    changes: [],
    recentChanges: [],
    view: 'current',
    filters: { status: new Set(), category: new Set(), subtype: new Set() },
    sort: 'status-name',
    searchResults: [],
    searchIndex: -1,
    searchAbort: null,

  };

  let selectedCard, detailRequest = 0;
  let proposalButton;
  if (onPropose) {
    $('.card-detail-copy').insertAdjacentHTML('beforeend', '<button type="button" class="button propose-card" hidden>Propose a change</button>');
    proposalButton = $('.propose-card');
    proposalButton.onclick = () => {
      if (!selectedCard?.id || !canPropose()) return;
      $('#card-modal').close();
      onPropose(selectedCard);
    };
  }
  function syncProposalAction() {
    if (proposalButton) proposalButton.hidden = !(canPropose() && selectedCard?.id);
  }
  function toast(message, type = 'success') {
    const region = container.getRootNode().getElementById('toast-region');
    const element = document.createElement('div');
    element.className = `toast ${type}`;
    element.innerHTML = `<strong aria-hidden="true">${type === 'error' ? '!' : '✓'}</strong><span>${escapeHtml(message)}</span>`;
    region.append(element);
    setTimeout(() => element.remove(), 4200);
  }

  const cardsTab = document.body.classList.contains('ja-cards');
  const snapshotKey = 'jush-public-list-' + CARD_POOL_CUTOFF;
  let loadedList = false, checkingSnapshot = false;

  function applyList(list) {
    state.baseline = list.baseline || null;
    state.entries = list.entries || [];
    state.changes = list.changes || [];
    state.recentChanges = list.recentChanges || [];
    loadedList = true;
    renderList();
  }

  async function loadPublicData() {
    const fresh = Promise.all([api('/api/config'), api('/api/list')]);
    let cachedJson;
    if (cardsTab) {
      try {
        const snapshot = JSON.parse(sessionStorage.getItem(snapshotKey));
        if (snapshot && Date.now() - snapshot.checked < 300000) {
          const list = JSON.parse(snapshot.json);
          if (Array.isArray(list.entries)) {
            checkingSnapshot = true;
            applyList(list);
            cachedJson = snapshot.json;
            window.JushTabs.contentReady();
          }
        }
      } catch { checkingSnapshot = false; }
    }
    const [config, list] = await fresh;
    if (config.cardPool?.cutoffDate !== CARD_POOL_CUTOFF) throw new Error('Card pool mismatch. The deployed list is not locked to Justice Hunters.');
    state.config = config;
    state.config.version = list.version || config.version;
    onConfig?.(state.config);
    checkingSnapshot = false;
    const json = cardsTab ? JSON.stringify(list) : null;
    if (json === cachedJson) showCount(filteredDataset().length);
    else applyList(list);
    if (cardsTab) {
      try { sessionStorage.setItem(snapshotKey, JSON.stringify({ checked: Date.now(), json })); } catch {}
    }
  }

  function currentDataset() {
    if (state.view === 'changes') return state.changes;
    if (state.view === 'recent') return state.recentChanges;
    return state.entries;
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

  function showCount(count) {
    const label = count + (count === 1 ? ' card shown' : ' cards shown');
    $('#results-count').textContent = checkingSnapshot ? label + ' · Checking for updates' : label;
  }

  function renderList() {
    const list = $('#card-list');
    if (!loadedList) return;
    const data = filteredDataset();
    const isHouse = state.view === 'changes';
    const isRecent = state.view === 'recent';
    $$('[data-list-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.listView === state.view)));
    $('#results-title').textContent = 'Forbidden & Limited List';
    showCount(data.length);
    list.setAttribute('aria-busy', 'false');

    if (!data.length) {
      list.innerHTML = '';
      $('#empty-state').hidden = false;
      if (isHouse && state.changes.length === 0 && !activeFilterCount()) {
        $('#empty-state h3').textContent = 'This list matches the official baseline';
        $('#empty-state p').textContent = 'House tweaks will appear here whenever a published status differs from the official JUSH banlist.';
        $('#empty-clear').hidden = true;
      } else if (isRecent && state.recentChanges.length === 0 && !activeFilterCount()) {
        $('#empty-state h3').textContent = 'No card changes in this revision';
        $('#empty-state p').textContent = 'The latest published revision did not change a card restriction or house-format note.';
        $('#empty-clear').hidden = true;
      } else {
        $('#empty-state h3').textContent = 'No cards match those filters';
        $('#empty-state p').textContent = 'Clear a filter or choose another combination.';
        $('#empty-clear').hidden = false;
      }
      return;
    }
    $('#empty-state').hidden = true;
    renderRows(list, data);
  }

  function renderRows(list, data) {
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
    const baselineStatus = card.baselineStatus || card.previousStatus;
    const changeContext = state.view === 'changes' && card.isHouseChange && baselineStatus
      ? `<span class="change-context">${STATUS[baselineStatus]?.label || 'Unlimited'} <span aria-hidden="true">&gt;</span> ${status.label}</span>`
      : state.view === 'recent' && card.changeType === 'note_updated'
        ? '<span class="change-context">Note updated</span>'
        : state.view === 'recent' && card.previousStatus
          ? `<span class="change-context">${STATUS[card.previousStatus]?.label || 'Unlimited'} <span aria-hidden="true">&gt;</span> ${status.label}</span>`
          : '';
    return `
      <article class="card-row status-${escapeHtml(card.status)}${card.isHouseChange ? ' is-house-change' : ''}" data-card-name="${escapeHtml(card.name)}">
        <div class="card-thumbnail ${escapeHtml(card.category.toLowerCase())}">
          <img src="${cardImageUrl(card.cardId || card.id || 0)}" alt="" width="42" height="61" loading="lazy" decoding="async">
          <span aria-hidden="true">${typeInitial(card.category)}</span>
        </div>
        <div class="card-copy">
          <h3 class="card-name">${escapeHtml(smartTitle(card.name))}${houseChangeBadge(card)}</h3>
          <div class="card-status-mobile">${statusBadge(card.status)}${houseChangeBadge(card)}</div>
          <div class="card-metadata"><span>${escapeHtml(card.category)} · ${escapeHtml(card.subtype)}</span>${changeContext}</div>
          ${note}
        </div>
        <div class="status-cell">${statusBadge(card.status)}</div>
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
    $$('[data-rule-filter]').forEach((button) => button.setAttribute('aria-pressed', String(state.filters.status.has(button.dataset.ruleFilter))));
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
    try { history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`); } catch {}
  }

  function restoreUrlState() {
    const params = new URLSearchParams(location.search);
    if (['changes', 'recent'].includes(params.get('view'))) state.view = params.get('view');
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
    hideSuggestions();
    $$('[data-list-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.listView === view)));
    if (update) {
      updateUrl();
      renderList();
    }
  }

  let publicSearchTimer;
  function syncSearchPlaceholder() {
    $('#card-search').placeholder = mobileHouseLayout.matches ? 'Search cards…' : 'Search card names or archetypes…';
  }
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
      if ($('#card-search').value.trim() !== clean) return;
      const merged = new Map();
      for (const item of [...local, ...(payload.results || [])]) merged.set(normalise(item.name), item);
      state.searchResults = [...merged.values()].slice(0, 20);
      renderSuggestions(state.searchResults, false);
      $('#api-state').hidden = true;
    } catch (error) {
      if (error.name !== 'AbortError' && $('#card-search').value.trim() === clean) {
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
    const request = ++detailRequest;
    selectedCard = null;
    syncProposalAction();
    $('#card-detail').hidden = true;
    $('#card-detail-loading').hidden = false;
    dialog.showModal();
    dialog.scrollTop = 0;
    try {
      let card = supplied;
      if (!card?.description) {
        const payload = await api(`/api/cards/lookup?name=${encodeURIComponent(cardName)}`);
        card = payload.card || supplied || { name: cardName };
      }
      card = { ...supplied, ...card, ...local, status: local?.status || card?.status || supplied?.status || 'unlimited' };
      if (request === detailRequest) populateCardDetail(card);
    } catch {
      if (request === detailRequest) populateCardDetail({ ...supplied, ...local, name: cardName, status: local?.status || supplied?.status || 'unlimited' });
    }
  }

  function populateCardDetail(card) {
    selectedCard = { ...card, id: Number(card.canonicalId || card.id || card.cardId) };
    syncProposalAction();
    const status = card.status || 'unlimited';
    const copies = STATUS[status].copies;
    const detail = $('#card-detail');
    detail.dataset.category = card.category || '';
    detail.dataset.status = status;
    $('#detail-name').textContent = smartTitle(card.name || 'Unknown card');
    $('#detail-status').textContent = STATUS[status].label;
    $('#detail-house-change').hidden = !card.isHouseChange;
    const isSpellOrTrap = card.category === 'Spell' || card.category === 'Trap';
    const cardType = card.cardType || [card.category, card.subtype].filter(Boolean).join(' · ') || 'Card';
    $('#detail-type').textContent = isSpellOrTrap && card.race ? card.race + ' ' + card.category : cardType;
    const rating = card.subtype === 'Link' ? 'Link' : card.subtype === 'Xyz' ? 'Rank' : 'Level';
    const stats = isSpellOrTrap ? [] : [
      ['Attribute', card.attribute], ['Type', card.race],
      [rating, rating === 'Link' ? card.linkRating ?? card.level : card.level],
      ['Scale', card.pendulumScale], ['ATK', card.atk], ['DEF', card.def]
    ].filter(([, value]) => value != null && value !== '');
    const meta = $('#detail-meta');
    meta.innerHTML = stats.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
    meta.hidden = stats.length === 0;
    $('#detail-copy-count').textContent = copies === 0 ? '0 copies permitted' : `Up to ${copies} ${copies === 1 ? 'copy' : 'copies'}`;
    $('#detail-description').textContent = card.description || 'Card text is unavailable for this card.';
    const image = $('#detail-image');
    const print = $('#detail-print');
    const artworkId = card.artworkId || card.id || card.cardId;
    const imagePath = cardImageUrl(artworkId);
    const fullSize = card.fullImageUrl || imagePath + '?size=full';
    if (artworkId) print.href = fullSize;
    else print.removeAttribute('href');
    image.onerror = () => {
      image.onerror = null;
      print.removeAttribute('href');
      image.src = imagePath + '?size=thumb';
    };
    image.alt = `${smartTitle(card.name || 'Card')} card image`;
    image.src = fullSize;
    const noteBox = $('#detail-note');
    noteBox.hidden = !card.note;
    $('p', noteBox).textContent = card.note || '';
    $('#card-detail-loading').hidden = true;
    $('#card-detail').hidden = false;
  }

  function wireEvents() {
    $$('[data-rule-filter]').forEach((button) => button.addEventListener('click', () => {
      const status = button.dataset.ruleFilter;
      state.filters.status.clear();
      state.filters.status.add(status);
      $$('[data-filter="status"]').forEach((input) => { input.checked = input.value === status; });
      switchView(status === 'unlimited' ? 'changes' : 'current', false);
      updateFilterUi();
      $('#list-workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    $$('[data-list-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.listView)));
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
    syncSearchPlaceholder();
    mobileHouseLayout.addEventListener?.('change', syncSearchPlaceholder);
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
      if (!event.composedPath().includes($('.search-panel'))) hideSuggestions();
    });

  }

  async function initCatalogue() {
    container.insertAdjacentHTML('afterbegin', catalogueMarkup);
    if (onPropose && catalogueHeading) {
      const heading = $('#search-heading');
      heading.textContent = 'Card catalogue';
      heading.parentElement.replaceChildren(heading);
    }
    wireEvents();
    restoreUrlState();
    try {
      await loadPublicData();
    }
    catch (error) {
      loadedList = false;
      checkingSnapshot = false;
      if (cardsTab) {
        try { sessionStorage.removeItem(snapshotKey); } catch {}
      }
      $('#empty-state').hidden = true;
      $('#card-list').innerHTML = `<div class="empty-state"><h3>Could not load the house-format list</h3><p>${escapeHtml(error.message)}</p></div>`;
      $('#card-list').setAttribute('aria-busy', 'false');
      $('#results-count').textContent = 'Cards unavailable';
      toast(error.message, 'error');
    } finally {
      if (cardsTab) window.JushTabs.contentReady();
    }
  }

  const detailDialog = $('#card-modal');
  detailDialog.querySelector('[data-close-dialog]').addEventListener('click', () => detailDialog.close());
  detailDialog.addEventListener('click', event => {
    if (event.target === detailDialog) detailDialog.close();
  });

  function showCatalogueWhenReady() {
    if (catalogueMedia && !catalogueMedia.matches) return;
    catalogueMedia?.removeEventListener('change', showCatalogueWhenReady);
    initCatalogue();
  }
  catalogueMedia?.addEventListener('change', showCatalogueWhenReady);
  showCatalogueWhenReady();
  return { openCardDetail, syncProposalAction };
}
