import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DeckFormatError, encodeYdk, encodeYdke, parseYdk, parseYdke } from '../../public/gog/deckbuilder/deck-codecs.js';
import { DeckHistory, addIssue, groupedCards, instanceFromCard, newDeck, portableDeck, reduceDeck, unresolvedInstance } from '../../public/gog/deckbuilder/state.js';
import { makeBackup, parseBackup, sanitiseDeck } from '../../public/gog/deckbuilder/persistence.js';
import { atLeast, atLeastOne, atLeastOneFromBoth } from '../../public/gog/deckbuilder/probability.js';

if (!globalThis.CustomEvent) globalThis.CustomEvent = class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } };

const fixtures = new URL('./fixtures/', import.meta.url);
const golden = JSON.parse(readFileSync(new URL('encoding-golden.json', fixtures), 'utf8'));
const card = (overrides = {}) => ({
  id: 1001, canonicalId: 1001, artworkId: 1001, name: 'Fixture Main Effect', category: 'Monster',
  subtype: 'Effect', cardType: 'Effect Monster', placement: 'main', copyLimitKey: '1001',
  status: 'unlimited', copies: 3, poolVerified: true, ...overrides
});

test('YDKE fixed vectors preserve endian, unsigned IDs, zones and duplicates', () => {
  for (const fixture of golden) {
    assert.equal(encodeYdke(fixture.deck), fixture.ydke, fixture.name);
    assert.deepEqual(parseYdke(fixture.ydke).deck, fixture.deck, fixture.name);
  }
});

test('YDK preserves repeated physical copies, comments, BOM and all sections', () => {
  const input = '\uFEFF#created by someone\r\n#main\r\n1001\r\n# a name comment\r\n1001\r\n#extra\r\n2002\r\n!side\r\n1001\r\n';
  const parsed = parseYdk(input);
  assert.deepEqual(parsed.deck, { main: [1001, 1001], extra: [2002], side: [1001] });
  assert.deepEqual(parseYdk(encodeYdk(parsed.deck)).deck, parsed.deck);
});

test('malformed YDK and YDKE fail with useful codes and source lines', () => {
  assert.throws(() => parseYdk('#main\nnot-an-id\n'), (error) => error instanceof DeckFormatError && error.code === 'INVALID_TOKEN' && error.line === 2);
  assert.throws(() => parseYdke('ydke://AAAAA!x!!'), (error) => error instanceof DeckFormatError && error.code === 'BAD_BASE64');
  assert.throws(() => parseYdke('omega://anything'), (error) => error instanceof DeckFormatError && error.code === 'NOT_YDKE');
});

test('physical copies enforce one combined limit across Main, Extra and Side', () => {
  let deck = newDeck('Copies');
  const limited = card({ status: 'limited', copies: 1, allowedCopies: 1 });
  deck = reduceDeck(deck, { type: 'ADD_INSTANCE', zone: 'main', instance: instanceFromCard(limited) });
  assert.match(addIssue(deck, limited, 'side'), /limited to 1 copy/);
  const ordinary = card();
  assert.equal(addIssue(deck, ordinary, 'main'), null);
});

test('move/reorder/remove, grouped view and 100-step undo retain instance identity', () => {
  const deck = newDeck('History');
  const first = instanceFromCard(card()), second = instanceFromCard(card());
  const history = new DeckHistory(deck, 100);
  history.dispatch({ type: 'ADD_INSTANCE', zone: 'main', instance: first });
  history.dispatch({ type: 'ADD_INSTANCE', zone: 'main', instance: second });
  history.dispatch({ type: 'MOVE_INSTANCE', instanceId: first.instanceId, zone: 'side' });
  assert.equal(history.deck.side[0].instanceId, first.instanceId);
  assert.equal(groupedCards(history.deck.main.concat(history.deck.side))[0].count, 2);
  assert(history.undo()); assert.equal(history.deck.main[0].instanceId, first.instanceId);
  assert(history.redo()); assert.equal(history.deck.side[0].instanceId, first.instanceId);
  history.dispatch({ type: 'REMOVE_INSTANCE', instanceId: first.instanceId });
  assert(history.undo()); assert.equal(history.deck.side[0].instanceId, first.instanceId);
});

test('wrong-section additions are blocked but Side accepts either placement', () => {
  const deck = newDeck();
  const fusion = card({ id: 2001, canonicalId: 2001, name: 'Fusion fixture', cardType: 'Fusion Monster', subtype: 'Fusion', placement: 'extra', copyLimitKey: '2001' });
  assert.match(addIssue(deck, fusion, 'main'), /belongs in the Extra Deck/);
  assert.equal(addIssue(deck, fusion, 'extra'), null);
  assert.equal(addIssue(deck, fusion, 'side'), null);
});

test('reordering a grouped stack keeps every copy together and undo restores interleaved order', () => {
  const a = instanceFromCard(card()), b = instanceFromCard(card({ canonicalId: 2002 })), a2 = instanceFromCard(card());
  const deck = newDeck(); deck.main = [a, b, a2];
  const history = new DeckHistory(deck);
  history.dispatch({ type: 'REORDER_GROUP', zone: 'main', instanceIds: [a.instanceId, a2.instanceId], index: 1 });
  assert.deepEqual(history.deck.main.map(c => c.instanceId), [b.instanceId, a.instanceId, a2.instanceId]);
  assert(history.undo());
  assert.deepEqual(history.deck.main.map(c => c.instanceId), [a.instanceId, b.instanceId, a2.instanceId]);
});

test('unresolved imports remain visible and portable when their numeric ID is retained', () => {
  const deck = newDeck(); deck.main.push(unresolvedInstance(4_000_000_000, 'unknown_id'));
  assert.equal(deck.main.length, 1);
  assert.deepEqual(portableDeck(deck).main, [4_000_000_000]);
});

test('JSON backup whitelists data, ignores forged legality and restores fresh identities', () => {
  const deck = newDeck('<img src=x onerror=alert(1)>'); deck.isLegal = true; deck.main.push(instanceFromCard(card()));
  const backup = makeBackup([deck]);
  assert.equal('isLegal' in backup.decks[0], false);
  const [restored] = parseBackup(JSON.stringify(backup));
  assert.notEqual(restored.id, deck.id); assert.equal(restored.main.length, 1);
  assert.equal('isLegal' in sanitiseDeck({ ...deck, isLegal: true }), false);
});

test('probability helpers cover zero/all hits, thresholds and overlapping groups', () => {
  assert.equal(atLeastOne(40, 0, 5), 0);
  assert.equal(atLeastOne(40, 40, 5), 1);
  assert(Math.abs(atLeastOne(40, 3, 5) - 0.3375506073) < 1e-9);
  assert(atLeast(40, 3, 5, 2) > 0);
  assert.equal(atLeast(40, 3, 5, 4), 0);
  const both = atLeastOneFromBoth(40, 6, 5, 2, 5);
  assert(both >= 0 && both <= 1);
  assert.throws(() => atLeastOne(4, 2, 5), RangeError);
});
