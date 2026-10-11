/** Original dependency-free reference implementation, not a full deck validator.
 * Standards evidence: docs/07_RESEARCH_AND_SOURCES.md [S5], [S6].
 * Pass verified canonical IDs to exporters; never use database row IDs or art IDs.
 * Node 22+ and current browsers provide TextEncoder, atob and btoa.
 */
export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_IMPORT_CARDS = 512; // Safety cap, deliberately NOT a legality limit.
export const ZONES = Object.freeze(['main', 'extra', 'side']);
const MAX_ID = 0xffffffff;
const textEncoder = new TextEncoder();
export class DeckFormatError extends Error {
  constructor(code, message, line = null) {
    super(message); this.name = 'DeckFormatError'; this.code = code; this.line = line;
  }
}
function fail(code, message, line) { throw new DeckFormatError(code, message, line); }
function checkedText(value) {
  if (typeof value !== 'string') fail('NOT_TEXT', 'Deck data must be text.');
  if (textEncoder.encode(value).byteLength > MAX_FILE_BYTES) fail('TOO_LARGE', 'Deck input exceeds 128 KiB.');
  return value.replace(/^\uFEFF/, '');
}
function checkedId(id, line = null) {
  if (!Number.isInteger(id) || id <= 0 || id > MAX_ID) fail('INVALID_ID', 'A passcode must be a positive unsigned 32-bit integer.', line);
  return id;
}
function checkedDeck(deck) {
  if (!deck || typeof deck !== 'object') fail('BAD_SHAPE', 'Expected a deck object.');
  let size = 0;
  for (const zone of ZONES) {
    if (!Array.isArray(deck[zone])) fail('BAD_SHAPE', `Missing ${zone} array.`);
    size += deck[zone].length;
    for (const id of deck[zone]) checkedId(id);
  }
  if (size > MAX_IMPORT_CARDS) fail('TOO_MANY_ENTRIES', 'Deck input exceeds the 512-entry safety limit.');
}
/** Parse structural YDK text. Does not resolve IDs, change zones or discard copies. */
export function parseYdk(value) {
  const text = checkedText(value), deck = {main: [], extra: [], side: []};
  const warnings = [], seen = new Set();
  let zone = null, lastZoneIndex = -1, count = 0;
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 4096) fail('TOO_MANY_LINES', 'Deck input exceeds 4096 lines.');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim(), lineNumber = index + 1;
    if (!line) continue;
    const marker = {'#main': 'main', '#extra': 'extra', '!side': 'side'}[line.toLowerCase()];
    if (marker) {
      if (seen.has(marker)) fail('DUPLICATE_SECTION', `Duplicate ${marker} section.`, lineNumber);
      const nextIndex = ZONES.indexOf(marker);
      if (nextIndex < lastZoneIndex) fail('SECTION_ORDER', 'Expected Main, Extra, then Side section order.', lineNumber);
      seen.add(marker); zone = marker; lastZoneIndex = nextIndex; continue;
    }
    if (line.startsWith('#')) continue; // standard creator / optional card-name comments
    if (line.startsWith('!')) fail('UNKNOWN_MARKER', `Unknown section marker: ${line.slice(0, 30)}`, lineNumber);
    if (!zone) fail('MISSING_MAIN', 'Card found before the #main section.', lineNumber);
    if (!/^\d{1,10}$/.test(line)) fail('INVALID_TOKEN', 'Expected one decimal card passcode per line.', lineNumber);
    deck[zone].push(checkedId(Number(line), lineNumber));
    if (++count > MAX_IMPORT_CARDS) fail('TOO_MANY_ENTRIES', 'Deck input exceeds the 512-entry safety limit.', lineNumber);
  }
  if (!seen.has('main')) fail('MISSING_MAIN', 'The #main section is required.');
  for (const optional of ['extra', 'side']) if (!seen.has(optional)) warnings.push({code:'MISSING_OPTIONAL_SECTION', section:optional});
  return {deck, warnings};
}
/** Portable UTF-8 text; no proprietary comments containing tags or legality claims. */
export function encodeYdk(deck) {
  checkedDeck(deck);
  return ['#created by JUSH House Format', '#main', ...deck.main, '#extra', ...deck.extra, '!side', ...deck.side, ''].join('\n');
}
function sectionToBase64(ids) {
  const bytes = new Uint8Array(ids.length * 4), view = new DataView(bytes.buffer);
  ids.forEach((id, index) => view.setUint32(index * 4, id, true)); // explicit little endian
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function sectionFromBase64(value) {
  if (!value) return [];
  // Standard Base64 only. URL-safe '-'/'_' are a different alphabet.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1)
    fail('BAD_BASE64', 'Invalid Base64 in YDKE section.');
  const naked = value.replace(/=+$/, '');
  if (naked.length % 4 === 1) fail('BAD_BASE64', 'Invalid Base64 length.');
  const canonicalPadding = '='.repeat((4 - naked.length % 4) % 4);
  if (value.includes('=') && value !== naked + canonicalPadding) fail('BAD_BASE64', 'Invalid Base64 padding.');
  let binary;
  try { binary = atob(naked + canonicalPadding); }
  catch { fail('BAD_BASE64', 'Unable to decode YDKE section.'); }
  if (btoa(binary).replace(/=+$/, '') !== naked) fail('BAD_BASE64', 'Invalid Base64 padding bits.');
  if (binary.length % 4) fail('BYTE_ALIGNMENT', 'YDKE card data must consist of 4-byte integers.');
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), ids = [];
  for (let i = 0; i < view.byteLength; i += 4) ids.push(checkedId(view.getUint32(i, true)));
  return ids;
}
export function encodeYdke(deck) {
  checkedDeck(deck);
  return `ydke://${sectionToBase64(deck.main)}!${sectionToBase64(deck.extra)}!${sectionToBase64(deck.side)}!`;
}
export function parseYdke(value) {
  // Tolerate whitespace introduced by line-wrapped clipboard text, not other URI types.
  const text = checkedText(value).trim().replace(/[\r\n\t ]/g, '');
  if (!/^ydke:\/\//i.test(text)) fail('NOT_YDKE', 'Expected a ydke:// code, not an Omega-specific code or a website URL.');
  const chunks = text.slice(7).split('!');
  const warnings = [];
  if (chunks.length === 3) warnings.push({code:'MISSING_TERMINATOR'});
  else if (chunks.length !== 4 || chunks[3] !== '') fail('YDKE_SECTIONS', 'YDKE requires exactly three card sections.');
  const deck = {main: sectionFromBase64(chunks[0]), extra: sectionFromBase64(chunks[1]), side: sectionFromBase64(chunks[2])};
  checkedDeck(deck);
  return {deck, warnings};
}
