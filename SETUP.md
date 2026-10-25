# Deploy the JUSH House Format at gravetalestudios.com/gog/

This is a **Cloudflare Pages overlay** designed for your existing GRAVETALE Studios Git repository (`odd-resonance-589b`). It does not replace your current home page, CSS, or other routes.

**Rules built into the site**

- Card pool: Yu-Gi-Oh! **first release in any TCG region, including North America, up to and including 1 August 2025**, the release of **Justice Hunters (JUSH)**. **BLMM is included**: its [North American release was 13 June 2025](https://www.yugioh-card.com/en/products/blmm/). Use the earliest TCG release, even when a European release came later. Later reprints remain eligible; OCG-only releases do not qualify.
- Foundation banlist: official TCG Advanced Format **7 April 2025** restrictions, the list that was active on 1 August. There are **109 Forbidden, 82 Limited, 16 Semi-Limited** entries.
- Cards in that pool that are not in your house restriction list may be used at **3 copies**.
- Cards that first came out *after* JUSH are **not legal**, not 'Unlimited'. New cards cannot be added by an admin, including through a forged request; the server verifies against the TCG/date-filtered card API.
- Cards first printed earlier remain eligible when reprinted later.

Official release: https://www.yugioh-card.com/en/products/jush/  
Contemporaneous banlist: https://yugiohblog.konami.com/2025/ycs/2025-04-ycs-houston/a-surprise-forbidden-limited-list/  
Full historical restriction reference: https://www.yugiohcardguide.com/ban-list/limited-and-forbidden-card-list-2025-04-07.html

## 1. Extract into the existing Git repository ROOT

Your folder in the screenshot was approximately:

`X:\GRAVETALE Studios\Website\odd-resonance-589b\`

**Extract the contents of this ZIP directly into that directory**, not into `public` and not into the old Node app folder. This adds the following files:

```text
odd-resonance-589b/                  <- existing repo root
├─ public/                          <- existing Pages output folder
│  ├─ index.html                    <- your existing site; leave alone
│  ├─ style.css                     <- your existing CSS; leave alone
│  ├─ assets/ ...                   <- leave alone
│  └─ gog/                          <- NEW
│     ├─ index.html                 <- store homepage and events
│     ├─ home.css / home.js
│     ├─ site-header.css            <- shared navigation
│     ├─ styles.css / app.js        <- house-format list assets
│     ├─ house-format/index.html
│     └─ deckbuilder/ ...
├─ functions/                       <- NEW; must be sibling of public/
│  └─ gog/api/[[path]].js            <- Cloudflare Pages Functions API
├─ database/                        <- NEW
│  ├─ schema.sql
│  ├─ seed.sql
│  ├─ seed-source.txt
│  └─ make-seed.py
├─ tests/                           <- NEW
│  └─ test-cloudflare.mjs
└─ SETUP.md                         <- this document
```

Do NOT copy the previous standalone Node `server.js`, `start.bat`, or SQLite database into your Pages repository. Cloudflare Pages does not run them. This version uses **Cloudflare Pages Functions + D1**.

## 2. Create a Cloudflare D1 database

1. Log into https://dash.cloudflare.com/.
2. Go to **Workers & Pages** / **Storage & databases** / **D1** (Cloudflare navigation wording changes from time to time).
3. Create a D1 database named: **`gog-house-format`**.
4. On Windows, open a terminal **in the root of `odd-resonance-589b`**. In File Explorer, click the address bar, type `cmd`, and press Enter.
5. Run these commands **one at a time**:

```cmd
npx wrangler login
npx wrangler d1 execute gog-house-format --remote --file=./database/schema.sql
npx wrangler d1 execute gog-house-format --remote --file=./database/seed.sql
```

Wrangler may ask to install itself or confirm SQL execution. Accept the prompts if the account and database shown are yours.

**Important:** `--remote` is required, otherwise you only initialise a local development copy. The `seed.sql` file supplies the historical April 2025 list; you do not have to enter individual cards.

Build and import the verified deckbuilder catalogue after a fresh schema/seed setup:

```cmd
node database/sync-catalogue.mjs database/catalogue-import.sql
npx wrangler d1 execute gog-house-format --remote --file=./database/catalogue-import.sql
```

`sync-catalogue.mjs` downloads current metadata from YGOPRODeck, records evidence for known IDs, and writes only playable cards whose original TCG date is on or before the cutoff. When the provider omits an original TCG date or replaces it with a later reprint date, the importer and API share the reviewed evidence in `functions/gog/api/release-evidence-overrides.js`. Add an override only after checking a first-party release source and cover it in `tests/gog/catalogue-import.mjs`. The generated `database/catalogue-import.sql` is intentionally ignored by Git. Delete it after execution or regenerate it when a reviewed metadata refresh is needed.

Do not add YGOPRODeck's `format=tcg` filter to this import or fallback lookup. That listing omits some historically released TCG cards, including Cyberdark Chimera. Fetch the full metadata catalogue and filter by the verified original `tcg_date` locally. The date is the original TCG release across regions, not a UK/European-only date; BLMM records correctly use 13 June 2025. Missing dates and first TCG releases after 1 August 2025 remain excluded, regardless of earlier OCG releases. The importer checks that it received the advertised number of unique cards before marking the catalogue complete. `node tests/gog/catalogue-import.mjs` covers this omission, the inclusive cutoff, later reprints, search/artwork indexes and restriction preservation.

Verify that it worked:

```cmd
npx wrangler d1 execute gog-house-format --remote --command="SELECT status, COUNT(*) AS cards FROM entries GROUP BY status;"
```

Expected numbers: Forbidden **109**, Limited **82**, Semi-Limited **16**. (The SQL status names are `forbidden`, `limited`, `semi_limited`.)

Do **not** reinitialise or delete the database after you've begun editing: it stores your list versions and administrator account.

### Upgrade an existing populated database

Never rerun `seed.sql` on an established site. Inspect first, apply the additive migration once, then generate and execute the catalogue import:

```cmd
npx wrangler d1 execute gog-house-format --remote --command="PRAGMA table_info(cards_cache);"
npx wrangler d1 execute gog-house-format --remote --file=./database/migrations/0002_deckbuilder_catalogue.sql
node database/sync-catalogue.mjs database/catalogue-import.sql
npx wrangler d1 execute gog-house-format --remote --file=./database/catalogue-import.sql
```

The migration and import enrich card metadata and may fill an unambiguous missing `entries.card_id`; they do not edit restriction statuses, notes, versions, draft state or administrator data. Fingerprint those records before and after a production migration.

If an established catalogue predates the reviewed release-evidence overrides, apply the additive repair after deploying the matching function code:

```cmd
npx wrangler d1 execute gog-house-format --remote --file=./database/migrations/0008_release_evidence_overrides.sql
```

`0008_release_evidence_overrides.sql` restores the 31 eligible Duelist's Advance cards and `Migratory Zereort` that were hidden by missing or overwritten provider dates. It upserts only catalogue evidence, search and artwork rows, refreshes catalogue metadata, and clears stale search responses. It does not change house restrictions, versions, drafts, events, administrators or sessions. The migration is repeat-safe.

To add the Guild of Games homepage event schedule to an existing database, run the idempotent events migration once:

```cmd
npx wrangler d1 execute gog-house-format --remote --file=./database/migrations/0003_events.sql
```

This creates only the event tables and the two recurring series. It does not modify house-format versions, entries, card metadata, administrators, sessions, or R2 usage records.

Apply the catalogue read-efficiency index as well. This keeps the initial deckbuilder page within a small D1 row-read budget:

```cmd
npx wrangler d1 execute gog-house-format --remote --file=./database/migrations/0004_catalogue_query_index.sql
```

Then add the indexed partial-name search table. Run this after the catalogue import:

```cmd
npx wrangler d1 execute gog-house-format --remote --file=./database/migrations/0005_card_name_search.sql
```

Apply the image storage counter before deploying the cache optimisation:

```cmd
npx wrangler d1 execute gog-house-format --remote --file=./database/migrations/0006_image_storage_counter.sql
```

This additive migration totals existing image records once. Triggers maintain the counter on every ledger change. Each new image atomically reserves its bytes before an R2 upload; concurrent uploads share the same 5 GB ceiling. Successful uploads transfer the reservation to the image ledger in a transaction. If an upload or final accounting has an uncertain outcome, its reservation stays counted conservatively. Do not remove such reservations without confirming the object is absent or already accounted for. No restriction, event, administrator or session records are changed.

Deck validation reuses its current result when only card order or presentation changes, remapping warning positions to the displayed cards. Changes to IDs, copy counts or deck sections still validate on the server. Imports retain their independent server checks, and exports retain their draft warnings. Deck saves remain local to the browser; Undo/Redo advances the save revision so it does not create a false conflict copy.

Saved card restrictions are a cache, not the current rule authority. Every server validation refreshes card metadata and copy limits in the open deck and its undo/redo snapshots, preserving card identities, artwork, ordering and edits. The deckbuilder checks for published versions when returning to the tab or reconnecting; a successful manager publication also notifies other same-origin tabs. Checks are coalesced, unchanged versions do not reload the catalogue or revalidate, and there is no background polling. Draft changes do not broadcast. `node tests/gog/browser-rules-refresh.mjs` exercises saved Limited-to-Unlimited cards, publication updates, history and request counts using mocked API responses in a real local browser.

### Event finish times and the refreshed public pages

For an existing event database, apply `0007_event_end_times.sql` **once**, before deploying the updated function. First check `PRAGMA table_info(recurring_events);` for the `end_time` column; skip this migration if it has already been applied. Fresh databases already include it in `schema.sql` and `seed.sql`.

This repository uses dashboard-managed Pages bindings, so use the verified production database UUID when there is no local Wrangler binding configuration:

```cmd
npx wrangler d1 execute aec66a35-3c9b-460d-8721-abeea167770a --remote --file=./database/migrations/0007_event_end_times.sql
```

The migration adds finish times to recurring events, occurrence overrides and one-off events. Both recurring series default to **17:30–21:00, Europe/London**. Existing cancellations and descriptions are preserved; an explicitly customised start time remains unchanged. Administrators can edit both times for the displayed occurrence or a one-off event. A finish time must follow its start time on the same day; leave both blank for an unannounced one-off schedule.

The event illustrations in `public/gog/assets/` are static Pages assets with source credits in `CREDITS.md`. They do not use the card-image function, D1 or R2. The public-page browser check is `node tests/gog/browser-public-pages.mjs [origin]`; it checks responsive layouts, matching headers, event times, combined filters and card lookup without editing production data.

### Monthly Thursday event schedule

The monthly event layout is backward-compatible with the existing event schema. To normalize the stored series rules as well, apply `0009_monthly_event_schedule.sql` once to an existing event database:

```cmd
npx wrangler d1 execute aec66a35-3c9b-460d-8721-abeea167770a --remote --file=./database/migrations/0009_monthly_event_schedule.sql
```

This adds the recurrence pattern field, schedules Advanced Format on each Thursday except the last, and moves House Format to the final Thursday. Existing per-date overrides remain in the database; only dates belonging to the new current-month schedule are displayed.

## 3. Bind D1 to your existing Cloudflare Pages project

In Cloudflare **Workers & Pages → your Pages project → Settings → Bindings**, add a **D1 database** binding:

| Setting | Enter |
| --- | --- |
| Variable name | `GOG_DB` |
| Database | `gog-house-format` |
| Environment | Production (add Preview too if wanted) |

Save the binding. **Redeploy after changing bindings** so your Pages Functions see them.

This database is independent of any database your GRAVETALE site may already use.

## 4. Set up your private administrator creation token

You must set **two** private Cloudflare Pages secrets before the FIRST administrator is created. The setup token prevents someone else registering first. The separate authentication pepper protects stored password proofs and is **permanently required for future logins**.

In a Windows terminal, generate **two different** strong random values:

```cmd
node -e "const c=require('crypto'); console.log('SETUP TOKEN: '+c.randomBytes(32).toString('hex')); console.log('AUTH PEPPER: '+c.randomBytes(32).toString('hex'))"
```

Copy both values into a password manager. In **Workers & Pages → your Pages project → Settings → Variables and Secrets**, add **TWO encrypted secrets** (Production):

| Secret name | Value | Lifetime |
| --- | --- | --- |
| `GOG_SETUP_TOKEN` | The first random token printed | First-run account creation only; may be removed afterward |
| `GOG_AUTH_PEPPER` | The second random token printed | **Permanent: must be retained for all administrator logins and password changes** |

**Never put either value into Git, HTML, browser JavaScript or screenshots.** The first token is entered only during admin setup; the pepper is never sent to browsers.

Authentication deliberately uses PBKDF2-HMAC-SHA256 in the browser plus a server-side HMAC secured with `GOG_AUTH_PEPPER`. This preserves expensive password derivation without exceeding Cloudflare Free Workers' ~10 ms CPU budget. If you lose or rotate `GOG_AUTH_PEPPER` without a corresponding migration, **you won't be able to log in with an existing password**. Redeploy after creating or changing secrets.

## 5. (Optional, recommended) Add card artwork storage via R2

YGOPRODeck asks users **not to repeatedly hotlink card images**. The website uses a same-origin image endpoint, which fetches and stores a card image in your own Cloudflare R2 bucket on first request. Later requests use your own saved copy.

The application enforces a **5 GB image-cache ceiling** in D1. When that ceiling is reached, it serves newly requested artwork without storing another R2 object. It also checks Cloudflare's edge cache before R2 and keeps a D1 usage ledger with conservative calendar-month ceilings of **100,000 Class A** and **1,000,000 Class B** operations. These are 10% of R2's included monthly allowances, leaving room for billing-cycle overlap, maintenance commands and other account activity. At the Class A ceiling, uncached artwork can still be fetched and edge-cached without an R2 write. At the Class B ceiling, the endpoint returns placeholder artwork instead of reading R2.

The counters cover operations made by this application. Check the R2 dashboard for account-wide usage from Wrangler, the dashboard or any other bucket.

1. In Cloudflare **R2 Object Storage**, create a private bucket named `gog-card-images`.
2. In your Pages project's **Settings → Bindings**, add an **R2 bucket** binding:
   - Variable name: **`GOG_IMAGES`**
   - Bucket: **`gog-card-images`**
3. Redeploy your Pages project after saving the binding.

If R2 is not configured, the site still works normally for **search, card statuses and editing**, but displays styled placeholder artwork instead of fetching images. R2 might require enabling billing depending on your Cloudflare account.

## 6. Push the overlay to your existing Cloudflare Pages Git repository

Check in Cloudflare Pages that the **build output directory** is your existing **`public`** folder, and that Git deployment is used (the screenshots showed `.git` in your repo root).

Using GitHub Desktop or your usual Git workflow, commit and push the files added by the ZIP. If you prefer commands (from the repo root):

```cmd
git add public/gog functions/gog database tests SETUP.md
git commit -m "Add standalone JUSH house format"
git push
```

Do not add an unrelated `wrangler.toml` from the old app: this overlay is meant to use your **existing Pages project settings** without replacing them.

Wait for Cloudflare's deployment to finish, then open the Guild of Games homepage:

**https://gravetalestudios.com/gog/**

The house-format card list is available at:

**https://gravetalestudios.com/gog/house-format/**

The local deckbuilder is available at:

**https://gravetalestudios.com/gog/deckbuilder/**

Decks are saved only in that browser profile. Use **Export deck -> Download complete backup** to move or protect deck documents.

Your existing `/`, `/null/`, `/outworld/`, etc. remain unchanged.

## 7. Create your administrator

1. Visit the deployed `/gog/house-format/` page.
2. Click **Manage the house list**.
3. Enter your administrator email, a password of at least 12 characters, and the `GOG_SETUP_TOKEN` from step 4.
4. After creation, the site logs you in and disables further public admin registration.
5. Use **Draft editor** to change cards, **Review & publish** to make changes public, and **Version history** to restore a prior published snapshot.

The same administrator account manages homepage events. Visit `/gog/`, click **Admin**, and edit any Thursday displayed for the current month. Those edits apply only to that date. Add one-off events in the same panel; they appear on the homepage during their event month.

The public **House tweaks** view and every `NEW` badge compare the current published status with the original `tcg-apr-2025` foundation. They do not reset when another house version is published. A card loses the marker only when its status matches that fixed baseline again.

**Sanity-check these cards:**

- `Abyss Dweller` → **Forbidden** by the April 2025 foundation.
- `Dimension Shifter` → **Limited**.
- `Ext Ryzeal` → **Semi-Limited**.
- `Dracotail Lukias` → **Unlimited** unless you intentionally restrict it (debuted in JUSH).
- A card first released in a later set (September 2025 onward) → **not returned by search and cannot be added**.

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/gog/` is 404 | Check the site output root is `public` and `public/gog/index.html` was pushed. |
| Homepage events fail to load | Inspect the event schema. Apply `0003_events.sql` if tables are absent, then apply `0007_event_end_times.sql` once if `end_time` is absent. |
| `/gog/house-format/` is 404 | Check `public/gog/house-format/index.html` was pushed. |
| `/gog/deckbuilder/` opens but the library is unavailable | Apply `0002_deckbuilder_catalogue.sql`, run the generated catalogue import, and verify `SELECT * FROM catalogue_meta;`. |
| Website opens but reports `GOG_DB` missing | Add D1 Pages binding named exactly `GOG_DB` in Production; redeploy. |
| Website reports the JUSH foundation is missing | Run both `schema.sql` and `seed.sql` with `--remote` against `gog-house-format`. |
| Administrator setup says token required | Set encrypted `GOG_SETUP_TOKEN` **and** permanent `GOG_AUTH_PEPPER` and redeploy, then use the setup token in the form. |
| Admin creation/login reports a missing pepper | Set the persistent encrypted `GOG_AUTH_PEPPER` secret in Production and redeploy. |
| Search works but pictures are placeholders | Add the optional `GOG_IMAGES` R2 binding. |
| A card doesn't appear | Only cards with a first TCG release on/before 2025-08-01 are in scope. Check the provider metadata and the reviewed evidence map; missing dates and later-reprint dates can otherwise hide eligible cards. Apply `0008_release_evidence_overrides.sql` if the live catalogue predates that repair. |
| Live list isn't changing | Admin changes stay in a **draft** until explicitly published. |
| Cloudflare deploy fails | Check build logs and confirm `functions` is *outside* `public` and your project is Git-connected Pages, not static-only Direct Upload. |

## 9. Back up the database

D1 holds your published lists, drafts and admin account. Back it up periodically:

```cmd
npx wrangler d1 export gog-house-format --remote --output=./gog-backup.sql
```

The exported SQL contains administrator password hashes and session data; **keep it private and never commit it to Git**.

## Local testing (optional)

The JavaScript and SQL regression tests work with Node.js 22.5+:

```cmd
node tests/test-cloudflare.mjs
node --test tests/gog/deckbuilder-unit.mjs
```

Tests simulate D1, HTTP requests and an API that enforces the 1 August cutoff; they do not require Cloudflare credentials. `tests/gog/browser-smoke.mjs` can additionally exercise a local `wrangler pages dev` instance using an installed Chrome browser. A live Cloudflare deployment and external simulator interoperability still require separate verification.
