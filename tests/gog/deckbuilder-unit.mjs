import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DeckFormatError, encodeYdk, encodeYdke, parseYdk, parseYdke } from '../../public/gog/deckbuilder/deck-codecs.js';
import { DeckHistory, addIssue, groupedCards, instanceFromCard, newDeck, portableDeck, reduceDeck, unresolvedInstance } from '../../public/gog/deckbuilder/state.js';
import { makeBackup, parseBackup, sanitiseDeck } from '../../public/gog/deckbuilder/persistence.js';
import { atLeast, atLeastOne, atLeastOneFromBoth } from '../../public/gog/deckbuilder/probability.js';
import { validationKey, remapValidation } from '../../public/gog/deckbuilder/validation.js';
import { filterTemplates, normaliseTemplateManifest, templateTags, templateZoneCount, templateZoneIds } from '../../public/gog/deckbuilder/templates.js';

if (!globalThis.CustomEvent) globalThis.CustomEvent = class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } };

const fixtures = new URL('./fixtures/', import.meta.url);
const golden = JSON.parse(readFileSync(new URL('encoding-golden.json', fixtures), 'utf8'));
const card = (overrides = {}) => ({
  id: 1001, canonicalId: 1001, artworkId: 1001, name: 'Fixture Main Effect', category: 'Monster',
  subtype: 'Effect', cardType: 'Effect Monster', placement: 'main', copyLimitKey: '1001',
  status: 'unlimited', copies: 3, poolVerified: true, ...overrides
});

test('validation identity ignores order and presentation but includes quantities, sections and input IDs', () => {
  const deck = newDeck();
  deck.main = [instanceFromCard(card()), instanceFromCard(card({canonicalId:2002}))];
  const reordered = structuredClone(deck);
  reordered.main.reverse(); reordered.name='Renamed'; reordered.notes='Notes'; reordered.groups=[{name:'A'}];
  assert.equal(validationKey(deck),validationKey(reordered));
  const moved = structuredClone(deck); moved.side.push(moved.main.pop());
  assert.notEqual(validationKey(deck),validationKey(moved));
  const added = structuredClone(deck); added.main.push(instanceFromCard(card()));
  assert.notEqual(validationKey(deck),validationKey(added));
  const alternate = structuredClone(deck); alternate.main[0].originalImportId=9001;
  assert.notEqual(validationKey(deck),validationKey(alternate));
});

test('validation warnings and card results follow reordered input IDs, including unresolved and duplicate cards', () => {
  const source = newDeck();
  source.main = [instanceFromCard(card()), unresolvedInstance(999), instanceFromCard(card())];
  const target = structuredClone(source); target.main=[target.main[2],target.main[0],target.main[1]];
  const result = {verified:true,legal:false,issues:[{zone:'main',index:1,code:'unknown_id'},{zone:'main',code:'deck_size'}],cards:source.main.map((_,index)=>({zone:'main',index}))};
  const remapped = remapValidation(result,source,target);
  assert.equal(remapped.issues[0].index,2);
  assert.equal(remapped.issues[1].index,undefined);
  assert.deepEqual(remapped.cards.map(item=>item.index),[0,2,1]);
  assert.equal(result.issues[0].index,1);
  target.main.pop();
  assert.throws(()=>remapValidation(result,source,target),/contents changed/);
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

test('stored copy allowances survive normalization and rapid additions across sections', () => {
  let deck = newDeck('Semi-limited copies');
  const semiLimited = card({ status: 'semi_limited', copies: undefined, allowedCopies: 2 });
  const first = instanceFromCard(semiLimited);
  assert.equal(first.allowedCopies, 2, 'a stored instance keeps its authoritative allowance when copied');
  deck = reduceDeck(deck, { type: 'ADD_INSTANCE', zone: 'main', instance: first });
  assert.equal(addIssue(deck, first, 'side'), null);
  const second = instanceFromCard(first);
  assert.equal(second.allowedCopies, 2);
  deck = reduceDeck(deck, { type: 'ADD_INSTANCE', zone: 'side', instance: second });
  assert.match(addIssue(deck, first, 'main'), /limited to 2 copies/, 'a third immediate addition is blocked across sections');
});

test('published metadata refresh repairs saved badges and limits without changing deck edits or undo', () => {
  const deck = newDeck('Saved while Limited');
  deck.notes = 'Keep these notes'; deck.groups = [{ id: 'group', name: 'Starters', canonicalIds: [1001] }];
  const first = instanceFromCard(card({ status: 'limited', copies: 1, artworkId: 9001 }), 9001);
  deck.main = [first];
  const history = new DeckHistory(deck);
  history.dispatch({ type: 'MOVE_INSTANCE', instanceId: first.instanceId, zone: 'side' });
  history.undo();
  const before = structuredClone(history.deck);
  const pastLength = history.past.length, futureLength = history.future.length;
  history.refreshCardMetadata([{ inputId: 9001, outcome: 'resolved', card: card(), artworkId: 9001 }], 7);
  assert.equal(history.deck.main[0].status, 'unlimited');
  assert.equal(history.deck.main[0].allowedCopies, 3);
  assert.equal(history.deck.main[0].instanceId, first.instanceId);
  assert.equal(history.deck.main[0].artworkId, 9001);
  assert.equal(history.deck.main[0].originalImportId, 9001);
  assert.equal(history.deck.revision, before.revision);
  assert.equal(history.deck.updatedAt, before.updatedAt);
  assert.equal(history.deck.notes, before.notes);
  assert.deepEqual(history.deck.groups, before.groups);
  assert.equal(history.past.length, pastLength); assert.equal(history.future.length, futureLength);
  assert.equal(addIssue(history.deck, history.deck.main[0], 'side'), null);
  history.redo();
  assert.equal(history.deck.side[0].status, 'unlimited');
  history.undo();
  assert.equal(history.deck.main[0].status, 'unlimited');
  history.refreshCardMetadata([{ inputId: 9001, outcome: 'resolved', card: card({ status: 'forbidden', copies: 0 }) }], 8);
  assert.equal(history.deck.main.length, 1, 'A new restriction must not remove deck copies');
  assert.match(addIssue(history.deck, history.deck.main[0], 'side'), /Forbidden/);
  history.redo(); assert.equal(history.deck.side[0].status, 'forbidden');
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
  const savedRevision = history.deck.revision;
  assert.deepEqual(history.deck.main.map(c => c.instanceId), [b.instanceId, a.instanceId, a2.instanceId]);
  assert(history.undo());
  assert.deepEqual(history.deck.main.map(c => c.instanceId), [a.instanceId, b.instanceId, a2.instanceId]);
  assert.equal(history.deck.revision,savedRevision+1, 'Undo remains newer than an autosaved revision');
  assert(history.redo());
  assert.equal(history.deck.revision,savedRevision+2, 'Redo remains newer than its autosaved undo');
  assert.equal(history.deck.id,deck.id);
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

test('template catalogue normalises, searches card names and expands physical copies by zone', () => {
  const manifest = normaliseTemplateManifest({ schemaVersion: 1, format: 'gog-jush', decks: [{
    id: 'fixture-control', name: 'Fixture Control', description: 'A patient control deck.', difficulty: 'Beginner',
    tags: ['Control', 'House JUSH'], notes: 'Hold interaction for the right moment.',
    main: [{ id: 1001, name: 'Fixture Main Effect', count: 3 }],
    extra: [{ id: 2002, name: 'Fixture Fusion', count: 1 }], side: []
  }, {
    id: 'fixture-combo', name: 'Fixture Combo', description: 'A fast combo deck.', difficulty: 'Advanced',
    tags: ['Combo', 'House JUSH'], notes: 'Sequence carefully.', main: [{ id: 3003, name: 'Hidden Search Target', count: 2 }], extra: [], side: []
  }] });
  assert.equal(manifest.decks.length, 2);
  assert.equal(templateZoneCount(manifest.decks[0], 'main'), 3);
  assert.deepEqual(templateZoneIds(manifest.decks[0], 'main'), [1001, 1001, 1001]);
  assert.deepEqual(filterTemplates(manifest.decks, { query: 'hidden target' }).map(deck => deck.id), ['fixture-combo']);
  assert.deepEqual(filterTemplates(manifest.decks, { difficulty: 'Beginner', tag: 'Control' }).map(deck => deck.id), ['fixture-control']);
  assert.deepEqual(templateTags(manifest.decks), ['Combo', 'Control', 'House JUSH']);
});

test('template catalogue rejects malformed or duplicated data before rendering it', () => {
  const deck = { id: 'same', name: 'Same', description: 'Description', difficulty: 'Advanced', tags: ['Tag'], notes: 'Notes', main: [], extra: [], side: [] };
  assert.throws(() => normaliseTemplateManifest({ schemaVersion: 1, format: 'gog-jush', decks: [deck, deck] }), /duplicated/);
  assert.throws(() => normaliseTemplateManifest({ schemaVersion: 2, format: 'gog-jush', decks: [deck] }), /not a supported/);
});
