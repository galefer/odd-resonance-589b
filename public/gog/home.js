const API_BASE = '/gog/api';
const $ = (selector, root = document) => root.querySelector(selector);
const state = { csrf: null, email: null, events: [] };
const EVENT_CACHE_KEY = 'gog-jush-event-schedule-v1';
let eventRefreshTimer = 0;
let eventsLoadedAt = 0;

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
      ${artwork?.theme === 'house' ? '<a class="event-link" href="/gog/">Explore the house rules <span aria-hidden="true">→</span></a>' : ''}
    </div>
  </article>`;
}

function renderEventGroup(selector, events, emptyMessage) {
  const grid = $(selector);
  grid.setAttribute('aria-busy', 'false');
  grid.innerHTML = events.length ? events.map(eventCard).join('') : `<p class="empty-events">${emptyMessage}</p>`;
}

function eventDisplayDate(value) {
  if (!value) return 'Schedule to be confirmed';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(`${value}T12:00:00Z`)).toUpperCase();
}

function londonClock() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function eventHasFinished(event) {
  const now = londonClock();
  if (event.eventDate < now.date) return true;
  if (event.eventDate > now.date) return false;
  return !!event.endTime && now.time >= event.endTime;
}

function isJushEvent(event) {
  return event.slug === 'yugioh-house-friday' || /\b(jush|house format)\b/i.test(`${event.title || ''} ${event.description || ''}`);
}

function londonWallTimeInstant(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  let instant = Date.UTC(year, month - 1, day, hour, minute);
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(instant)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    instant += Date.UTC(year, month - 1, day, hour, minute) - represented;
  }
  return instant;
}

function scheduleEventBoundaryRefresh(event) {
  clearTimeout(eventRefreshTimer);
  if (!event?.eventDate || !event?.endTime) return;
  const delay = londonWallTimeInstant(event.eventDate, event.endTime) - Date.now() + 1000;
  if (delay <= 0) return;
  eventRefreshTimer = setTimeout(() => loadEvents().catch(renderEventUnavailable), Math.min(delay, 2_147_000_000));
}

function renderEventUnavailable(error) {
  $('#next-event-date').textContent = 'Schedule unavailable';
  $('#next-event-date').removeAttribute('datetime');
  $('#next-event-time').textContent = 'Event details could not be loaded';
  $('#next-event-location').textContent = 'Guild of Games, Rotherham';
  $('#next-event-status').textContent = error?.message ? `Schedule service unavailable: ${error.message}` : 'Schedule service unavailable.';
  $('#next-event-status').hidden = false;
}

function renderNextJushEvent(events, cached = false) {
  const event = events
    .filter((item) => isJushEvent(item) && item.status !== 'cancelled' && !eventHasFinished(item))
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate) || (a.startTime || '99:99').localeCompare(b.startTime || '99:99'))[0];
  if (!event) {
    $('#next-event-date').textContent = 'Schedule to be confirmed';
    $('#next-event-date').removeAttribute('datetime');
    $('#next-event-time').textContent = 'No upcoming JUSH date is currently published';
    $('#next-event-location').textContent = 'Guild of Games, Rotherham';
    $('#next-event-status').textContent = cached ? 'Showing the last known schedule state.' : '';
    $('#next-event-status').hidden = !cached;
    return;
  }
  $('#next-event-date').textContent = eventDisplayDate(event.eventDate);
  $('#next-event-date').dateTime = event.eventDate;
  $('#next-event-time').textContent = displayTime(event.startTime) + (event.endTime ? `–${displayTime(event.endTime)}` : '');
  $('#next-event-location').textContent = event.location || 'Guild of Games, Rotherham';
  $('#next-event-status').textContent = cached ? 'Live schedule unavailable; showing the last known event.' : '';
  $('#next-event-status').hidden = !cached;
  scheduleEventBoundaryRefresh(event);
}

async function loadEvents() {
  let payload;
  let cached = false;
  try {
    payload = await api('/events');
    try { sessionStorage.setItem(EVENT_CACHE_KEY, JSON.stringify(payload)); } catch {}
  } catch (error) {
    let saved = null;
    try { saved = sessionStorage.getItem(EVENT_CACHE_KEY); } catch {}
    if (!saved) throw error;
    payload = JSON.parse(saved);
    cached = true;
  }
  state.events = payload.events || [];
  eventsLoadedAt = Date.now();
  renderNextJushEvent(state.events, cached);
}

loadEvents().catch(renderEventUnavailable);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - eventsLoadedAt > 60_000) {
    loadEvents().catch(renderEventUnavailable);
  }
});

