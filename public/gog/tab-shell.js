(() => {
  const tabs = [
    ['Home', '/gog/', 'house'],
    ['Cards', '/gog/cards/', 'layers'],
    ['Voting', '/gog/voting/', 'vote'],
    ['Duel', '/gog/duel/', 'swords'],
    ['Builder', '/gog/deckbuilder/', 'panels-top-left'],
  ];
  const tabPath = (path) => path.replace(/(?:\/index\.html|\/)?$/, '/');
  const pagePath = tabPath(location.pathname);
  const tab = tabs.find(([, path]) => path === pagePath);
  const badgeKey = 'jush-tab-badge-v1';
  const sessionKey = 'jush-account-generation';
  let header;

  function generation() {
    try { return localStorage.getItem(sessionKey); } catch { return null; }
  }

  // Only the public display name and portrait are kept for the next navigation.
  function restoreBadge() {
    let player;
    try {
      const saved = JSON.parse(sessionStorage.getItem(badgeKey));
      if (saved && saved.generation === generation() && Date.now() < saved.until) {
        if (saved.player === null) player = null;
        else if (typeof saved.player.name === 'string' &&
          (saved.player.src === '' || /^\/gog\/api\/cards\/\d+\/image\?size=cover&purpose=profile$/.test(saved.player.src))) {
          player = saved.player;
        }
      }
    } catch {}
    paintAccount(player);
  }
  function rememberBadge(player) {
    try {
      sessionStorage.setItem(badgeKey, JSON.stringify({ player, generation: generation(), until: Date.now() + 300000 }));
    } catch {}
    paintAccount(player);
  }
  function accountChanged() {
    try { localStorage.setItem(sessionKey, crypto.randomUUID()); } catch {}
    try { sessionStorage.removeItem(badgeKey); } catch {}
    restoreBadge();
  }

  function paintAccount(player) {
    const link = header?.querySelector('.j-account');
    if (!link) return;
    if (player == null) {
      link.href = player === null ? '/gog/voting/?return=account#account' : '/gog/duel/?profile=me';
      link.textContent = player === null ? 'Sign in' : 'Account';
      link.removeAttribute('aria-label');
      link.classList.remove('has-player');
      return;
    }
    link.href = '/gog/duel/?profile=me';
    const label = 'Account for ' + player.name;
    const src = player.src;
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

  function mount() {
    const nav = document.createElement('nav');
    nav.className = 'j-app-nav';
    nav.ariaLabel = 'JUSH navigation';
    header = document.querySelector('body > header');
    if (header && tab) {
      header.classList.add('j-tab-head');
      const brand = document.createElement('div');
      brand.className = 'j-mobile-brand';
      brand.innerHTML = '<a href="/gog/" aria-label="Guild of Games home"><img src="/gog/assets/jush/artwork/guild-of-games-logo-64.webp" width="32" height="32" alt=""></a>';
      const title = document.createElement('span');
      title.textContent = tab[0];
      brand.append(title);
      header.prepend(brand);
      if (!header.querySelector('.j-account')) {
        const link = document.createElement('a');
        link.className = 'j-account j-mobile-account';
        link.href = '/gog/duel/?profile=me';
        link.textContent = 'Account';
        header.append(link);
      }
    }
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
          ? pagePath === path
          : pagePath.startsWith(path) ||
            (label === 'Cards' && pagePath.startsWith('/gog/house-format/'))
      )
        a.setAttribute('aria-current', 'page');
      nav.append(a);
    }
    if (header) header.after(nav);
    else document.body.prepend(nav);
    const deckTools = document.querySelector('body.deckbuilder-page > .deck-toolbar');
    if (header && deckTools) {
      const phone = matchMedia('(max-width: 800px)');
      const account = header.querySelector('.j-account');
      function placeDeckTools() {
        if (phone.matches) account.before(deckTools);
        else nav.after(deckTools);
      }
      placeDeckTools();
      phone.addEventListener('change', placeDeckTools);
    }
    document.body.classList.add('j-nav-ready');
    restoreBadge();
  }

  // Keep the outgoing frame until the incoming tab has drawn its first content.
  // CSS bounds the wait even if a request stalls or the tab script fails.
  let ready = false, transition;
  function contentReady() {
    ready = true;
    transition?.skipTransition();
  }
  window.addEventListener('pagereveal', (event) => {
    transition = event.viewTransition;
    if (!transition) return;
    // Skipping before the snapshots are ready rejects ready with AbortError.
    transition.ready.catch(() => {});
    const from = window.navigation?.activation?.from?.url || document.referrer;
    if (!tab || !from || !tabs.some(([, path]) => path === tabPath(new URL(from).pathname)) || ready) {
      transition.skipTransition();
    }
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) restoreBadge(); });
  window.addEventListener('storage', (event) => {
    if (event.key === sessionKey || event.key === null) {
      restoreBadge();
      window.dispatchEvent(new Event('jush-account-changed'));
    }
  });
  window.JushTabs = { mount, rememberBadge, accountChanged, generation, contentReady };
})();
