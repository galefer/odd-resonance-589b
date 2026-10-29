import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  applyTemplatePresentation, filterTemplates, normaliseTemplateManifest, templateFacets
} from '../../public/gog/deckbuilder/templates.js';

const readJson = async (url) => JSON.parse(await readFile(url, 'utf8'));
const manifest = normaliseTemplateManifest(await readJson(new URL('../../public/gog/deckbuilder/template-decks.json', import.meta.url)));
const presentation = await readJson(new URL('../../public/gog/deckbuilder/template-presentation.json', import.meta.url));
const catalogue = applyTemplatePresentation(manifest, presentation);

assert.equal(catalogue.decks.length, 397);
assert.equal(Object.keys(presentation.decks).length, 397);

const buildCounts = Object.groupBy(catalogue.decks, (deck) => deck.buildCategory);
assert.deepEqual(Object.fromEntries(Object.entries(buildCounts).map(([key, decks]) => [key, decks.length])), {
  'Source-adapted': 145,
  Experimental: 41,
  Reconstructed: 211
});

const facets = templateFacets(catalogue.decks);
assert(facets.engines.length >= 140, 'Engine discovery should cover the complete mixed catalogue');
assert(facets.tags.length >= 15, 'Useful playstyle and mechanic tags should replace difficulty');
assert(facets.tags.some(({ value }) => value === 'Midrange'));
assert(facets.tags.some(({ value }) => value === 'Fusion'));
assert(facets.tags.some(({ value }) => value === 'Going second'));
assert(!facets.tags.some(({ value }) => /Beginner|Intermediate|Advanced/.test(value)));

const names = new Set(catalogue.decks.flatMap((deck) => [deck.name, deck.family, ...deck.engines]).map((value) => value.toLocaleLowerCase()));
assert(!facets.tags.some(({ value }) => names.has(value.toLocaleLowerCase())), 'Deck and engine names do not leak into the tag facet');

for (const deck of catalogue.decks) {
  assert(deck.family && deck.engines.length && deck.buildCategory);
  assert(['main', 'extra'].some((zone) => deck[zone].some((card) => card.id === deck.coverCardId)), `${deck.id} cover belongs to the deck`);
}

for (const id of ['naturia', 'naturia-runick', 'naturia-vernusylph', 'naturia-ragnaraika']) {
  const deck = catalogue.decks.find((candidate) => candidate.id === id);
  assert.equal(deck.main.find((card) => card.id === 3734202)?.count, 3, `${id} uses three Naturia Sacred Tree`);
  assert.equal(deck.main.reduce((total, card) => total + card.count, 0), 40, `${id} remains a 40-card Main Deck`);
}

assert.equal(presentation.decks.mitsurugi.coverCardId, presentation.decks['mitsurugi-fiendsmith'].coverCardId, 'Variants reuse a family cover when present');
assert(filterTemplates(catalogue.decks, { query: 'Ame no Habakiri' }).some((deck) => deck.id === 'mitsurugi'));
assert(filterTemplates(catalogue.decks, { query: 'PUNK' }).some((deck) => deck.id === 'punk'));
assert(filterTemplates(catalogue.decks, { query: 'Blue Eyes' }).some((deck) => deck.id === 'blue-eyes'));
assert(filterTemplates(catalogue.decks, { engines: ['Fiendsmith'], tags: ['Fusion'] }).every((deck) => deck.engines.includes('Fiendsmith') && deck.filterTags.includes('Fusion')));

console.log(JSON.stringify({
  decks: catalogue.decks.length,
  families: new Set(catalogue.decks.map((deck) => deck.family)).size,
  engines: facets.engines.length,
  tags: facets.tags.length,
  covers: new Set(catalogue.decks.map((deck) => deck.coverCardId)).size,
  buildCounts: Object.fromEntries(Object.entries(buildCounts).map(([key, decks]) => [key, decks.length]))
}, null, 2));
