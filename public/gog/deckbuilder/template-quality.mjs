/**
 * Framework-free quality sidecar join for the existing GoG template browser.
 * Call AFTER applyTemplatePresentation. No card API calls, image changes,
 * persistent browser storage, or mutations to seed/player decks occur here.
 */
const ZONES = ['main', 'extra', 'side'];
const PROTECTED_FIELDS = ['id', 'name', 'description', 'difficulty', 'main', 'extra', 'side', 'notes'];
const requests = new Map();

export const TEMPLATE_QUALITY_LABELS = Object.freeze({
  ready_for_review: 'Ready for review',
  source_preserved: 'Source-based',
  experimental: 'Experimental',
  needs_rebuild: 'Rebuild required',
  needs_review: 'Needs review',
  needs_recheck: 'Needs recheck',
  reviewed: 'Reviewed',
});

const aliases = Object.freeze({rebuild: 'needs_rebuild', unsupported: 'needs_rebuild', unsupported_in_this_configuration: 'needs_rebuild',
  review_required: 'needs_review', unreviewed: 'needs_review', retained: 'source_preserved'});

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export async function fingerprintTemplate(deck, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle) return null;
  const protectedDeck = {};
  for (const key of PROTECTED_FIELDS) {
    if (!(key in deck)) throw new Error(`Template ${deck?.id || ''} lacks ${key}.`);
    protectedDeck[key] = ZONES.includes(key)
      ? deck[key].map(({id, name, count}) => ({id, name, count})).sort((a, b) => a.id - b.id)
      : deck[key];
  }
  const data = new TextEncoder().encode(canonical(protectedDeck));
  const hash = await cryptoProvider.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function indexTemplateQuality(value) {
  if (!value || typeof value !== 'object' || Number(value.schemaVersion) !== 1 || (value.format && value.format !== 'gog-jush'))
    throw new Error('Unsupported template quality sidecar.');
  const containers = ['decks', 'templates', 'byId'].filter((key) => key in value);
  if (containers.length !== 1) throw new Error('Template quality needs exactly one record container.');
  const rows = value[containers[0]];
  if (!rows || typeof rows !== 'object') throw new Error('Template quality records are missing.');
  const pairs = Array.isArray(rows) ? rows.map((row) => [null, row]) : Object.entries(rows);
  const result = new Map();
  for (const [key, row] of pairs) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid template quality record.');
    const ids = [key, row.id, row.deckId, row.templateId].filter((id) => id !== null && id !== undefined);
    const id = ids[0];
    if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.some((other) => other !== id) || result.has(id))
      throw new Error('Duplicate or inconsistent template quality ID.');
    const record = row.quality && typeof row.quality === 'object' && !Array.isArray(row.quality) ? row.quality : row;
    result.set(id, record);
  }
  return result;
}

function declaredHouseVersion(document, record) {
  return record.houseListVersionId ?? record.inputFingerprint?.houseListVersion ?? record.inputFingerprint?.houseListVersionId
    ?? document.houseListVersionId ?? document.houseListVersion ?? document.inputs?.houseListVersionId ?? document.inputs?.houseListVersion
    ?? document.context?.houseListVersionId ?? null;
}

function statusOf(record) {
  const raw = record.status ?? record.decision ?? record.outcome ?? 'needs_review';
  const status = aliases[raw] || raw;
  return Object.hasOwn(TEMPLATE_QUALITY_LABELS, status) ? status : 'needs_review';
}

function missingQuality(reason = 'No matching assessment is available for this template.') {
  return {status: 'needs_review', label: TEMPLATE_QUALITY_LABELS.needs_review, verification: 'missing',
    recommended: false, reviewMessage: reason};
}

/** Returns a new enriched manifest, preserving every presentation field. */
export async function applyTemplateQuality(manifest, document, {publishedHouseVersion = null, cryptoProvider = globalThis.crypto} = {}) {
  if (!manifest || !Array.isArray(manifest.decks)) throw new Error('Template catalogue is missing.');
  let records;
  try { records = indexTemplateQuality(document); }
  catch (error) {
    return {...manifest, qualityLoadError: error.message,
      decks: manifest.decks.map((deck) => ({...deck, quality: missingQuality('The quality assessment could not be loaded.')}))};
  }
  const decks = await Promise.all(manifest.decks.map(async (deck) => {
    const record = records.get(deck.id);
    if (!record) return {...deck, quality: missingQuality()};
    let digest = null;
    try { digest = await fingerprintTemplate(deck, cryptoProvider); }
    catch { /* An unavailable verifier downgrades the assessment, not the catalogue. */ }
    const verification = !record.templateFingerprint ? 'unbound' : !digest ? 'unavailable' : digest === record.templateFingerprint ? 'matched' : 'mismatch';
    const houseVersion = declaredHouseVersion(document, record);
    const houseChanged = publishedHouseVersion !== null && houseVersion !== null && String(publishedHouseVersion) !== String(houseVersion);
    const reportedStatus = statusOf(record);
    const status = houseChanged ? 'needs_recheck' : verification === 'matched' ? reportedStatus : 'needs_review';
    const messages = [];
    if (verification === 'mismatch') messages.push('This assessment belongs to a different version of the template.');
    if (verification === 'unbound') messages.push('The assessment is not bound to a template fingerprint.');
    if (verification === 'unavailable') messages.push('The template assessment could not be verified in this browser.');
    if (houseChanged) messages.push('The published house list has changed since this assessment.');
    const quality = {...record, status, reportedStatus, label: TEMPLATE_QUALITY_LABELS[status], verification,
      evaluatedHouseVersion: houseVersion, houseChanged,
      // Review readiness, formal legality and source provenance do not establish
      // competitive performance. No supplied unknown/reconstruction gets a
      // recommendation merely because its JSON passed validation.
      recommendationClaimed: record.recommended === true,
      assessmentReviewMessage: record.reviewMessage || '',
      recommended: verification === 'matched' && !houseChanged && houseVersion !== null && publishedHouseVersion !== null && status === 'reviewed'
        && record.recommended === true && record.competitiveEvidence?.verified === true,
      reviewMessage: messages.join(' ') || record.reviewMessage || ''};
    return {...deck, quality};
  }));
  return {...manifest, qualityCatalogueVersion: document.qualityCatalogueVersion ?? document.catalogueVersion ?? document.version ?? null,
    qualityHouseVersion: document.houseListVersionId ?? document.inputs?.houseListVersionId ?? null, decks};
}

export function filterTemplatesByQuality(decks, {statuses = [], includeExperimental = true, includeNeedsRebuild = true} = {}) {
  const wanted = new Set(statuses);
  return decks.filter((deck) => {
    const status = deck.quality?.status || 'needs_review';
    return (!wanted.size || wanted.has(status)) && (includeExperimental || status !== 'experimental') && (includeNeedsRebuild || status !== 'needs_rebuild');
  });
}

export function templateQualityPresentation(deck) {
  const quality = deck.quality || missingQuality();
  const status = quality.status || 'needs_review';
  return {status, label: TEMPLATE_QUALITY_LABELS[status] || TEMPLATE_QUALITY_LABELS.needs_review,
    tone: status === 'needs_rebuild' ? 'warning' : ['needs_review', 'needs_recheck', 'experimental'].includes(status) ? 'muted' : 'neutral',
    recommended: quality.recommended === true, message: quality.reviewMessage || ''};
}

/** Reassess version freshness after the app observes a new published list. */
export function refreshTemplateQualityForHouse(manifest, publishedHouseVersion) {
  if (!manifest?.decks) return manifest;
  return {...manifest, decks: manifest.decks.map((deck) => {
    const prior = deck.quality || missingQuality();
    const known = prior.evaluatedHouseVersion;
    const changed = publishedHouseVersion !== null && publishedHouseVersion !== undefined && known !== null && known !== undefined
      && String(publishedHouseVersion) !== String(known);
    const status = changed ? 'needs_recheck' : prior.verification === 'matched' ? (prior.reportedStatus || 'needs_review') : 'needs_review';
    return {...deck, quality: {...prior, status, houseChanged: changed, label: TEMPLATE_QUALITY_LABELS[status] || TEMPLATE_QUALITY_LABELS.needs_review,
      recommended: !changed && prior.verification === 'matched' && status === 'reviewed'
        && known !== null && known !== undefined && publishedHouseVersion !== null && publishedHouseVersion !== undefined
        && prior.recommendationClaimed === true && prior.competitiveEvidence?.verified === true,
      reviewMessage: changed ? 'The published house list has changed since this assessment.' : prior.houseChanged ? prior.assessmentReviewMessage || '' : prior.reviewMessage || ''}};
  })};
}

export function templateQualityCacheKey(url, release) {
  return `${url}::${String(release || 'unversioned')}`;
}

export function versionedTemplateUrl(url, release) {
  if (!release) return url;
  const [beforeHash, ...fragment] = String(url).split('#');
  return `${beforeHash}${beforeHash.includes('?') ? '&' : '?'}catalogueVersion=${encodeURIComponent(String(release))}${fragment.length ? '#' + fragment.join('#') : ''}`;
}

/** One same-origin sidecar request per URL/release per page session. */
export function loadTemplateQuality(url, {release = '', fetcher = globalThis.fetch} = {}) {
  const key = templateQualityCacheKey(url, release);
  if (!requests.has(key)) {
    const promise = Promise.resolve().then(() => fetcher(versionedTemplateUrl(url, release), {
      headers: {Accept: 'application/json'}, cache: 'no-cache',
    })).then(async (response) => {
      if (!response.ok) throw new Error(`Template quality request failed (${response.status}).`);
      const value = await response.json();
      indexTemplateQuality(value);
      return value;
    }).catch((error) => { if (requests.get(key) === promise) requests.delete(key); throw error; });
    requests.set(key, promise);
  }
  return requests.get(key);
}

export function clearTemplateQualityCache() { requests.clear(); }
