export const catalogueMarkup = `
  <section class="search-zone" aria-labelledby="search-heading">
    <div class="shell">
      <div class="search-panel">
        <div class="search-heading-row">
          <div>
            <p class="search-kicker">Know your limits</p>
            <h2 id="search-heading"><span class="desktop-search-title">Check a card. Build with confidence.</span><span class="mobile-search-title">Check a card</span></h2>
            <p>Eligible cards not on the restricted list are Unlimited. Cards outside the Justice Hunters pool are not legal.</p>
          </div>
          <div class="api-state" id="api-state" hidden>
            <span class="status-dot"></span>
            <span>Catalogue temporarily offline. Showing local matches.</span>
          </div>
        </div>

        <label class="search-field-label visually-hidden" id="card-search-label" for="card-search">Search card names or archetypes</label>
        <div class="search-tools-row">
          <div class="search-control">
            <span class="search-icon" aria-hidden="true">
              <svg class="jush-icon" aria-hidden="true" focusable="false"><use href="/gog/assets/jush/icons/sprite.svg#jush-icon-search"></use></svg>
            </span>
            <input id="card-search" type="search" autocomplete="off" spellcheck="false" placeholder="Search card names or archetypes…" aria-labelledby="search-heading card-search-label" aria-controls="search-suggestions">
            <button class="clear-search" id="clear-search" type="button" aria-label="Clear search" hidden>×</button>
            <span class="search-spinner" id="search-spinner" hidden aria-label="Searching"></span>
          </div>
          <button class="button filter-toggle" id="filter-toggle" type="button" aria-expanded="false" aria-controls="filters-panel">
            <svg class="jush-icon" aria-hidden="true" focusable="false"><use href="/gog/assets/jush/icons/sprite.svg#jush-icon-filter"></use></svg>
            Filters
            <span class="filter-count" id="filter-count" hidden>0</span>
          </button>
        </div>

        <div class="search-suggestions" id="search-suggestions" role="listbox" aria-label="Card search results" hidden></div>
      </div>
    </div>
  </section>

  <section class="list-section" id="list-workspace">
    <div class="shell">
      <div class="list-workspace-grid">
        <aside class="filters-panel" id="filters-panel" aria-label="Card filters">
          <div class="filters-heading">
            <h3>Filters</h3>
            <button class="text-button" id="clear-filters" type="button">Clear</button>
          </div>
          <fieldset class="filter-group status-filter">
            <legend class="filter-label">Status</legend>
            <div class="chip-row">
              <label class="filter-chip forbidden"><input type="checkbox" value="forbidden" data-filter="status"><span>Forbidden</span></label>
              <label class="filter-chip limited"><input type="checkbox" value="limited" data-filter="status"><span>Limited</span></label>
              <label class="filter-chip semi-limited"><input type="checkbox" value="semi_limited" data-filter="status"><span>Semi-Limited</span></label>
              <label class="filter-chip unlimited"><input type="checkbox" value="unlimited" data-filter="status"><span>Unlimited</span></label>
            </div>
          </fieldset>

          <fieldset class="filter-group category-filter">
            <legend class="filter-label">Card type</legend>
            <div class="chip-row filter-choice-grid">
              <label class="filter-chip neutral"><input type="checkbox" value="Monster" data-filter="category"><span>Monster</span></label>
              <label class="filter-chip spell"><input type="checkbox" value="Spell" data-filter="category"><span>Spell</span></label>
              <label class="filter-chip trap"><input type="checkbox" value="Trap" data-filter="category"><span>Trap</span></label>
            </div>
          </fieldset>

          <fieldset class="filter-group subtype-group" id="subtype-group">
            <legend class="filter-label">Monster subtype</legend>
            <div class="chip-row filter-choice-grid">
              <label class="filter-chip neutral"><input type="checkbox" value="Normal" data-filter="subtype"><span>Normal</span></label>
              <label class="filter-chip neutral"><input type="checkbox" value="Effect" data-filter="subtype"><span>Effect</span></label>
              <label class="filter-chip neutral"><input type="checkbox" value="Ritual" data-filter="subtype"><span>Ritual</span></label>
              <label class="filter-chip neutral"><input type="checkbox" value="Fusion" data-filter="subtype"><span>Fusion</span></label>
              <label class="filter-chip neutral"><input type="checkbox" value="Synchro" data-filter="subtype"><span>Synchro</span></label>
              <label class="filter-chip neutral"><input type="checkbox" value="Xyz" data-filter="subtype"><span>Xyz</span></label>
              <label class="filter-chip neutral"><input type="checkbox" value="Pendulum" data-filter="subtype"><span>Pendulum</span></label>
              <label class="filter-chip neutral"><input type="checkbox" value="Link" data-filter="subtype"><span>Link</span></label>
            </div>
          </fieldset>

          <div class="filter-footer">
            <label class="sort-control">Sort
              <select id="sort-select">
                <option value="status-name">Status, then name</option>
                <option value="name">Card name</option>
                <option value="type">Card type</option>
              </select>
            </label>
          </div>
        </aside>

        <div class="results-column">
          <div class="results-header">
            <div>
              <h2 id="results-title">Forbidden &amp; Limited List</h2>
            </div>
            <div class="results-controls">
              <div class="list-view-toggles" role="group" aria-label="Choose card list view">
                <button type="button" data-list-view="current" aria-pressed="true">All</button>
                <button type="button" data-list-view="changes" aria-pressed="false">House changes</button>
                <button type="button" data-list-view="recent" aria-pressed="false">Recent</button>
              </div>
              <p class="results-count" id="results-count" aria-live="polite">Loading cards…</p>
            </div>
          </div>

          <div class="active-filters" id="active-filters" hidden aria-label="Active filters"></div>

          <div class="restriction-key" aria-label="Filter by copy limit">
            <button type="button" data-rule-filter="forbidden"><span>0</span> Forbidden</button>
            <button type="button" data-rule-filter="limited"><span>1</span> Limited</button>
            <button type="button" data-rule-filter="semi_limited"><span>2</span> Semi-Limited</button>
            <button type="button" data-rule-filter="unlimited"><span>3</span> Unlimited</button>
          </div>

          <div id="results-panel">
            <div class="card-list" id="card-list" aria-live="polite" aria-busy="true"></div>
            <div class="empty-state" id="empty-state" hidden>
              <div class="empty-symbol" aria-hidden="true">◇</div>
              <h3>No cards match those filters</h3>
              <p>Clear a filter or try another search.</p>
              <button class="button ghost-dark" id="empty-clear" type="button">Clear filters</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

`;

export const cardDetailMarkup = `<dialog class="modal card-modal" id="card-modal" aria-label="Card details">
  <div class="detail-controls">
    <button class="modal-close" type="button" data-close-dialog="card-modal" aria-label="Close card details">
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 5 14 14M19 5 5 19"/></svg>
    </button>
  </div>
  <div class="card-detail-loading" id="card-detail-loading" role="status">
    <span class="large-spinner"></span><p>Loading card details…</p>
  </div>
  <div class="card-detail" id="card-detail" hidden>
    <div class="detail-art">
      <a class="detail-print" id="detail-print" target="_blank" rel="noopener" aria-label="Open full-size card image in a new tab">
        <img id="detail-image" alt="" width="421" height="614">
        <span class="detail-enlarge" aria-hidden="true">Full size ↗</span>
      </a>
    </div>
    <header class="detail-heading">
      <p class="detail-kind" id="detail-type"></p>
      <h2 id="detail-name"></h2>
    </header>
    <div class="card-detail-copy">
      <dl class="detail-stats" id="detail-meta" hidden></dl>
      <div class="detail-ruling">
        <div class="detail-ruling-head">
          <strong id="detail-status"></strong>
          <span class="detail-change" id="detail-house-change" hidden>House change</span>
        </div>
        <p><strong id="detail-copy-count"></strong> across Main, Extra and Side Decks combined.</p>
      </div>
      <section class="detail-text" aria-labelledby="detail-text-label">
        <h3 id="detail-text-label">Card text</h3>
        <p id="detail-description"></p>
      </section>
      <section class="detail-house-note" id="detail-note" hidden>
        <h3>House-format note</h3>
        <p></p>
      </section>
    </div>
  </div>
</dialog>
`;

// A previously cached Cards script may still request the complete template.
export const viewerMarkup = catalogueMarkup + cardDetailMarkup;
