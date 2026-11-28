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
if (!location.pathname.startsWith('/gog/duel/')) {
  const duel = nav.querySelector('[href="/gog/duel/"]');
  fetch('/gog/api/community/app/inbox', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.pending) {
        duel.href = '/gog/duel/?inbox=1';
        duel.setAttribute('aria-label', 'Duel · ' + data.pending + ' pending approvals');
        const badge = document.createElement('span');
        badge.className = 'j-inbox-count';
        badge.textContent = data.pending;
        duel.append(badge);
      }
    })
    .catch(() => {});
}
if ('serviceWorker' in navigator)
  navigator.serviceWorker.register('/gog/sw.js', { scope: '/gog/' }).catch(() => {});
