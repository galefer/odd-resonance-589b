import { ZONES } from './state.js';

const inputId = (item) => item.originalImportId || item.canonicalId;

// Legality depends on each section's multiset of IDs, not display order or notes.
export function validationKey(deck) {
  return JSON.stringify(ZONES.map(zone => deck[zone].map(inputId).sort((a, b) => a - b)));
}

export function remapValidation(result, source, target) {
  if (validationKey(source) !== validationKey(target)) throw new Error('Deck contents changed.');
  const positions = new Map();
  for (const zone of ZONES) {
    const byId = new Map();
    target[zone].forEach((item, index) => {
      const id = inputId(item), indices = byId.get(id) || [];
      indices.push(index); byId.set(id, indices);
    });
    source[zone].forEach((item, index) => positions.set(`${zone}:${index}`, byId.get(inputId(item)).shift()));
  }
  const remap = (entry) => Number.isInteger(entry.index) && positions.has(`${entry.zone}:${entry.index}`)
    ? { ...entry, index: positions.get(`${entry.zone}:${entry.index}`) } : { ...entry };
  return { ...result, issues: (result.issues || []).map(remap), cards: (result.cards || []).map(remap) };
}
