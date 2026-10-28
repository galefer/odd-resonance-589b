import { ZONES } from './state.js';

export const TEMPLATE_DIFFICULTIES = Object.freeze(['Beginner', 'Intermediate', 'Advanced']);
export const TEMPLATE_BUILD_CATEGORIES = Object.freeze(['Source-adapted', 'Reconstructed', 'Experimental']);

const text = (value, field, maximum = 5000) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Template ${field} is missing.`);
  return value.trim().slice(0, maximum);
};

function normaliseCard(value, zone, deckName) {
  const id = Number(value?.id), count = Number(value?.count);
  if (!Number.isInteger(id) || id < 1 || id > 99_999_999) throw new Error(`${deckName} has an invalid ${zone} card ID.`);
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error(`${deckName} has an invalid ${zone} quantity.`);
  return { id, name: text(value?.name, 'card name', 160), count };
}

export function normaliseTemplateManifest(value) {
  if (!value || Number(value.schemaVersion) !== 1 || value.format !== 'gog-jush' || !Array.isArray(value.decks))
    throw new Error('This is not a supported Guild of Games template catalogue.');
  if (!value.decks.length || value.decks.length > 1000) throw new Error('The template catalogue has an invalid deck count.');
  const ids = new Set();
  const decks = value.decks.map((item) => {
    const id = text(item?.id, 'ID', 100);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) throw new Error(`Template ID “${id}” is invalid or duplicated.`);
    ids.add(id);
    const name = text(item?.name, 'name', 100);
    const difficulty = text(item?.difficulty, 'difficulty', 20);
    if (!TEMPLATE_DIFFICULTIES.includes(difficulty)) throw new Error(`${name} has an unsupported difficulty.`);
    if (!Array.isArray(item.tags) || !item.tags.length || item.tags.length > 40) throw new Error(`${name} has invalid tags.`);
    const tags = [...new Set(item.tags.map((tag) => text(tag, 'tag', 80)))];
    const deck = {
      id, name, difficulty, tags,
      description: text(item.description, 'description', 1200),
      notes: text(item.notes, 'notes', 5000)
    };
    for (const zone of ZONES) {
      if (!Array.isArray(item[zone]) || item[zone].length > 100) throw new Error(`${name} has an invalid ${zone} section.`);
      deck[zone] = item[zone].map((card) => normaliseCard(card, zone, name));
    }
    deck.searchText = searchable([name, deck.description, deck.notes, ...tags,
      ...ZONES.flatMap((zone) => deck[zone].map((card) => card.name))]);
    return deck;
  });
  return { schemaVersion: 1, format: 'gog-jush', decks };
}

const searchable = (values) => values.flatMap((value) => {
  const original = String(value || '').toLocaleLowerCase();
  const words = original.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return [original, words, words.replace(/\s+/g, '')];
}).join('\n');

const stringList = (value, field, maximum = 20) => {
  if (!Array.isArray(value) || !value.length || value.length > maximum) throw new Error(`Template presentation ${field} is invalid.`);
  return [...new Set(value.map((item) => text(item, field, 80)))];
};

export function applyTemplatePresentation(manifest, value) {
  if (!manifest?.decks || !value || Number(value.schemaVersion) !== 1 || value.format !== 'gog-jush-template-presentation' ||
    !value.decks || Array.isArray(value.decks) || typeof value.decks !== 'object')
    throw new Error('This is not a supported template presentation catalogue.');
  const knownIds = new Set(manifest.decks.map((deck) => deck.id));
  if (Object.keys(value.decks).length !== knownIds.size || Object.keys(value.decks).some((id) => !knownIds.has(id)))
    throw new Error('Template presentation coverage does not match the deck catalogue.');
  const decks = manifest.decks.map((deck) => {
    const item = value.decks[deck.id];
    if (!item) throw new Error(`${deck.name} has no presentation metadata.`);
    const family = text(item.family, 'family', 80);
    const engines = stringList(item.engines, 'engines');
    const tags = Array.isArray(item.tags) ? [...new Set(item.tags.map((tag) => text(tag, 'filter tag', 80)))] : [];
    const buildCategory = text(item.buildCategory, 'build category', 40);
    if (!TEMPLATE_BUILD_CATEGORIES.includes(buildCategory)) throw new Error(`${deck.name} has an unsupported build category.`);
    const coverCardId = Number(item.coverCardId);
    const deckCardIds = new Set(['main', 'extra'].flatMap((zone) => deck[zone].map((card) => Number(card.id))));
    if (!Number.isInteger(coverCardId) || !deckCardIds.has(coverCardId)) throw new Error(`${deck.name} has an invalid cover card.`);
    const source = item.source && typeof item.source === 'object' ? {
      url: item.source.url ? text(item.source.url, 'source URL', 1000) : null,
      title: text(item.source.title || 'Primary deck source', 'source title', 200),
      event: typeof item.source.event === 'string' ? item.source.event.slice(0, 200) : null,
      player: typeof item.source.player === 'string' ? item.source.player.slice(0, 120) : null,
      placement: typeof item.source.placement === 'string' ? item.source.placement.slice(0, 120) : null,
      sourceCount: Math.max(0, Number(item.source.sourceCount) || 0)
    } : null;
    if (source?.url && !/^https:\/\//i.test(source.url)) throw new Error(`${deck.name} has an invalid source URL.`);
    const changes = Array.isArray(item.changes) ? item.changes.slice(0, 12).map((change) => ({
      card: text(change.card, 'change card', 160),
      zone: ZONES.includes(change.zone) ? change.zone : 'main',
      from: Math.max(0, Number(change.from) || 0),
      to: Math.max(0, Number(change.to) || 0),
      reason: text(change.reason, 'change reason', 1000)
    })) : [];
    const enriched = {
      ...deck, family, engines, filterTags: tags, buildCategory, coverCardId,
      coverCardName: text(item.coverCardName, 'cover card name', 160), source, changes,
      changeCount: Math.max(changes.length, Number(item.changeCount) || 0)
    };
    enriched.searchText = searchable([deck.name, deck.description, deck.notes, family, ...engines, ...tags,
      ...ZONES.flatMap((zone) => deck[zone].map((card) => card.name))]);
    return enriched;
  });
  return { ...manifest, presentationSchemaVersion: 1, decks };
}

export function templateZoneCount(deck, zone) {
  return (deck?.[zone] || []).reduce((sum, card) => sum + Number(card.count || 0), 0);
}

export function templateZoneIds(deck, zone) {
  return (deck?.[zone] || []).flatMap((card) => Array.from({ length: card.count }, () => card.id));
}

function facetValues(decks, field) {
  const counts = new Map();
  for (const deck of decks) for (const value of deck[field] || []) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((left, right) => left.value.localeCompare(right.value));
}

export function templateFacets(decks) {
  const builds = new Map();
  for (const deck of decks) builds.set(deck.buildCategory, (builds.get(deck.buildCategory) || 0) + 1);
  return {
    engines: facetValues(decks, 'engines'),
    tags: facetValues(decks, 'filterTags'),
    builds: TEMPLATE_BUILD_CATEGORIES.filter((value) => builds.has(value)).map((value) => ({ value, count: builds.get(value) }))
  };
}

export function templateTags(decks) {
  return facetValues(decks, 'filterTags').map((item) => item.value);
}

export function filterTemplates(decks, { query = '', engines = [], builds = [], tags = [] } = {}) {
  const normalQuery = String(query).toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = normalQuery.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => token.length === 1)) tokens.push(tokens.join(''));
  const wantedEngines = new Set(engines);
  const wantedBuilds = new Set(builds);
  const wantedTags = new Set(tags);
  return decks.filter((deck) =>
    (!wantedEngines.size || deck.engines.some((value) => wantedEngines.has(value))) &&
    (!wantedBuilds.size || wantedBuilds.has(deck.buildCategory)) &&
    (!wantedTags.size || deck.filterTags.some((value) => wantedTags.has(value))) &&
    tokens.every((token) => deck.searchText.includes(token)));
}

export function groupTemplates(decks) {
  const groups = new Map();
  for (const deck of decks) {
    if (!groups.has(deck.family)) groups.set(deck.family, []);
    groups.get(deck.family).push(deck);
  }
  return [...groups].map(([family, members]) => ({
    family,
    decks: members.sort((left, right) => {
      const pure = (deck) => deck.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '') === family.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '');
      return Number(pure(right)) - Number(pure(left)) || left.name.localeCompare(right.name);
    })
  })).sort((left, right) => left.family.localeCompare(right.family));
}
