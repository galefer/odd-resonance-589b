import { api, esc } from '../../duel/common.js';
import { DeckDatabase } from '../persistence.js';
import { newDeck, instanceFromCard, unresolvedInstance, ZONES } from '../state.js';
const $ = (id) => document.getElementById(id);
let deck,
  saved = false;
async function load() {
  const id = new URLSearchParams(location.search).get('id'),
    data = await api('deck?share=' + encodeURIComponent(id || '')),
    ids = [...new Set(ZONES.flatMap((z) => data.zones[z]))];
  const response = await fetch('/gog/api/cards/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) throw Error('Could not load the card list. Refresh to try again.');
  const resolved = new Map((await response.json()).results.map((r) => [Number(r.inputId), r]));
  deck = newDeck(data.name);
  $('title').textContent = data.name;
  $('deck').innerHTML = ZONES.map((z) => {
    deck[z] = data.zones[z].map((id) => {
      const r = resolved.get(id);
      return r?.outcome === 'resolved'
        ? instanceFromCard({ ...r.card, artworkId: r.artworkId || id }, id)
        : unresolvedInstance(id, r?.outcome);
    });
    return (
      '<section><h2>' +
      z[0].toUpperCase() +
      z.slice(1) +
      ' · ' +
      deck[z].length +
      '</h2><div class="shared-cards">' +
      deck[z]
        .map(
          (c) =>
            '<figure><img loading="lazy" src="/gog/api/cards/' +
            (c.artworkId || c.originalImportId) +
            '/image?size=thumb" alt=""><figcaption>' +
            esc(c.name) +
            '</figcaption></figure>',
        )
        .join('') +
      '</div></section>'
    );
  }).join('');
  $('copy').hidden = false;
}
$('copy').onclick = async () => {
  const b = $('copy');
  b.disabled = true;
  try {
    const db = await new DeckDatabase().open();
    if (!saved) {
      await db.save(deck);
      saved = true;
    }
    await db.setCurrentId(deck.id);
    location.assign('/gog/deckbuilder/');
  } catch (e) {
    $('error').textContent = e.message;
    b.disabled = false;
  }
};
load().catch((e) => {
  $('deck').textContent = '';
  $('error').textContent = e.message;
});
