// Reviewed corrections for playable cards whose YGOPRODeck misc_info does not
// expose the first TCG release. The house format uses the first release in any
// TCG region, so European release dates can precede the North American date.
//
// Evidence:
// - Duelist's Advance (DUAD): first TCG release 2025-07-03.
//   https://www.db.yugioh-card.com/yugiohdb/card_calendar?dd=3&mm=7&mode=1&ope=1&request_locale=en&rp=99999&sess=1&sort=1
// - Alliance Insight (ALIN): first TCG release 2025-05-01.
//   https://www.db.yugioh-card.com/yugiohdb/card_search.action?cid=20704&ope=2&request_locale=en

const duad = (setNumber, extra = {}) => Object.freeze({
  tcgDate: '2025-07-03',
  setCode: `DUAD-EN${setNumber}`,
  ...extra
});

export const RELEASE_EVIDENCE_OVERRIDES = Object.freeze({
  12067160: duad('050'), // Gorgon of Zilofthonia
  75956913: duad('052'), // Gagaga Utopic Tactics
  2344618: duad('053'), // Lunalight Masquerade
  48739627: duad('055'), // Theorealize
  37517035: duad('056'), // Artmage Masterwork -Succession-
  1122030: duad('057'), // Artmage Vandalism -Assault-
  74011784: duad('058'), // Artmage Varnish -Alteration-
  483: duad('059'), // Parallel Teleport
  36494597: duad('060'), // Teleport Fusion
  9283801: duad('062'), // The Monarchs Revolt
  36672909: duad('063'), // Regenesis Cycle
  62767644: duad('064'), // Inferno of the Ashened
  99161253: duad('065'), // Primite Fusion
  61944066: duad('067'), // Nouvelles Recipe Book "Recettes de Nouvellez"
  98349765: duad('068', {
    // The provider still exposes a pre-release translation as the card name.
    name: 'Layer 19 "Sudden Incursion! Super Quantum Black!!"'
  }),
  34433770: duad('069'), // Sky Striker Special Maneuver - Lemnisgate!
  61822419: duad('070'), // Guilt-Gripping Morganite
  97227123: duad('071'), // Return of the Duelist
  23611122: duad('072'), // Sudden Thunder Swamp
  60600821: duad('073'), // Spring
  96004535: duad('074'), // Unbreakable Xyz Barrier
  23599634: duad('075'), // Artmage Pact -Awakening-
  59983249: duad('076'), // Monarchic Perfection
  95382988: duad('077'), // Regenesis Commands
  22377092: duad('078'), // Trap Holic
  58761791: duad('079'), // Shipping Error
  85150300: duad('080'), // Spirit Poacher
  19316241: duad('097'), // Galaxy War Drake
  93413793: duad('098'), // Ukanomitsune-no-Tamayura
  74941992: duad('099'), // Moon Magician
  336601: duad('100'), // Moon Gardna
  87640391: Object.freeze({ tcgDate: '2025-05-01', setCode: 'ALIN-EN099' }) // Migratory Zereort
});

export const releaseEvidenceFor = (cardId) => RELEASE_EVIDENCE_OVERRIDES[Number(cardId)] || null;
export const reviewedTcgDateFor = (raw) => releaseEvidenceFor(raw?.id)?.tcgDate ||
  raw?.misc_info?.find((info) => typeof info?.tcg_date === 'string')?.tcg_date || null;
export const reviewedCardNameFor = (raw) => releaseEvidenceFor(raw?.id)?.name || String(raw?.name || '');

