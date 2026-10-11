// Minimal YGOPRODeck records for cards first released in the TCG in BLMM.
// North American release: 13 June 2025. A later regional release must not
// exclude these cards from the house pool.
// https://www.yugioh-card.com/en/products/blmm/
export const blmmCards = [
  [12163590, 'Dragonmaid Cehrmba', 'Effect Monster', 'BLMM-EN048'],
  [75046994, 'Noh-P.U.N.K. Rising Scale', 'Effect Monster', 'BLMM-EN050'],
  [93053159, 'Alba System Dogmatikalamity', 'Fusion Monster', 'BLMM-EN011']
].map(([id, name, type, set_code]) => ({
  id, name, type, desc: 'Fixture effect text.',
  misc_info: [{ tcg_date: '2025-06-13', ocg_date: '2024-12-21' }],
  card_sets: [{ set_name: 'Battles of Legend: Monster Mayhem', set_code }],
  card_images: [{ id }]
}));
