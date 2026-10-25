const API_BASE = '/gog/api';
const $ = (selector, root = document) => root.querySelector(selector);
const state = { csrf: null, email: null, events: [] };

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function api(path, options = {}) {
  const config = { method: options.method || 'GET', headers: { ...(options.headers || {}) } };
  if (options.body !== undefined) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(options.body);
  }
  if (state.csrf && config.method !== 'GET') config.headers['X-CSRF-Token'] = state.csrf;
  const response = await fetch(`${API_BASE}${path}`, config);
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : {};
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function displayDate(value) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${value}T12:00:00Z`));
}

function dateBadge(value) {
  const date = new Date(`${value}T12:00:00Z`);
  return {
    month: new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(date),
    day: new Intl.DateTimeFormat('en-GB', { day: '2-digit', timeZone: 'UTC' }).format(date)
  };
}

function displayTime(value) {
  if (!value) return 'Time to be announced';
  const [hour, minute] = value.split(':').map(Number);
  const suffix = hour >= 12 ? 'pm' : 'am';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')}${suffix}`;
}

const eventArtwork = {
  'yugioh-advanced-thursday': { image: 'magician-of-black-chaos-art.jpg', label: 'Advanced Format', theme: 'advanced' },
  'yugioh-house-friday': { image: 'dracotail-art.jpg', label: 'JUSH House Format', theme: 'house' }
};
const eventIcon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${name === 'clock'
  ? '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  : '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>'}</svg>`;

function eventCard(event) {
  const badge = dateBadge(event.eventDate);
  const cancelled = event.status === 'cancelled';
  const artwork = eventArtwork[event.slug];
  const time = displayTime(event.startTime) + (event.endTime ? ` – ${displayTime(event.endTime)}` : '');
  const timingLabel = artwork?.theme === 'advanced' ? 'Advanced TCG' : 'Special event';
  return `<article class="event-card ${artwork?.theme || 'special'} ${cancelled ? 'cancelled' : ''}">
    <div class="event-visual">
      ${artwork ? `<img class="event-artwork" src="/gog/assets/${artwork.image}" alt="" width="624" height="624" loading="lazy" decoding="async">`
        : '<img class="event-artwork store-artwork" src="/gog/assets/guild-of-games-logo.png" alt="" width="512" height="483" loading="lazy" decoding="async">'}
      <span class="event-format">${artwork?.label || 'At Guild of Games'}</span>
      <div class="event-date" aria-hidden="true"><span>${escapeHtml(badge.month)}</span><strong>${escapeHtml(badge.day)}</strong></div>
      ${cancelled ? '<p class="event-status">Cancelled</p>' : ''}
    </div>
    <div class="event-body">
      <p class="event-type">${timingLabel}</p>
      <h3>${escapeHtml(event.title)}</h3>
      <p class="event-full-date"><time datetime="${escapeHtml(event.eventDate)}">${escapeHtml(displayDate(event.eventDate))}</time></p>
      <div class="event-meta"><p class="event-time">${eventIcon('clock')}<span>${escapeHtml(time)}</span></p><p>${eventIcon('location')}<span>${escapeHtml(event.location)}</span></p></div>
      ${event.description ? `<p class="event-description">${escapeHtml(event.description)}</p>` : ''}
      ${artwork?.theme === 'house' ? '<a class="event-link" href="/gog/house-format/">Explore the house rules <span aria-hidden="true">→</span></a>' : ''}
    </div>
  </article>`;
}

function renderEventGroup(selector, events, emptyMessage) {
  const grid = $(selector);
  grid.setAttribute('aria-busy', 'false');
  grid.innerHTML = events.length ? events.map(eventCard).join('') : `<p class="empty-events">${emptyMessage}</p>`;
}

async function loadEvents() {
  const payload = await api('/events');
  state.events = payload.events || [];
  const advanced = state.events.filter((event) => event.slug === 'yugioh-advanced-thursday');
  const special = state.events.filter((event) => event.slug !== 'yugioh-advanced-thursday');
  renderEventGroup('#advanced-event-grid', advanced, 'No upcoming Advanced TCG events are currently listed.');
  renderEventGroup('#special-event-grid', special, 'No upcoming special events are currently listed.');
}

let toastTimer;
function toast(message) {
  const element = $('#home-toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 3600);
}

async function passwordProof(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 310_000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits), (value) => value.toString(16).padStart(2, '0')).join('');
}

function eventForm(event, recurring) {
  const id = recurring ? `recurring-${event.seriesId}` : `special-${event.eventId}`;
  return `<article class="admin-event-card">
    <header><div><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(displayDate(event.eventDate))}</span></div>${event.customised ? '<span>Customised</span>' : ''}</header>
    <form class="event-form" data-event-form="${id}" data-recurring="${recurring}" data-id="${recurring ? event.seriesId : event.eventId}">
      <input type="hidden" name="eventDate" value="${escapeHtml(event.eventDate)}">
      <label>Event name<input name="title" maxlength="120" required value="${escapeHtml(event.title)}"></label>
      <label>Start time<input name="startTime" type="time" value="${escapeHtml(event.startTime || '')}"></label>
      <label>Finish time<input name="endTime" type="time" value="${escapeHtml(event.endTime || '')}"></label>
      <label>Status<select name="status"><option value="scheduled" ${event.status === 'scheduled' ? 'selected' : ''}>Scheduled</option><option value="cancelled" ${event.status === 'cancelled' ? 'selected' : ''}>Cancelled</option></select></label>
      <label class="wide-field">Location<input name="location" maxlength="180" required value="${escapeHtml(event.location)}"></label>
      <label class="wide-field">Details<textarea name="description" maxlength="1200">${escapeHtml(event.description || '')}</textarea></label>
      <div class="form-actions">
        ${recurring && event.customised ? '<button class="small-button" type="button" data-reset-override>Reset this date</button>' : ''}
        ${!recurring ? '<button class="small-button danger" type="button" data-delete-event>Delete event</button>' : ''}
        <button class="small-button primary" type="submit">Save changes</button>
      </div>
    </form>
  </article>`;
}

async function loadAdminEvents() {
  const payload = await api('/admin/events');
  const events = payload.events || [];
  const recurring = events.filter((event) => event.source === 'recurring');
  const special = events.filter((event) => event.source === 'special');
  $('#recurring-admin-list').innerHTML = recurring.map((event) => eventForm(event, true)).join('');
  $('#special-admin-list').innerHTML = special.length ? special.map((event) => eventForm(event, false)).join('')
    : '<p class="empty-events">No one-off events are currently listed.</p>';
}

async function showAdminApp(session) {
  state.csrf = session.csrfToken;
  state.email = session.email;
  $('#events-admin-email').textContent = session.email || '';
  $('#events-admin-login').hidden = true;
  $('#events-admin-app').hidden = false;
  await loadAdminEvents();
}

async function openAdmin() {
  const dialog = $('#events-admin-dialog');
  if (!dialog.open) dialog.showModal();
  const session = await api('/auth/session');
  if (session.authenticated) return showAdminApp(session);
  state.csrf = null;
  $('#events-admin-login').hidden = false;
  $('#events-admin-app').hidden = true;
  $('#events-login-email').focus();
}

function formPayload(form) {
  const data = new FormData(form);
  return Object.fromEntries([...data.entries()].map(([key, value]) => [key, String(value)]));
}

async function refreshAfterChange(message) {
  await Promise.all([loadEvents(), loadAdminEvents()]);
  toast(message);
}

$('#events-admin-link').addEventListener('click', (event) => {
  event.preventDefault();
  openAdmin().catch((error) => toast(error.message));
});
$('#events-admin-close').addEventListener('click', () => $('#events-admin-dialog').close());
$('#events-admin-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

$('#events-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#events-login-error');
  error.hidden = true;
  const email = $('#events-login-email').value.trim().toLowerCase();
  try {
    const challenge = await api(`/auth/password-salt?email=${encodeURIComponent(email)}`);
    const verifier = await passwordProof($('#events-login-password').value, challenge.salt);
    const result = await api('/auth/login', { method: 'POST', body: { email, passwordVerifier: verifier } });
    $('#events-login-password').value = '';
    await showAdminApp(result);
  } catch (loginError) {
    error.textContent = loginError.message;
    error.hidden = false;
  }
});

$('#events-logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST', body: {} });
  state.csrf = null;
  state.email = null;
  $('#events-admin-app').hidden = true;
  $('#events-admin-login').hidden = false;
});

$('#add-event-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const payload = { ...formPayload(form), status: 'scheduled' };
    await api('/admin/events', { method: 'POST', body: payload });
    form.reset();
    form.elements.location.value = 'Guild of Games, Rotherham';
    await refreshAfterChange('One-off event added.');
  } catch (error) { toast(error.message); }
});

$('#events-admin-app').addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-event-form]');
  if (!form) return;
  event.preventDefault();
  try {
    const recurring = form.dataset.recurring === 'true';
    const path = recurring ? `/admin/events/recurring/${form.dataset.id}` : `/admin/events/${form.dataset.id}`;
    await api(path, { method: 'PATCH', body: formPayload(form) });
    await refreshAfterChange(recurring ? 'Upcoming occurrence updated.' : 'Event updated.');
  } catch (error) { toast(error.message); }
});

$('#events-admin-app').addEventListener('click', async (event) => {
  const form = event.target.closest('[data-event-form]');
  if (!form) return;
  try {
    if (event.target.closest('[data-reset-override]')) {
      const date = form.elements.eventDate.value;
      await api(`/admin/events/recurring/${form.dataset.id}/override?date=${encodeURIComponent(date)}`, { method: 'DELETE' });
      await refreshAfterChange('This date now uses the recurring event defaults.');
    }
    if (event.target.closest('[data-delete-event]')) {
      if (!confirm('Delete this one-off event?')) return;
      await api(`/admin/events/${form.dataset.id}`, { method: 'DELETE' });
      await refreshAfterChange('One-off event deleted.');
    }
  } catch (error) { toast(error.message); }
});

loadEvents().catch((error) => {
  const message = `Upcoming events could not be loaded. ${escapeHtml(error.message)}`;
  renderEventGroup('#advanced-event-grid', [], message);
  renderEventGroup('#special-event-grid', [], message);
});

if (new URLSearchParams(location.search).get('admin') === 'events') {
  openAdmin().catch((error) => toast(error.message));
}
