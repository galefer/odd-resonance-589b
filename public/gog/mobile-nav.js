import { artUrl } from './duel/common.js';

const tabs = [
  ['Home', '/gog/', 'house'],
  ['Cards', '/gog/cards/', 'layers'],
  ['Voting', '/gog/voting/', 'vote'],
  ['Duel', '/gog/duel/', 'swords'],
  ['Builder', '/gog/deckbuilder/', 'panels-top-left'],
];
const nav = document.createElement('nav');
nav.className = 'j-app-nav';
nav.ariaLabel = 'JUSH navigation';
for (const [label, path, icon] of tabs) {
  const a = document.createElement('a');
  a.href = path;
  a.textContent = label.toUpperCase();
  const pic = document.createElement('i');
  pic.ariaHidden = 'true';
  pic.style.setProperty('--nav-icon', 'url("/gog/assets/app/' + icon + '.svg")');
  a.prepend(pic);
  if (
    path === '/gog/'
      ? location.pathname === path
      : location.pathname.startsWith(path) ||
        (label === 'Cards' && location.pathname.startsWith('/gog/house-format/'))
  )
    a.setAttribute('aria-current', 'page');
  nav.append(a);
}
const header = document.querySelector('body>header');
if (header) header.after(nav);
else document.body.prepend(nav);
document.body.classList.add('j-nav-ready');
export function renderAccount(player) {
  const link = header?.querySelector('.j-account');
  if (!link) return;
  if (!player) {
    link.href = '/gog/voting/?return=account#account';
    link.textContent = 'Sign in';
    link.removeAttribute('aria-label');
    link.classList.remove('has-player');
    return;
  }
  link.href = '/gog/duel/?profile=me';
  const label = 'Account for ' + player.name;
  const src = player.art ? artUrl(player.art) : '';
  if (link.ariaLabel === label && link.dataset.art === src) return;
  link.ariaLabel = label;
  link.dataset.art = src;
  link.classList.add('has-player');
  const portrait = document.createElement('span');
  portrait.className = 'j-account-portrait';
  portrait.ariaHidden = 'true';
  portrait.textContent = Array.from(player.name.trim())[0]?.toUpperCase() || '?';
  if (src) {
    const img = document.createElement('img');
    img.alt = '';
    img.addEventListener('error', () => img.remove(), { once: true });
    img.src = src;
    portrait.append(img);
  }
  link.replaceChildren(portrait);
}

function refreshInbox() {
  fetch('/gog/api/community/app/inbox', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data) return;
      if ('player' in data) renderAccount(data.player);
      const duel = nav.querySelector('a[href^="/gog/duel/"]');
      duel.querySelector('.j-inbox-count')?.remove();
      duel.href = data.pending ? '/gog/duel/?inbox=1' : '/gog/duel/';
      duel.removeAttribute('aria-label');
      if (data.pending) {
        duel.setAttribute('aria-label', 'Duel · ' + data.pending + ' pending approvals');
        const badge = document.createElement('span');
        badge.className = 'j-inbox-count';
        badge.textContent = data.pending;
        duel.append(badge);
      }
    })
    .catch(() => {});
}
if (!location.pathname.startsWith('/gog/duel/')) {
  refreshInbox();
  window.addEventListener('pageshow', (event) => { if (event.persisted) refreshInbox(); });
}
if ('serviceWorker' in navigator)
  navigator.serviceWorker.register('/gog/sw.js', { scope: '/gog/' }).catch(() => {});
