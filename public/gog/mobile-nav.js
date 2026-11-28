import { artUrl } from './duel/common.js';

// A tab reopened from an earlier release can still have the old HTML.
if (!window.JushTabs) {
  await import('./tab-shell.js');
  window.JushTabs.mount();
}
const shell = window.JushTabs;
export function renderAccount(player) {
  shell.rememberBadge(player ? { name: player.name, src: player.art ? artUrl(player.art) : '' } : null);
}
export function accountChanged(signedOut = false) {
  ++inboxRequest;
  shell.accountChanged();
  if (signedOut) renderAccount(null);
}

let inboxRequest = 0;
export function refreshInbox() {
  const request = ++inboxRequest, generation = shell.generation();
  return fetch('/gog/api/community/app/inbox', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || request !== inboxRequest || generation !== shell.generation()) return;
      if ('player' in data) renderAccount(data.player);
      const duel = document.querySelector('.j-app-nav a[href^="/gog/duel/"]');
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
  window.addEventListener('jush-account-changed', refreshInbox);
  window.addEventListener('pageshow', (event) => { if (event.persisted) refreshInbox(); });
}
if ('serviceWorker' in navigator)
  navigator.serviceWorker.register('/gog/sw.js', { scope: '/gog/' }).catch(() => {});
