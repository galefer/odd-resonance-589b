import { newDeck, ZONES } from './state.js';

const DB_NAME = 'gog-jush-deckbuilder-v1';
const DB_VERSION = 2;
const STORE = 'decks';
const META = 'meta';
const FOLDERS = 'folders';
const RECENTS = 'recentDecks';
const MIGRATION_BACKUPS = 'migrationBackups';
const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
});
const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted.'));
  transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
});
const uuid = () => crypto.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export class StorageConflictError extends Error {
  constructor(message) { super(message); this.name = 'StorageConflictError'; }
}

export class DeckDatabase extends EventTarget {
  constructor() {
    super(); this.db = null;
    this.channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('gog-jush-deckbuilder-v1') : null;
    this.channel?.addEventListener('message', (event) => this.dispatchEvent(new CustomEvent('external-change', { detail: event.data })));
  }
  async open() {
    if (!('indexedDB' in globalThis)) throw new Error('This browser does not provide IndexedDB. Export a backup before leaving this page.');
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(FOLDERS)) db.createObjectStore(FOLDERS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(RECENTS)) {
        const recents = db.createObjectStore(RECENTS, { keyPath: 'deckId' });
        recents.createIndex('openedAt', 'openedAt');
      }
      if (!db.objectStoreNames.contains(MIGRATION_BACKUPS)) db.createObjectStore(MIGRATION_BACKUPS, { keyPath: 'key' });
      if (event.oldVersion > 0 && event.oldVersion < 2) {
        const transaction = request.transaction;
        const decks = transaction.objectStore(STORE);
        const backups = transaction.objectStore(MIGRATION_BACKUPS);
        const migratedAt = new Date().toISOString();
        const cursorRequest = decks.openCursor();
        cursorRequest.onerror = () => transaction.abort();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const original = cursor.value;
          const stableId = boundedText(original?.id, 100) || uuid();
          backups.put({ key: `pre-v2:${stableId}`, migratedAt, sourceVersion: event.oldVersion, deck: original });
          cursor.update({ ...original, id: stableId, folderId: boundedText(original?.folderId, 100) || null });
          cursor.continue();
        };
      }
    };
    this.db = await requestResult(request);
    this.db.onversionchange = () => this.db.close();
    return this;
  }
  #store(name, mode = 'readonly') {
    if (!this.db) throw new Error('Local deck storage is not open.');
    const transaction = this.db.transaction(name, mode);
    return { transaction, store: transaction.objectStore(name) };
  }
  async list() {
    const { transaction, store } = this.#store(STORE);
    const decks = await requestResult(store.getAll()); await transactionDone(transaction);
    return decks.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  async get(id) {
    const { transaction, store } = this.#store(STORE);
    const deck = await requestResult(store.get(id)); await transactionDone(transaction); return deck || null;
  }
  async save(deck, { force = false } = {}) {
    const safe = sanitiseDeck(deck);
    const { transaction, store } = this.#store(STORE, 'readwrite');
    const existing = await requestResult(store.get(safe.id));
    if (!force && existing && (Number(existing.revision || 0) > Number(safe.revision || 0) ||
      (Number(existing.revision || 0) === Number(safe.revision || 0) && existing.updatedAt !== safe.updatedAt))) {
      transaction.abort();
      throw new StorageConflictError('A newer revision of this deck was saved in another tab.');
    }
    store.put(safe); await transactionDone(transaction);
    this.channel?.postMessage({ type: 'saved', id: safe.id, revision: safe.revision, updatedAt: safe.updatedAt });
    return safe;
  }
  async delete(id) {
    const [deleted] = await this.deleteMany([id]); return deleted || null;
  }
  async deleteMany(ids) {
    const unique = [...new Set((ids || []).map((id) => boundedText(id, 100)).filter(Boolean))];
    if (!unique.length) return [];
    if (!this.db) throw new Error('Local deck storage is not open.');
    const transaction = this.db.transaction([STORE, RECENTS], 'readwrite');
    const store = transaction.objectStore(STORE), recents = transaction.objectStore(RECENTS);
    const existing = await Promise.all(unique.map((id) => requestResult(store.get(id))));
    unique.forEach((id) => { store.delete(id); recents.delete(id); });
    await transactionDone(transaction);
    unique.forEach((id) => this.channel?.postMessage({ type: 'deleted', id }));
    return existing.filter(Boolean);
  }
  async restoreMany(decks) {
    if (!this.db) throw new Error('Local deck storage is not open.');
    const transaction = this.db.transaction(STORE, 'readwrite'), store = transaction.objectStore(STORE);
    const restored = (decks || []).map((deck) => sanitiseDeck(deck));
    restored.forEach((deck) => store.put(deck)); await transactionDone(transaction);
    restored.forEach((deck) => this.channel?.postMessage({ type: 'saved', id: deck.id, revision: deck.revision, updatedAt: deck.updatedAt }));
    return restored;
  }
  async listFolders() {
    const { transaction, store } = this.#store(FOLDERS);
    const folders = await requestResult(store.getAll()); await transactionDone(transaction);
    return folders.sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
  }
  async createFolder(name) {
    const clean = boundedText(name, 80).trim();
    if (!clean) throw new Error('Enter a folder name.');
    const folders = await this.listFolders();
    const folder = { id: uuid(), name: clean, createdAt: new Date().toISOString(), order: folders.length };
    const { transaction, store } = this.#store(FOLDERS, 'readwrite');
    store.put(folder); await transactionDone(transaction); return folder;
  }
  async importFolders(folders) {
    const safe = (folders || []).slice(0, 100).map((folder, index) => ({
      id: boundedText(folder?.id, 100) || uuid(), name: boundedText(folder?.name, 80).trim() || `Imported folder ${index + 1}`,
      createdAt: /^\d{4}-/.test(folder?.createdAt || '') ? folder.createdAt : new Date().toISOString(),
      order: Number.isFinite(Number(folder?.order)) ? Number(folder.order) : index
    }));
    if (!safe.length) return [];
    const { transaction, store } = this.#store(FOLDERS, 'readwrite');
    safe.forEach((folder) => store.put(folder)); await transactionDone(transaction); return safe;
  }
  async moveDecks(ids, folderId = null) {
    const unique = [...new Set((ids || []).map((id) => boundedText(id, 100)).filter(Boolean))];
    if (!unique.length) return [];
    const destination = boundedText(folderId, 100) || null;
    if (destination) {
      const { transaction, store } = this.#store(FOLDERS);
      const folder = await requestResult(store.get(destination)); await transactionDone(transaction);
      if (!folder) throw new Error('That folder no longer exists.');
    }
    const { transaction, store } = this.#store(STORE, 'readwrite');
    const decks = await Promise.all(unique.map((id) => requestResult(store.get(id))));
    const moved = decks.filter(Boolean).map((deck) => ({ ...deck, folderId: destination }));
    moved.forEach((deck) => store.put(deck)); await transactionDone(transaction);
    moved.forEach((deck) => this.channel?.postMessage({ type: 'organised', id: deck.id, folderId: destination }));
    return moved;
  }
  async listRecentOpenings() {
    const { transaction, store } = this.#store(RECENTS);
    const records = await requestResult(store.getAll()); await transactionDone(transaction);
    return records.sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)) || String(a.deckId).localeCompare(String(b.deckId)));
  }
  async markOpened(deckId, openedAt = new Date().toISOString()) {
    const id = boundedText(deckId, 100); if (!id) return;
    const { transaction, store } = this.#store(RECENTS, 'readwrite');
    store.put({ deckId: id, openedAt }); await transactionDone(transaction);
  }
  async getCurrentId() {
    const { transaction, store } = this.#store(META);
    const value = await requestResult(store.get('currentDeckId')); await transactionDone(transaction);
    return value?.value || null;
  }
  async setCurrentId(id) {
    const { transaction, store } = this.#store(META, 'readwrite');
    store.put({ key: 'currentDeckId', value: id }); await transactionDone(transaction);
  }
  close() { this.channel?.close(); this.db?.close(); }
}

function boundedText(value, maximum) { return String(value || '').slice(0, maximum); }
function sanitiseInstance(value) {
  if (!value || typeof value !== 'object') throw new Error('A deck entry is malformed.');
  const originalImportId = Number(value.originalImportId);
  const canonicalId = value.canonicalId == null ? null : Number(value.canonicalId);
  if (canonicalId != null && (!Number.isInteger(canonicalId) || canonicalId <= 0 || canonicalId > 0xffffffff))
    throw new Error('A canonical card ID is invalid.');
  if ((!Number.isInteger(originalImportId) || originalImportId <= 0 || originalImportId > 0xffffffff) && canonicalId == null)
    throw new Error('An unresolved entry must retain its original numeric ID.');
  return {
    instanceId: boundedText(value.instanceId, 100) || uuid(), canonicalId,
    artworkId: value.artworkId == null ? canonicalId : Number(value.artworkId),
    originalImportId: Number.isInteger(originalImportId) ? originalImportId : canonicalId,
    resolution: ['resolved','unknown_id','outside_pool','not_playable','metadata_unavailable'].includes(value.resolution) ? value.resolution : 'metadata_unavailable',
    name: boundedText(value.name, 160), category: boundedText(value.category, 20) || null,
    subtype: boundedText(value.subtype, 60) || null, cardType: boundedText(value.cardType, 100) || null,
    placement: ['main','extra'].includes(value.placement) ? value.placement : null,
    copyLimitKey: boundedText(value.copyLimitKey, 180), status: boundedText(value.status, 30) || 'unverified',
    allowedCopies: Math.max(0, Math.min(3, Number(value.allowedCopies ?? 0))), attribute: boundedText(value.attribute, 20) || null,
    race: boundedText(value.race, 80) || null, level: value.level == null ? null : Number(value.level),
    linkRating: value.linkRating == null ? null : Number(value.linkRating),
    pendulumScale: value.pendulumScale == null ? null : Number(value.pendulumScale),
    atk: value.atk == null ? null : Number(value.atk), def: value.def == null ? null : Number(value.def),
    description: boundedText(value.description, 8000)
  };
}

export function sanitiseDeck(value, { newIdentity = false } = {}) {
  if (!value || typeof value !== 'object' || Number(value.schemaVersion || 1) !== 1) throw new Error('Unsupported deck backup schema.');
  const base = newDeck(boundedText(value.name, 100));
  base.id = newIdentity ? uuid() : boundedText(value.id, 100) || base.id;
  base.revision = Math.max(0, Math.min(1_000_000_000, Number(value.revision || 0)));
  base.createdAt = /^\d{4}-/.test(value.createdAt || '') ? value.createdAt : base.createdAt;
  base.updatedAt = /^\d{4}-/.test(value.updatedAt || '') ? value.updatedAt : base.updatedAt;
  base.folderId = boundedText(value.folderId, 100) || null;
  base.lastCheckedVersionId = Number.isInteger(Number(value.lastCheckedVersionId)) ? Number(value.lastCheckedVersionId) : null;
  for (const zone of ZONES) {
    if (!Array.isArray(value[zone]) || value[zone].length > 512) throw new Error(`Invalid ${zone} section in backup.`);
    base[zone] = value[zone].map(sanitiseInstance);
  }
  if (ZONES.reduce((sum, zone) => sum + base[zone].length, 0) > 512) throw new Error('Deck backup exceeds 512 entries.');
  base.groups = Array.isArray(value.groups) ? value.groups.slice(0, 20).map((group) => ({
    id: boundedText(group?.id, 100) || uuid(), name: boundedText(group?.name, 80) || 'Card group',
    canonicalIds: [...new Set((group?.canonicalIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 200)
  })) : [];
  base.notes = boundedText(value.notes, 5000);
  base.originalImport = value.originalImport && typeof value.originalImport === 'object'
    ? { source: boundedText(value.originalImport.source, 30), importedAt: boundedText(value.originalImport.importedAt, 40),
      warnings: Array.isArray(value.originalImport.warnings) ? value.originalImport.warnings.slice(0, 100).map((item) => boundedText(item?.code || item, 100)) : [] }
    : null;
  return base;
}

export function makeBackup(decks, folders = []) {
  return {
    schemaVersion: 1, exportedAt: new Date().toISOString(), formatId: 'gog-jush',
    folders: (folders || []).slice(0, 100).map((folder, index) => ({
      id: boundedText(folder?.id, 100) || uuid(), name: boundedText(folder?.name, 80).trim() || `Folder ${index + 1}`,
      createdAt: /^\d{4}-/.test(folder?.createdAt || '') ? folder.createdAt : null,
      order: Number.isFinite(Number(folder?.order)) ? Number(folder.order) : index
    })),
    decks: decks.map((deck) => sanitiseDeck(deck))
  };
}

export function parseBackup(value) {
  const input = typeof value === 'string' ? JSON.parse(value) : value;
  if (!input || Number(input.schemaVersion) !== 1 || !Array.isArray(input.decks) || input.decks.length > 200)
    throw new Error('This is not a supported JUSH deckbuilder backup.');
  const folders = Array.isArray(input.folders) ? input.folders.slice(0, 100).map((folder, index) => ({
    id: boundedText(folder?.id, 100) || uuid(), name: boundedText(folder?.name, 80).trim() || `Imported folder ${index + 1}`,
    createdAt: /^\d{4}-/.test(folder?.createdAt || '') ? folder.createdAt : null,
    order: Number.isFinite(Number(folder?.order)) ? Number(folder.order) : index
  })) : [];
  const decks = input.decks.map((deck) => sanitiseDeck(deck, { newIdentity: true }));
  Object.defineProperty(decks, 'folders', { value: folders, enumerable: false });
  return decks;
}
