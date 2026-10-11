# Justice Hunters House Format · Cloudflare Pages Overlay

**Homepage:** `https://gravetalestudios.com/gog/`

A mobile-friendly house-format Forbidden & Limited List with admin login (browser PBKDF2 plus a private Cloudflare auth pepper), live card search, draft editing and version publishing.

- **Card pool cutoff:** first TCG release no later than **1 August 2025** (Justice Hunters / JUSH).
- **Starting restriction list:** 7 April 2025 TCG Advanced Format (109 Forbidden, 82 Limited, 16 Semi-Limited).
- **Independent format:** the official list is just a historical starting point, not an ongoing overlay.
- **House-tweak markers:** `NEW` always means the card's current status differs from the fixed April 2025/JUSH-era foundation, even after later house versions are published.
- **Unlimited:** any eligible, unlisted card. Cards released after JUSH are not eligible at all.
- **Backend:** Cloudflare Pages Functions + D1; card images optionally stored in Cloudflare R2.
- **R2 storage guard:** image caching stops at 5 GB, leaving a wide margin below the 10 GB free storage allowance.
- **Dependencies:** none in the deployed frontend or functions; Wrangler is needed once for D1 initialization.

**Read [`SETUP.md`](SETUP.md) before deployment.** Extract this package into the root of the existing Pages Git repository (`odd-resonance-589b`); it adds files and does not replace your other pages.
