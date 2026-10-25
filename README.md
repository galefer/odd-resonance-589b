# Justice Hunters House Format · Cloudflare Pages Overlay

**Store home and events:** `https://gravetalestudios.com/gog/`

**House-format card list:** `https://gravetalestudios.com/gog/house-format/`

**Deckbuilder:** `https://gravetalestudios.com/gog/deckbuilder/`

A Guild of Games welcome page with separate upcoming Advanced TCG and Special Events rows, a mobile-friendly house-format Forbidden & Limited List, and a full local deckbuilder. The event panel supports occurrence-specific recurring-event changes and one-off events. The card list includes admin login (browser PBKDF2 plus a private Cloudflare auth pepper), live card search, draft editing and version publishing. The deckbuilder provides Main/Extra/Side editing, published-list validation, named local saves, YDK/YDKE import and export, JSON backup, exact opening probabilities and a sample-hand tool.

- **Card pool cutoff:** first TCG release in **any TCG region, including North America**, no later than **1 August 2025** (Justice Hunters / JUSH). **Battles of Legend: Monster Mayhem (BLMM) is included** through its [13 June 2025 North American release](https://www.yugioh-card.com/en/products/blmm/). Later regional releases and reprints do not disqualify an eligible card; an OCG-only release does not qualify.
- **Starting restriction list:** 7 April 2025 TCG Advanced Format (109 Forbidden, 82 Limited, 16 Semi-Limited).
- **Independent format:** the official list is just a historical starting point, not an ongoing overlay.
- **House-tweak markers:** `NEW` always means the card's current status differs from the fixed April 2025/JUSH-era foundation, even after later house versions are published.
- **Unlimited:** any eligible, unlisted card. Cards released after JUSH are not eligible at all.
- **Backend:** Cloudflare Pages Functions + D1; card images optionally stored in Cloudflare R2.
- **Events:** the homepage shows the next four Advanced Thursdays in Europe/London. House Format debuts on 26 November 2026 and then takes the final Thursday of each month; future one-off events appear in Special Events. Per-date edits and cancellations apply only to that occurrence.
- **R2 cost guards:** image caching stops at 5 GB; edge caching runs before R2; application traffic stops at 100,000 Class A and 1,000,000 Class B R2 operations per calendar month.
- **Deck storage:** IndexedDB in the visitor's browser. Anonymous decks are never written to D1; JSON is the complete portable backup.
- **Catalogue:** a generated, versioned D1 snapshot of verified playable TCG cards through the cutoff. Post-JUSH and unverified cards remain explicit import errors and never become selectable.
- **Dependencies:** none in the deployed frontend or functions; Wrangler is needed once for D1 initialization.

**Read [`SETUP.md`](SETUP.md) before deployment.** Extract this package into the root of the existing Pages Git repository (`odd-resonance-589b`); it adds files and does not replace your other pages.
