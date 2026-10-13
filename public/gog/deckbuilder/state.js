export const ZONES = Object.freeze(['main', 'extra', 'side']);
export const SECTION_LIMITS = Object.freeze({ main: 60, extra: 15, side: 15 });

const clone = (value) => structuredClone(value);
const uuid = () => crypto.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const now = () => new Date().toISOString();

export function newDeck(name = 'Untitled deck') {
  const createdAt = now();
  return {
    schemaVersion: 1, id: uuid(), name: String(name).trim().slice(0, 100) || 'Untitled deck', revision: 0,
    createdAt, updatedAt: createdAt, formatId: 'gog-jush', lastCheckedVersionId: null,
    main: [], extra: [], side: [], groups: [], notes: '', originalImport: null
  };
}

export function instanceFromCard(card, originalImportId = null) {
  return {
    instanceId: uuid(), canonicalId: Number(card.canonicalId || card.id),
    artworkId: Number(card.artworkId || card.canonicalId || card.id),
    originalImportId: Number(originalImportId || card.canonicalId || card.id), resolution: 'resolved',
    name: String(card.name || ''), category: card.category || 'Monster', subtype: card.subtype || 'Effect',
    cardType: card.cardType || '', placement: card.placement || 'main', copyLimitKey: card.copyLimitKey || '',
    status: card.status || 'unlimited', allowedCopies: Number(card.copies ?? 3),
    attribute: card.attribute || null, race: card.race || null, level: card.level ?? null,
    linkRating: card.linkRating ?? null, pendulumScale: card.pendulumScale ?? null,
    atk: card.atk ?? null, def: card.def ?? null, description: card.description || ''
  };
}

export function unresolvedInstance(inputId, outcome = 'unknown_id') {
  return { instanceId: uuid(), canonicalId: null, artworkId: null, originalImportId: Number(inputId) || null,
    resolution: outcome, name: `Unresolved card ${inputId || ''}`.trim(), category: null, subtype: null,
    cardType: null, placement: null, copyLimitKey: `unresolved:${inputId}`, status: 'unverified', allowedCopies: 0,
    description: 'This imported entry could not be verified. It is retained so the deck can be repaired without data loss.' };
}

export const defaultZoneFor = (card) => card?.placement === 'extra' ? 'extra' : 'main';
export function copiesAcrossDeck(deck, copyLimitKey) {
  return ZONES.flatMap((zone) => deck[zone]).filter((instance) => instance.copyLimitKey === copyLimitKey).length;
}

export function addIssue(deck, card, zone) {
  if (!ZONES.includes(zone)) return 'Choose Main, Extra or Side.';
  if (!card || card.poolVerified === false || card.resolution && card.resolution !== 'resolved') return 'This card is not verified in the JUSH card pool.';
  if ((card.status || '') === 'forbidden' || Number(card.copies ?? card.allowedCopies) === 0) return `${card.name} is Forbidden in the published house list.`;
  if (zone !== 'side' && defaultZoneFor(card) !== zone)
    return `${card.name} belongs in the ${defaultZoneFor(card) === 'extra' ? 'Extra' : 'Main'} Deck.`;
  if (deck[zone].length >= SECTION_LIMITS[zone]) return `${zone === 'main' ? 'Main Deck' : zone === 'extra' ? 'Extra Deck' : 'Side Deck'} is full.`;
  const key = card.copyLimitKey || String(card.canonicalId || card.id);
  const allowed = Number(card.copies ?? card.allowedCopies ?? 3);
  if (copiesAcrossDeck(deck, key) >= allowed) return `${card.name} is limited to ${allowed} ${allowed === 1 ? 'copy' : 'copies'} across all three sections.`;
  return null;
}

function locate(deck, instanceId) {
  for (const zone of ZONES) {
    const index = deck[zone].findIndex((item) => item.instanceId === instanceId);
    if (index >= 0) return { zone, index, item: deck[zone][index] };
  }
  return null;
}

export function reduceDeck(deck, action) {
  const next = clone(deck);
  switch (action.type) {
    case 'ADD_INSTANCE': {
      if (!ZONES.includes(action.zone)) throw new Error('Invalid destination.');
      const index = Number.isInteger(action.index) ? Math.max(0, Math.min(action.index, next[action.zone].length)) : next[action.zone].length;
      next[action.zone].splice(index, 0, clone(action.instance));
      break;
    }
    case 'REMOVE_INSTANCE': {
      const found = locate(next, action.instanceId);
      if (!found) return deck;
      next[found.zone].splice(found.index, 1);
      break;
    }
    case 'MOVE_INSTANCE': {
      const found = locate(next, action.instanceId);
      if (!found || !ZONES.includes(action.zone)) return deck;
      const [item] = next[found.zone].splice(found.index, 1);
      const index = Number.isInteger(action.index) ? Math.max(0, Math.min(action.index, next[action.zone].length)) : next[action.zone].length;
      next[action.zone].splice(index, 0, item);
      break;
    }
    case 'REORDER_GROUP': {
      if (!ZONES.includes(action.zone)) return deck;
      const ids = new Set(action.instanceIds);
      const moving = next[action.zone].filter((item) => ids.has(item.instanceId));
      if (!moving.length) return deck;
      next[action.zone] = next[action.zone].filter((item) => !ids.has(item.instanceId));
      const index = Math.max(0, Math.min(action.index, next[action.zone].length));
      next[action.zone].splice(index, 0, ...moving);
      break;
    }
    case 'REORDER_INSTANCE': {
      const found = locate(next, action.instanceId);
      if (!found) return deck;
      const target = Math.max(0, Math.min(Number(action.index), next[found.zone].length - 1));
      const [item] = next[found.zone].splice(found.index, 1);
      next[found.zone].splice(target, 0, item);
      break;
    }
    case 'SORT_ZONE':
      if (!ZONES.includes(action.zone)) return deck;
      next[action.zone] = next[action.zone].map((item, index) => ({ item, index })).sort((a, b) =>
        String(a.item.category || '').localeCompare(String(b.item.category || '')) ||
        String(a.item.cardType || '').localeCompare(String(b.item.cardType || '')) ||
        String(a.item.name || '').localeCompare(String(b.item.name || '')) || a.index - b.index).map(({ item }) => item);
      break;
    case 'CLEAR_ZONE':
      if (!ZONES.includes(action.zone)) return deck;
      next[action.zone] = [];
      break;
    case 'RENAME_DECK':
      next.name = String(action.name || '').trim().slice(0, 100) || next.name;
      break;
    case 'SET_GROUPS':
      next.groups = clone(action.groups || []).slice(0, 20);
      break;
    case 'SET_NOTES':
      next.notes = String(action.notes || '').slice(0, 5000);
      break;
    case 'IMPORT_DECK':
    case 'RESTORE_SNAPSHOT':
      return clone(action.deck);
    default:
      throw new Error(`Unknown deck action: ${action.type}`);
  }
  next.revision = Number(deck.revision || 0) + 1;
  next.updatedAt = now();
  return next;
}

export class DeckHistory extends EventTarget {
  constructor(deck, limit = 100) {
    super(); this.deck = clone(deck); this.limit = Math.max(100, limit); this.past = []; this.future = [];
  }
  dispatch(action) {
    const next = reduceDeck(this.deck, action);
    if (next === this.deck) return false;
    this.past.push(clone(this.deck));
    if (this.past.length > this.limit) this.past.shift();
    this.future = []; this.deck = next; this.#change(action.type); return true;
  }
  replace(deck, record = false) {
    if (record) this.past.push(clone(this.deck)); else this.past = [];
    this.future = []; this.deck = clone(deck); this.#change('REPLACE');
  }
  refreshCardMetadata(results, versionId) {
    const byInput = new Map(results.map(result => [Number(result.inputId), result]));
    // Published metadata is not a deck edit. Refresh undo/redo snapshots too,
    // preserving physical copies, artwork, order, notes and save revisions.
    for (const deck of [this.deck, ...this.past, ...this.future]) {
      for (const zone of ZONES) for (const item of deck[zone]) {
        const result = byInput.get(Number(item.originalImportId || item.canonicalId));
        if (!result) continue;
        if (result.outcome === 'resolved' && result.card) {
          const metadata = instanceFromCard({ ...result.card,
            artworkId: item.artworkId || result.artworkId || result.card.artworkId }, item.originalImportId);
          Object.assign(item, metadata, { instanceId: item.instanceId });
        } else {
          item.resolution = result.outcome;
          item.status = 'unverified'; item.allowedCopies = 0;
        }
      }
    }
    this.deck.lastCheckedVersionId = versionId;
  }
  undo() {
    if (!this.past.length) return false;
    const revision = Number(this.deck.revision || 0) + 1;
    this.future.push(clone(this.deck)); this.deck = this.past.pop();
    this.deck.revision = revision; this.deck.updatedAt = now(); this.#change('UNDO'); return true;
  }
  redo() {
    if (!this.future.length) return false;
    const revision = Number(this.deck.revision || 0) + 1;
    this.past.push(clone(this.deck)); this.deck = this.future.pop();
    this.deck.revision = revision; this.deck.updatedAt = now(); this.#change('REDO'); return true;
  }
  #change(type) { this.dispatchEvent(new CustomEvent('change', { detail: { type, deck: this.deck } })); }
}

export function groupedCards(instances) {
  const groups = new Map();
  for (const instance of instances) {
    const key = instance.canonicalId || `unresolved:${instance.originalImportId}:${instance.instanceId}`;
    const group = groups.get(key) || { instance, count: 0, instanceIds: [] };
    group.count += 1; group.instanceIds.push(instance.instanceId); groups.set(key, group);
  }
  return [...groups.values()];
}

export function portableDeck(deck) {
  return Object.fromEntries(ZONES.map((zone) => [zone, deck[zone].map((item) => {
    const id = Number(item.canonicalId || item.originalImportId);
    if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) throw new Error(`${item.name || 'An entry'} has no portable numeric ID.`);
    return id;
  })]));
}
