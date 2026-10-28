import { ZONES } from './state.js';

export const TEMPLATE_DIFFICULTIES = Object.freeze(['Beginner', 'Intermediate', 'Advanced']);

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
    deck.searchText = [name, deck.description, deck.notes, ...tags,
      ...ZONES.flatMap((zone) => deck[zone].map((card) => card.name))].join('\n').toLocaleLowerCase();
    return deck;
  });
  return { schemaVersion: 1, format: 'gog-jush', decks };
}

export function templateZoneCount(deck, zone) {
  return (deck?.[zone] || []).reduce((sum, card) => sum + Number(card.count || 0), 0);
}

export function templateZoneIds(deck, zone) {
  return (deck?.[zone] || []).flatMap((card) => Array.from({ length: card.count }, () => card.id));
}

export function templateTags(decks) {
  return [...new Set(decks.flatMap((deck) => deck.tags))].sort((left, right) => left.localeCompare(right));
}

export function filterTemplates(decks, { query = '', difficulty = '', tag = '' } = {}) {
  const tokens = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return decks.filter((deck) => (!difficulty || deck.difficulty === difficulty) &&
    (!tag || deck.tags.includes(tag)) && tokens.every((token) => deck.searchText.includes(token)));
}
