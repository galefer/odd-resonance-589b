# Justice Hunters House Format · Cloudflare Pages Overlay

**JUSH House Format homepage:** `https://gravetalestudios.com/gog/`

**Legacy house-format address:** `https://gravetalestudios.com/gog/house-format/` → `/gog/`

**Deckbuilder:** `https://gravetalestudios.com/gog/deckbuilder/`

The `/gog/` homepage is the Guild of Games JUSH format experience: illustrated identity, the next scheduled JUSH event, card search, the house-format Forbidden & Limited List and protected administration. The event panel supports occurrence-specific changes, cancellations and one-off events. The deckbuilder provides Main/Extra/Side editing, published-list validation, named local saves, YDK/YDKE import and export, JSON backup, exact opening probabilities and a sample-hand tool.

- **Card pool cutoff:** first TCG release in **any TCG region, including North America**, no later than **1 August 2025** (Justice Hunters / JUSH). **Battles of Legend: Monster Mayhem (BLMM) is included** through its [13 June 2025 North American release](https://www.yugioh-card.com/en/products/blmm/). Later regional releases and reprints do not disqualify an eligible card; an OCG-only release does not qualify.
- **Starting restriction list:** 7 April 2025 TCG Advanced Format (109 Forbidden, 82 Limited, 16 Semi-Limited).
- **Independent format:** the official list is just a historical starting point, not an ongoing overlay.
- **House-change markers:** `House change` means the card's current status differs from the fixed April 2025/JUSH-era foundation, even after later house versions are published.
- **Unlimited:** any eligible, unlisted card. Cards released after JUSH are not eligible at all.
- **Backend:** Cloudflare Pages Functions + D1; card images optionally stored in Cloudflare R2.
- **Events:** the homepage promotes the next scheduled JUSH occurrence in Europe/London. The saved `house_event_start` setting establishes the first published occurrence; later dates use the final Thursday of each calendar month. Per-date edits and cancellations remain authoritative.
- **R2 cost guards:** image caching stops at 5 GB; edge caching runs before R2; application traffic stops at 100,000 Class A and 1,000,000 Class B R2 operations per calendar month.
- **Deck storage:** IndexedDB in the visitor's browser. Anonymous decks are never written to D1; JSON is the complete portable backup.
- **Catalogue:** a generated, versioned D1 snapshot of verified playable TCG cards through the cutoff. Post-JUSH and unverified cards remain explicit import errors and never become selectable.
- **Dependencies:** none in the deployed frontend or functions; Wrangler is needed once for D1 initialization.

**Read [`SETUP.md`](SETUP.md) before deployment.** Extract this package into the root of the existing Pages Git repository (`odd-resonance-589b`); it adds files and does not replace your other pages.
