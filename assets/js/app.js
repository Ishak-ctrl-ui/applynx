/* AppKittie Modern Frontend Client (v4)
   Full feature parity with AppKittie:
   - Inline SVG sparkline curve engine (Growth 30D)
   - 2-Tier stacked table cells with relative dates
   - Interactive filter pill popovers + removable active tag chips
   - Modern smooth analytics spline charts
*/

const $ = (id) => document.getElementById(id);

// Global Filter & Pagination State
const STATE = {
  search: '',
  scope: 'title',
  cat: '',
  tier: '',
  exclude_cats: new Set(),
  rel_after: '',
  price: '',
  mr: 0,
  mdl: 0,
  mrate: 0,
  sort: 'rev',
  page: 1,
  per: 100,
  total: 0,
  rows: [],
  cats: []
};

let WATCH = new Set();
let CURRENT_APP = null;
let SEARCH_HITS = [];

/* ==================== FORMATTERS & HELPERS ==================== */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt$(n) {
  n = +n || 0;
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(n);
}

function fmtN(n) {
  n = +n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return '' + Math.round(n);
}

function ratingsShort(rc) {
  rc = +rc || 0;
  if (rc >= 1e6) return (rc / 1e6).toFixed(1) + 'M';
  if (rc >= 1e3) return (rc / 1e3).toFixed(1) + 'K';
  return '' + Math.round(rc);
}

function formatRelativeDate(dateStr) {
  if (!dateStr) return { relative: '—', exact: '—' };
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return { relative: '—', exact: dateStr.slice(0, 10) };

  const now = new Date();
  const diffDays = Math.max(0, Math.floor((now - d) / (1000 * 60 * 60 * 24)));
  
  let relative = '';
  if (diffDays === 0) relative = 'today';
  else if (diffDays < 30) relative = `${diffDays}d ago`;
  else if (diffDays < 365) relative = `${Math.floor(diffDays / 30)}mo ago`;
  else relative = `${(diffDays / 365).toFixed(0)}y ago`;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const exact = `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  return { relative, exact };
}

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ==================== INLINE SVG SPARKLINE ENGINE ==================== */
/**
 * Generates an ultra-crisp, smooth cubic bezier vector sparkline SVG.
 * points: array of 7 numeric values
 * isUp: boolean indicating positive or negative trend
 */
function renderSparklineSVG(points, isUp, width = 76, height = 22) {
  if (!points || points.length < 2) {
    // Fallback placeholder flat line
    return `<svg class="sparkline-svg" viewBox="0 0 ${width} ${height}">
      <line x1="2" y1="${height / 2}" x2="${width - 2}" y2="${height / 2}" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="2 2" />
    </svg>`;
  }

  const minV = Math.min(...points);
  const maxV = Math.max(...points);
  const range = maxV - minV || 1;
  const pad = 3;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  // Map data points to coordinates
  const coords = points.map((val, idx) => {
    const x = pad + (idx / (points.length - 1)) * innerW;
    const y = pad + innerH - ((val - minV) / range) * innerH;
    return { x, y };
  });

  // Build smooth cubic bezier spline path
  let pathD = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const curr = coords[i];
    const next = coords[i + 1];
    const cp1x = curr.x + (next.x - curr.x) / 2;
    const cp1y = curr.y;
    const cp2x = curr.x + (next.x - curr.x) / 2;
    const cp2y = next.y;
    pathD += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${next.x.toFixed(1)} ${next.y.toFixed(1)}`;
  }

  // Area fill under curve
  const fillD = `${pathD} L ${coords[coords.length - 1].x.toFixed(1)} ${height} L ${coords[0].x.toFixed(1)} ${height} Z`;

  const strokeColor = isUp ? '#059669' : '#e11d48';
  const fillColor = isUp ? 'rgba(16, 185, 129, 0.15)' : 'rgba(244, 63, 94, 0.15)';

  return `<svg class="sparkline-svg" viewBox="0 0 ${width} ${height}">
    <path d="${fillD}" fill="${fillColor}" />
    <path d="${pathD}" fill="none" stroke="${strokeColor}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
}

/* ==================== DATA API & PAGINATION ==================== */
function buildQueryParams() {
  const p = new URLSearchParams();
  if (STATE.search) p.set('search', STATE.search);
  if (STATE.scope) p.set('scope', STATE.scope);
  if (STATE.cat) p.set('cat', STATE.cat);
  if (STATE.tier) p.set('tier', STATE.tier);
  if (STATE.exclude_cats.size > 0) p.set('exclude_cats', Array.from(STATE.exclude_cats).join(','));
  if (STATE.rel_after) p.set('rel_after', STATE.rel_after);
  if (STATE.price) p.set('price', STATE.price);
  if (STATE.mr > 0) p.set('mr', STATE.mr);
  if (STATE.mdl > 0) p.set('mdl', STATE.mdl);
  if (STATE.mrate > 0) p.set('mrate', STATE.mrate);
  p.set('sort', STATE.sort);
  p.set('page', STATE.page);
  p.set('per', STATE.per);
  return p.toString();
}

function renderSkeletonRows(count = 10) {
  $('tbody').innerHTML = Array(count).fill(0).map(() => `
    <tr>
      <td>
        <div class="app-info-cell">
          <div class="shimmer-block" style="width:44px;height:44px;border-radius:11px;flex-shrink:0"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px">
            <div class="shimmer-block" style="width:140px;height:14px"></div>
            <div class="shimmer-block" style="width:90px;height:10px"></div>
          </div>
        </div>
      </td>
      <td><div class="shimmer-block" style="width:70px;height:18px;border-radius:12px"></div></td>
      <td class="align-right"><div class="shimmer-block" style="width:50px;height:14px;margin-left:auto"></div></td>
      <td class="align-right"><div class="shimmer-block" style="width:60px;height:14px;margin-left:auto"></div></td>
      <td class="align-right"><div class="shimmer-block" style="width:76px;height:20px;margin-left:auto"></div></td>
      <td class="align-right"><div class="shimmer-block" style="width:45px;height:14px;margin-left:auto"></div></td>
      <td class="align-right"><div class="shimmer-block" style="width:60px;height:14px;margin-left:auto"></div></td>
      <td class="align-right"><div class="shimmer-block" style="width:55px;height:14px;margin-left:auto"></div></td>
      <td class="align-center"><div class="shimmer-block" style="width:24px;height:24px;border-radius:6px;margin:auto"></div></td>
    </tr>
  `).join('');
}

let STATIC_APPS = null;

async function loadLibPage() {
  renderSkeletonRows(10);
  try {
    const res = await fetch('/api/apps?' + buildQueryParams());
    if (res.ok) {
      const data = await res.json();
      STATE.rows = data.rows || [];
      STATE.total = data.total || 0;
      if (data.cats && data.cats.length) {
        STATE.cats = data.cats;
        populateCategoryPopovers(data.cats);
      }
      renderTable();
      updateActiveFilterBadges();
      return;
    }
  } catch (err) {
    // Server endpoint not reachable (e.g. static hosting on Netlify)
  }

  // Netlify / Static JSON Fallback
  if (!STATIC_APPS) {
    try {
      const res = await fetch('data/apps.json');
      const data = await res.json();
      STATIC_APPS = data.apps || [];
      STATE.cats = data.cats || [];
      populateCategoryPopovers(STATE.cats);
      $('sideLibStatus').textContent = `${STATIC_APPS.length.toLocaleString()} apps loaded`;
      $('sideBuildInfo').textContent = `Live Bundle (${data.updated || 'today'})`;
    } catch (e) {
      $('tbody').innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--rose-dark)">Failed to load data: ${esc(e.message)}</td></tr>`;
      return;
    }
  }

  // Fast In-Memory Filtering (sub-2ms)
  let filtered = STATIC_APPS.slice();
  if (STATE.search) {
    const q = STATE.search.toLowerCase();
    if (STATE.scope === 'title') filtered = filtered.filter((a) => (a.title || '').toLowerCase().includes(q));
    else if (STATE.scope === 'dev') filtered = filtered.filter((a) => (a.dev || '').toLowerCase().includes(q));
    else if (STATE.scope === 'bundle') filtered = filtered.filter((a) => (a.bundle || '').toLowerCase().includes(q) || String(a.id) === q);
    else filtered = filtered.filter((a) => (a.title || '').toLowerCase().includes(q) || (a.dev || '').toLowerCase().includes(q) || (a.bundle || '').toLowerCase().includes(q));
  }
  if (STATE.cat) filtered = filtered.filter((a) => a.cat === STATE.cat);
  if (STATE.tier) filtered = filtered.filter((a) => String(a.tier) === String(STATE.tier));
  if (STATE.exclude_cats.size > 0) filtered = filtered.filter((a) => !STATE.exclude_cats.has(a.cat));
  if (STATE.rel_after) filtered = filtered.filter((a) => (a.rel || '') >= STATE.rel_after);
  if (STATE.price === 'free') filtered = filtered.filter((a) => !a.price || a.price === 0);
  else if (STATE.price === 'paid') filtered = filtered.filter((a) => a.price > 0);
  if (STATE.mr > 0) filtered = filtered.filter((a) => (a.rev || 0) >= STATE.mr);
  if (STATE.mdl > 0) filtered = filtered.filter((a) => (a.dl || 0) >= STATE.mdl);
  if (STATE.mrate > 0) filtered = filtered.filter((a) => (a.rating || 0) >= STATE.mrate);

  // Sorting
  const s = STATE.sort;
  if (s === 'dl') filtered.sort((a, b) => (b.dl || 0) - (a.dl || 0));
  else if (s === 'growth') filtered.sort((a, b) => (b.growth || 0) - (a.growth || 0));
  else if (s === 'ratings') filtered.sort((a, b) => (b.rc || 0) - (a.rc || 0));
  else if (s === 'rank') filtered.sort((a, b) => ((a.tier || 4) - (b.tier || 4)) || ((a.rank || 999) - (b.rank || 999)));
  else if (s === 'new') filtered.sort((a, b) => (b.rel || '').localeCompare(a.rel || ''));
  else filtered.sort((a, b) => (b.rev || 0) - (a.rev || 0));

  STATE.total = filtered.length;
  const start = (STATE.page - 1) * STATE.per;
  STATE.rows = filtered.slice(start, start + STATE.per);
  renderTable();
  updateActiveFilterBadges();
}

async function loadWatchlist() {
  try {
    const data = await fetchJSON('/api/watch');
    WATCH = new Set(data.rows.map((r) => String(r.app_id || r.id)));
    $('sideWatchCount').textContent = WATCH.size;
    renderWatchTable(data.rows);
    return;
  } catch (err) {
    // LocalStorage fallback for Netlify
  }
  try {
    const local = JSON.parse(localStorage.getItem('appkittie_watch') || '[]');
    WATCH = new Set(local);
    $('sideWatchCount').textContent = WATCH.size;
    const watchRows = (STATIC_APPS || []).filter((a) => WATCH.has(String(a.id)));
    renderWatchTable(watchRows);
  } catch (e) { /* ignore */ }
}

async function toggleWatch(id) {
  id = String(id);
  try {
    if (WATCH.has(id)) {
      await fetchJSON('/api/watch?id=' + encodeURIComponent(id), { method: 'DELETE' });
      WATCH.delete(id);
    } else {
      await fetchJSON('/api/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      WATCH.add(id);
    }
  } catch (err) {
    // LocalStorage fallback for Netlify
    if (WATCH.has(id)) WATCH.delete(id);
    else WATCH.add(id);
    localStorage.setItem('appkittie_watch', JSON.stringify(Array.from(WATCH)));
  }
  $('sideWatchCount').textContent = WATCH.size;
  renderTable();
}

/* ==================== TABLE RENDERING (APPKITTIE 2-TIER) ==================== */
function renderTable() {
  const totalPages = Math.max(1, Math.ceil(STATE.total / STATE.per));
  $('tableRowCount').textContent = `Showing ${STATE.rows.length} of ${STATE.total.toLocaleString()} apps · page ${STATE.page}/${totalPages}`;
  $('pgInfo').textContent = `page ${STATE.page}/${totalPages}`;
  $('pgPrev').disabled = STATE.page <= 1;
  $('pgNext').disabled = STATE.page >= totalPages;

  if (!STATE.rows.length) {
    $('tbody').innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--txt-muted)">No matching apps found. Try adjusting your filters.</td></tr>`;
    return;
  }

  const appleLogoSVG = `<svg class="platform-apple-icon" viewBox="0 0 170 170"><path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.19-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.35.13-9.16-1.9-14.42-6.08-3.7-3.04-7.6-7.77-11.73-14.19-6.3-9.88-11.41-21.68-15.34-35.41-3.92-13.72-5.88-26.47-5.88-38.25 0-14.86 3.63-27.18 10.88-36.95 7.25-9.78 16.48-14.84 27.7-15.19 4.36 0 9.28 1.15 14.77 3.45 5.48 2.3 9.4 3.51 11.75 3.63 2.12 0 6.16-1.22 12.13-3.67 5.96-2.44 10.9-3.56 14.82-3.36 14.36.72 25.43 5.91 33.22 15.57-12.44 7.55-18.47 18.06-18.08 31.54.38 10.51 4.36 19.34 11.95 26.51 7.58 7.16 16.59 11.09 27.02 11.78-2.61 7.91-5.69 15.65-9.24 23.23zM119.22 31.84c0-7.72 2.76-14.92 8.27-21.61 5.51-6.68 12.35-10.74 20.52-12.18.39 1.19.59 2.45.59 3.79 0 7.85-3 15.42-9 22.7-6 7.28-13.11 11.51-21.32 12.69-.38-1.78-.58-3.36-.58-4.73z"/></svg>`;

  $('tbody').innerHTML = STATE.rows.map((app) => {
    const isWatched = WATCH.has(String(app.id));
    const hasGrowth = app.growth != null && !isNaN(app.growth);
    const growthVal = hasGrowth ? app.growth : null;
    const isUp = (growthVal ?? 0) >= 0;
    const growthPercent = hasGrowth ? (isUp ? '+' : '') + (growthVal * 100).toFixed(1) + '%' : '—';
    const growthClass = hasGrowth ? (isUp ? 'up' : 'down') : 'flat';
    const growthArrow = hasGrowth ? (isUp ? '↗' : '↘') : '';

    const sparklinePoints = (app.spark && app.spark.length >= 2) ? app.spark : null;
    const sparklineHTML = sparklinePoints
      ? renderSparklineSVG(sparklinePoints, isUp)
      : `<span class="spark-none" title="Needs 2+ daily snapshots">—</span>`;

    const relDates = formatRelativeDate(app.rel);
    const updDates = formatRelativeDate(app.updated || app.rel);

    return `
      <tr class="app-row" data-id="${app.id}">
        <!-- APP -->
        <td>
          <div class="app-info-cell">
            <img class="app-icon-img" src="${esc(app.icon)}" loading="lazy" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 44 44\\'><rect width=\\'44\\' height=\\'44\\' rx=\\'11\\' fill=\\'%23f1f5f9\\'/></svg>'" />
            <div class="app-text-block">
              <span class="app-title-name" title="${esc(app.title)}">${esc(app.title)}</span>
              <span class="app-dev-sub" title="${esc(app.dev)}">
                ${appleLogoSVG} ${esc(app.dev || 'Developer')}
              </span>
            </div>
          </div>
        </td>

        <!-- CATEGORY -->
        <td>
          <span class="category-badge-pill">${esc(app.cat || 'Apps')}</span>
        </td>

        <!-- DOWNLOADS (2-Tier) -->
        <td class="align-right">
          <div class="metric-stacked">
            <span class="metric-primary">${fmtN(app.dl)}</span>
            <span class="metric-delta ${growthClass}">${growthPercent} ${growthArrow}</span>
          </div>
        </td>

        <!-- REVENUE (2-Tier) -->
        <td class="align-right">
          <div class="metric-stacked">
            <span class="metric-primary">${fmt$(app.rev)}</span>
            <span class="metric-delta ${growthClass}">${growthPercent} ${growthArrow}</span>
          </div>
        </td>

        <!-- GROWTH 30D (Sparkline + Delta) -->
        <td class="align-right">
          <div class="growth-sparkline-cell">
            <span class="metric-delta ${growthClass}">${growthPercent} ${growthArrow}</span>
            ${sparklineHTML}
          </div>
        </td>

        <!-- RATING (2-Tier) -->
        <td class="align-right">
          <div class="rating-stacked">
            <span class="rating-score"><span class="rating-star">★</span> ${(app.rating || 0).toFixed(1)}</span>
            <span class="rating-count-sub">${ratingsShort(app.rc)} reviews</span>
          </div>
        </td>

        <!-- RELEASED (2-Tier) -->
        <td class="align-right">
          <div class="date-stacked">
            <span class="date-relative">${relDates.relative}</span>
            <span class="date-exact">${relDates.exact}</span>
          </div>
        </td>

        <!-- LAST UPDATE (2-Tier) -->
        <td class="align-right">
          <div class="date-stacked">
            <span class="date-relative">${updDates.relative}</span>
            <span class="date-exact">${updDates.exact}</span>
          </div>
        </td>

        <!-- ACTIONS -->
        <td class="align-center">
          <button class="btn-fav-star ${isWatched ? 'active' : ''}" data-fav="${app.id}" title="${isWatched ? 'Tracked in favorites' : 'Add to favorites'}">
            ★
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // Attach row click to open detail modal
  document.querySelectorAll('.app-row').forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest('[data-fav]')) return;
      openDetail(tr.dataset.id);
    };
  });

  // Attach favorite star click
  document.querySelectorAll('[data-fav]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      toggleWatch(btn.dataset.fav);
    };
  });
}

function renderWatchTable(rows) {
  if (!rows || !rows.length) {
    $('wtbody').innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--txt-muted)">No tracked apps yet. Click the ★ icon on any app to monitor it.</td></tr>`;
    return;
  }

  $('wtbody').innerHTML = rows.map((app) => {
    const hasGrowth = app.growth != null && !isNaN(app.growth);
    const isUp = (app.growth ?? 0) >= 0;
    const sparklineHTML = (app.spark && app.spark.length >= 2)
      ? renderSparklineSVG(app.spark, isUp)
      : `<span class="spark-none">—</span>`;
    return `
      <tr class="app-row" data-id="${app.id}">
        <td>
          <div class="app-info-cell">
            <img class="app-icon-img" src="${esc(app.icon)}" alt="" />
            <div class="app-text-block">
              <span class="app-title-name">${esc(app.title)}</span>
              <span class="app-dev-sub">${esc(app.dev)}</span>
            </div>
          </div>
        </td>
        <td><span class="category-badge-pill">${esc(app.cat || '—')}</span></td>
        <td class="align-right"><span class="metric-primary">${fmt$(app.rev)}</span></td>
        <td class="align-right"><span class="metric-primary">${fmtN(app.dl)}</span></td>
        <td class="align-right">
          <div class="growth-sparkline-cell">
            <span class="metric-delta ${hasGrowth ? (isUp ? 'up' : 'down') : 'flat'}">${hasGrowth ? ((isUp ? '+' : '') + (app.growth * 100).toFixed(1) + '%') : '—'}</span>
            ${sparklineHTML}
          </div>
        </td>
        <td class="align-right"><span class="rating-score">★ ${(app.rating || 0).toFixed(1)}</span></td>
        <td class="align-center">
          <button class="btn-clear-filters" data-unwatch="${app.id}" style="padding:4px 8px;font-size:11px">Remove</button>
        </td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('[data-unwatch]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      toggleWatch(b.dataset.unwatch).then(loadWatchlist);
    };
  });
}

/* ==================== FILTER POPOVERS & ACTIVE TAGS ==================== */
function populateCategoryPopovers(cats) {
  const popCatList = $('popCatList');
  if (!popCatList) return;
  popCatList.innerHTML = `<div class="popover-opt ${!STATE.cat ? 'selected' : ''}" data-val="">All Categories</div>`
    + cats.map((c) => `<div class="popover-opt ${STATE.cat === c ? 'selected' : ''}" data-val="${esc(c)}">${esc(c)}</div>`).join('');
}

function updateActiveFilterBadges() {
  let activeCount = 0;
  const tags = [];

  if (STATE.search) {
    activeCount++;
    tags.push({ label: `Search: "${STATE.search}"`, type: 'blue', remove: () => { STATE.search = ''; $('q').value = ''; } });
  }
  if (STATE.rel_after) {
    activeCount++;
    tags.push({ label: `Released: After ${STATE.rel_after}`, type: 'green', remove: () => { STATE.rel_after = ''; } });
  }
  if (STATE.cat) {
    activeCount++;
    tags.push({ label: `Category: ${STATE.cat}`, type: 'blue', remove: () => { STATE.cat = ''; } });
  }
  if (STATE.tier) {
    activeCount++;
    const tierMap = { '1': 'US Grossing', '2': 'US Genre', '3': 'Intl Grossing', '4': 'Charts' };
    tags.push({ label: `Store: ${tierMap[STATE.tier] || STATE.tier}`, type: 'blue', remove: () => { STATE.tier = ''; } });
  }
  if (STATE.exclude_cats.size > 0) {
    STATE.exclude_cats.forEach((c) => {
      activeCount++;
      tags.push({ label: `Exclude: ${c}`, type: 'pink', remove: () => { STATE.exclude_cats.delete(c); } });
    });
  }
  if (STATE.price) {
    activeCount++;
    tags.push({ label: `Price: ${STATE.price === 'free' ? 'Free Only' : 'Paid Only'}`, type: 'blue', remove: () => { STATE.price = ''; } });
  }
  if (STATE.mr > 0) {
    activeCount++;
    tags.push({ label: `Min Rev: ${fmt$(STATE.mr)}+`, type: 'green', remove: () => { STATE.mr = 0; } });
  }
  if (STATE.mdl > 0) {
    activeCount++;
    tags.push({ label: `Min DL: ${fmtN(STATE.mdl)}+`, type: 'green', remove: () => { STATE.mdl = 0; } });
  }
  if (STATE.mrate > 0) {
    activeCount++;
    tags.push({ label: `Min Rating: ★ ${STATE.mrate}+`, type: 'blue', remove: () => { STATE.mrate = 0; } });
  }

  $('activeFilterBadge').textContent = `${activeCount} filter${activeCount === 1 ? '' : 's'} active`;

  const tagsRow = $('activeTagsRow');
  tagsRow.innerHTML = tags.map((t, idx) => `
    <span class="filter-tag-chip chip-${t.type}">
      ${esc(t.label)}
      <button class="chip-close-btn" data-tag-idx="${idx}">✕</button>
    </span>
  `).join('');

  document.querySelectorAll('[data-tag-idx]').forEach((b) => {
    b.onclick = () => {
      const idx = +b.dataset.tagIdx;
      if (tags[idx] && tags[idx].remove) {
        tags[idx].remove();
        STATE.page = 1;
        loadLibPage();
      }
    };
  });

  // Sync pill active states
  $('pillTime').classList.toggle('active', !!STATE.rel_after);
  $('pillStore').classList.toggle('active', !!STATE.tier);
  $('pillCat').classList.toggle('active', !!STATE.cat);
  $('pillExclude').classList.toggle('active', STATE.exclude_cats.size > 0);
  $('pillPrice').classList.toggle('active', !!STATE.price);
  $('pillRev').classList.toggle('active', STATE.mr > 0);
  $('pillDl').classList.toggle('active', STATE.mdl > 0);
  $('pillRate').classList.toggle('active', STATE.mrate > 0);
}

function setupPopovers() {
  const pills = [
    { id: 'pillTime', pop: 'popTime', onSelect: (val) => { STATE.rel_after = val; } },
    { id: 'pillStore', pop: 'popStore', onSelect: (val) => { STATE.tier = val; } },
    { id: 'pillCat', pop: 'popCat', onSelect: (val) => { STATE.cat = val; $('pillCatLabel').textContent = val || 'Category'; } },
    { id: 'pillExclude', pop: 'popExclude', isExclude: true },
    { id: 'pillPrice', pop: 'popPrice', onSelect: (val) => { STATE.price = val; } },
    { id: 'pillRev', pop: 'popRev', onSelect: (val) => { STATE.mr = +val; $('pillRevLabel').textContent = val > 0 ? fmt$(val) : 'Min revenue'; } },
    { id: 'pillDl', pop: 'popDl', onSelect: (val) => { STATE.mdl = +val; $('pillDlLabel').textContent = val > 0 ? fmtN(val) : 'Min downloads'; } },
    { id: 'pillRate', pop: 'popRate', onSelect: (val) => { STATE.mrate = +val; $('pillRateLabel').textContent = val > 0 ? `★ ${val}+` : 'Min rating'; } },
    { id: 'pillSort', pop: 'popSort', onSelect: (val) => { STATE.sort = val; $('pillSortLabel').textContent = 'Sort: ' + val; } }
  ];

  pills.forEach((p) => {
    const pillEl = $(p.id);
    const popEl = $(p.pop);
    if (!pillEl || !popEl) return;

    pillEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = popEl.classList.contains('open');
      document.querySelectorAll('.popover-dropdown').forEach((x) => x.classList.remove('open'));
      if (!isOpen) popEl.classList.add('open');
    });

    popEl.addEventListener('click', (e) => {
      const opt = e.target.closest('.popover-opt');
      if (!opt) return;
      e.stopPropagation();

      if (p.isExclude) {
        const ex = opt.dataset.ex;
        if (ex) {
          if (STATE.exclude_cats.has(ex)) STATE.exclude_cats.delete(ex);
          else STATE.exclude_cats.add(ex);
          opt.classList.toggle('selected', STATE.exclude_cats.has(ex));
        }
      } else {
        popEl.querySelectorAll('.popover-opt').forEach((x) => x.classList.remove('selected'));
        opt.classList.add('selected');
        const val = opt.dataset.val ?? '';
        p.onSelect(val);
      }

      popEl.classList.remove('open');
      STATE.page = 1;
      loadLibPage();
    });
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.popover-dropdown').forEach((x) => x.classList.remove('open'));
  });
}

async function renderMarketCharts() {
  let d = null;
  try {
    d = await fetchJSON('/api/stats');
  } catch (err) {
    // Netlify fallback: calculate from in-memory apps
    const apps = STATIC_APPS || STATE.rows || [];
    if (apps.length) {
      const b0 = apps.filter((a) => (a.rev || 0) < 100000).length;
      const b1 = apps.filter((a) => (a.rev || 0) >= 100000 && (a.rev || 0) < 500000).length;
      const b2 = apps.filter((a) => (a.rev || 0) >= 500000 && (a.rev || 0) < 1000000).length;
      const b3 = apps.filter((a) => (a.rev || 0) >= 1000000 && (a.rev || 0) < 3000000).length;
      const b4 = apps.filter((a) => (a.rev || 0) >= 3000000).length;

      const catMap = {};
      apps.forEach((a) => {
        const c = a.cat || 'Other';
        if (!catMap[c]) catMap[c] = { rev: 0, count: 0 };
        catMap[c].rev += (a.rev || 0);
        catMap[c].count++;
      });
      const sortedCats = Object.entries(catMap)
        .map(([c, v]) => [c, v.rev, v.count])
        .sort((a, b) => b[1] - a[1]);

      const curve = apps.filter((a) => a.tier === 1).slice(0, 200).map((a) => [a.rank || 1, a.rev || 0, a.title || '']);

      d = {
        total: apps.length,
        buckets: { b0, b1, b2, b3, b4 },
        cats: sortedCats,
        curve: curve
      };
    }
  }

  if (!d || !d.total) return;

    // 1. Revenue Distribution
    const b = d.buckets || {};
    const buckets = [
      { label: '>$3M', count: b.b4 || 0, color: '#10b981' },
      { label: '$1–3M', count: b.b3 || 0, color: '#059669' },
      { label: '$500K–1M', count: b.b2 || 0, color: '#3b82f6' },
      { label: '$100–500K', count: b.b1 || 0, color: '#8b5cf6' },
      { label: '<$100K', count: b.b0 || 0, color: '#cbd5e1' }
    ];

    const maxB = Math.max(...buckets.map((x) => x.count), 1);
    $('revDistBox').innerHTML = buckets.map((x) => {
      const pct = Math.round((x.count / d.total) * 100);
      const barW = Math.max(4, Math.round((x.count / maxB) * 100));
      return `
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
            <span style="font-weight:600;color:var(--txt-sec)">${x.label}</span>
            <span style="font-variant-numeric:tabular-nums;color:var(--txt-muted)"><b>${x.count.toLocaleString()}</b> apps (${pct}%)</span>
          </div>
          <div style="height:8px;background:#f1f5f9;border-radius:6px;overflow:hidden">
            <div style="width:${barW}%;height:100%;background:${x.color};border-radius:6px;transition:width 0.5s ease"></div>
          </div>
        </div>
      `;
    }).join('');

    // 2. Top Categories Breakdown
    const cats = d.cats || [];
    const maxRev = cats.length ? cats[0][1] : 1;
    $('catDistBox').innerHTML = cats.slice(0, 8).map(([cat, rev, n]) => {
      const barW = Math.max(5, Math.round((rev / maxRev) * 100));
      return `
        <div style="margin-bottom:11px">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
            <span style="font-weight:600;color:var(--txt-main)">${esc(cat)} <small style="color:var(--txt-muted)">(${n} apps)</small></span>
            <span style="font-weight:700;color:var(--green-dark);font-variant-numeric:tabular-nums">${fmt$(rev)}</span>
          </div>
          <div style="height:7px;background:#f1f5f9;border-radius:6px;overflow:hidden">
            <div style="width:${barW}%;height:100%;background:linear-gradient(90deg, #10b981, #059669);border-radius:6px"></div>
          </div>
        </div>
      `;
    }).join('');

    // 3. Smooth Rank vs. Revenue Log Curve
    drawSmoothCurve('curveCanvas', d.curve || []);
  } catch (err) {
    console.error('Analytics chart render failed', err);
  }
}

function drawSmoothCurve(canvasId, points) {
  const canvas = $(canvasId);
  if (!canvas || !points.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  const h = 240;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const padL = 60, padR = 20, padT = 20, padB = 30;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const revs = points.map((p) => Math.max(100, p[1]));
  const lmin = Math.log10(Math.min(...revs));
  const lmax = Math.log10(Math.max(...revs));

  const X = (i) => padL + (i / Math.max(1, points.length - 1)) * innerW;
  const Y = (v) => padT + innerH - ((Math.log10(Math.max(100, v)) - lmin) / Math.max(0.001, lmax - lmin)) * innerH;

  // Grid lines & labels
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px -apple-system, system-ui';

  for (let g = 0; g <= 4; g++) {
    const lv = lmin + ((lmax - lmin) * g) / 4;
    const y = padT + innerH - ((lv - lmin) / Math.max(0.001, lmax - lmin)) * innerH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(fmt$(Math.pow(10, lv)), 10, y + 4);
  }

  // Draw Spline Curve
  const coords = points.map((p, i) => ({ x: X(i), y: Y(p[1]) }));
  ctx.beginPath();
  ctx.moveTo(coords[0].x, coords[0].y);
  for (let i = 0; i < coords.length - 1; i++) {
    const cp1x = coords[i].x + (coords[i + 1].x - coords[i].x) / 2;
    const cp1y = coords[i].y;
    const cp2x = coords[i].x + (coords[i + 1].x - coords[i].x) / 2;
    const cp2y = coords[i + 1].y;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, coords[i + 1].x, coords[i + 1].y);
  }

  // Stroke
  ctx.strokeStyle = '#059669';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Gradient fill under curve
  ctx.lineTo(coords[coords.length - 1].x, padT + innerH);
  ctx.lineTo(coords[0].x, padT + innerH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, padT + innerH);
  grad.addColorStop(0, 'rgba(16, 185, 129, 0.25)');
  grad.addColorStop(1, 'rgba(16, 185, 129, 0.01)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Top 5 rank badges
  coords.slice(0, 5).forEach((c, idx) => {
    ctx.beginPath();
    ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#059669';
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 10.5px system-ui';
    ctx.fillText(`#${points[idx][0]} ${points[idx][2].slice(0, 14)}`, Math.min(c.x + 6, w - 120), c.y - 6);
  });

  $('curveNote').textContent = `Showing ${points.length} top grossing apps calibrated against Power-Law revenue rank curve.`;
}

/* ==================== DETAIL MODAL ==================== */
async function openDetail(id) {
  id = String(id);
  let app = STATE.rows.find((a) => String(a.id) === id);
  if (!app) {
    try {
      const j = await fetchJSON('/api/app?id=' + encodeURIComponent(id));
      if (j && j.app) app = j.app;
    } catch (e) { /* ignore */ }
  }
  if (!app) return;
  CURRENT_APP = app;

  $('detailModal').classList.add('open');
  $('dIcon').src = app.icon || '';
  $('dTitle').textContent = app.title;
  $('dSub').textContent = `${app.dev || 'Developer'} · ${app.cat || 'Apps'} · v${app.ver || '1.0'}`;
  $('dMeta').innerHTML = `
    <span class="category-badge-pill">Rank #${app.rank || '—'}</span>
    <span class="category-badge-pill">${app.price === 0 ? 'Free' : '$' + app.price}</span>
    ${app.url ? `<a href="${app.url}" target="_blank" rel="noreferrer" style="font-size:12px;color:var(--blue);text-decoration:none;font-weight:600">View in App Store ↗</a>` : ''}
  `;

  $('dRev').textContent = fmt$(app.rev);
  const hasGrowth = app.growth != null && !isNaN(app.growth);
  const isUp = (app.growth ?? 0) >= 0;
  $('dGrowth').textContent = hasGrowth
    ? `${isUp ? '+' : ''}${(app.growth * 100).toFixed(1)}% vs first snapshot`
    : 'needs 2+ daily snapshots';
  $('dGrowth').style.color = hasGrowth ? (isUp ? 'var(--green-dark)' : 'var(--rose-dark)') : 'var(--txt-muted)';

  $('dDl').textContent = fmtN(app.dl);
  $('dRate').textContent = `★ ${(app.rating || 0).toFixed(1)}`;
  $('dRateSub').textContent = `${(app.rc || 0).toLocaleString()} total ratings`;

  $('btnTrackDetail').textContent = WATCH.has(id) ? '★ Tracked' : '＋ Track';
  $('btnTrackDetail').onclick = () => {
    toggleWatch(id).then(() => {
      $('btnTrackDetail').textContent = WATCH.has(id) ? '★ Tracked' : '＋ Track';
    });
  };

  $('dDesc').textContent = app.descc || app.desc || 'No description available.';

  // Screenshots
  let shots = [];
  try {
    shots = typeof app.shots === 'string' ? JSON.parse(app.shots) : (app.shots || []);
  } catch (e) { shots = []; }

  $('dShots').innerHTML = shots.length
    ? shots.map((s) => `<img src="${esc(s)}" alt="Screenshot" />`).join('')
    : '<div style="color:var(--txt-muted);padding:14px">No screenshots provided.</div>';

  // Trigger ads tracking
  trackAppAds(app.title);
}

function closeDetail() {
  $('detailModal').classList.remove('open');
  CURRENT_APP = null;
}

async function trackAppAds(appName) {
  $('dAds').innerHTML = '<div style="color:var(--txt-muted)">Querying YouTube &amp; Ad Creative libraries…</div>';
  const q = encodeURIComponent(appName);
  const officialLinks = `
    <div style="margin-top:14px;padding:12px;background:#f8fafc;border-radius:10px;border:1px solid var(--border)">
      <div style="font-weight:700;font-size:13px;margin-bottom:6px">Official Creative Transparency Libraries:</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <a href="https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${q}" target="_blank" rel="noreferrer" style="color:var(--blue);font-weight:600;font-size:12.5px">Meta Ad Library ↗</a>
        <a href="https://adstransparency.google.com/?q=${q}" target="_blank" rel="noreferrer" style="color:var(--blue);font-weight:600;font-size:12.5px">Google Ads Transparency ↗</a>
        <a href="https://ads.tiktok.com/business/creativecenter/search/topads?query=${q}" target="_blank" rel="noreferrer" style="color:var(--blue);font-weight:600;font-size:12.5px">TikTok Creative Center ↗</a>
      </div>
    </div>
  `;

  try {
    const res = await fetchJSON(`/api/yt?q=${encodeURIComponent(appName)}`);
    const videos = res.videos || [];
    $('dYt').textContent = fmtN(res.totalViews || 0);
    $('dYtSub').textContent = `${videos.length} videos tracked`;

    const vidsHTML = videos.slice(0, 6).map((v) => `
      <div style="display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-light)">
        <img src="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg" style="width:100px;border-radius:8px" alt="" />
        <div>
          <a href="https://www.youtube.com/watch?v=${v.id}" target="_blank" rel="noreferrer" style="font-weight:700;font-size:13px;color:var(--txt-main);text-decoration:none">${esc(v.title)}</a>
          <div style="font-size:12px;color:var(--txt-muted);margin-top:3px">${esc(v.channel)} · ${esc(v.views)} · ${esc(v.published)}</div>
        </div>
      </div>
    `).join('');

    $('dAds').innerHTML = (vidsHTML || '<div style="color:var(--txt-muted)">No public viral videos found.</div>') + officialLinks;
  } catch (err) {
    $('dAds').innerHTML = `<div style="color:var(--txt-muted)">Video tracking currently offline.</div>` + officialLinks;
  }
}

/* ==================== SIBLING PAGE CONTROLLERS ==================== */
function showPage(pageId) {
  document.querySelectorAll('.page-view').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.p === pageId));

  const pageEl = $('p-' + pageId);
  if (pageEl) pageEl.classList.add('active');

  const titles = {
    discover: 'Explore Apps',
    ads: 'Creative Ad Tracker',
    charts: 'Market Breakdown',
    search: 'Whole-Store Search',
    watch: 'Favorites & Watchlist',
    aso: 'ASO Keyword Explorer',
    about: 'Architecture & Pipeline'
  };
  $('pageTitleHeading').textContent = titles[pageId] || 'Explore Apps';

  if (pageId === 'watch') loadWatchlist();
  if (pageId === 'charts') renderMarketCharts();
  window.scrollTo(0, 0);
}

// Apple Search API Helper (supports local backend & Netlify public proxy fallback)
async function searchAppleStore(term) {
  try {
    const res = await fetch(`/api/search?term=${encodeURIComponent(term)}`);
    if (res.ok) return await res.json();
  } catch (e) {}
  // Netlify fallback
  const appleUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=us&entity=software&limit=100`;
  const proxied = `https://api.allorigins.win/raw?url=${encodeURIComponent(appleUrl)}`;
  const r = await fetch(proxied);
  return await r.json();
}

// Whole-Store Live Search
async function performStoreSearch() {
  const term = $('sq').value.trim();
  if (!term) return;
  $('searchOut').innerHTML = '<div style="color:var(--txt-muted)">Searching Apple App Store…</div>';
  try {
    const data = await searchAppleStore(term);
    SEARCH_HITS = data.results || [];
    $('searchOut').innerHTML = `
      <div style="font-size:12px;color:var(--txt-muted);margin-bottom:12px">Found ${data.resultCount || 0} hits for "${esc(term)}"</div>
      ${SEARCH_HITS.slice(0, 50).map((r) => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-light)">
          <img src="${esc(r.artworkUrl100)}" style="width:40px;height:40px;border-radius:9px" alt="" />
          <div style="flex:1">
            <div style="font-weight:700;font-size:13.5px">${esc(r.trackName)}</div>
            <div style="font-size:12px;color:var(--txt-muted)">${esc(r.artistName)} · ${esc(r.primaryGenreName)} · ★${(r.averageUserRating || 0).toFixed(1)} (${fmtN(r.userRatingCount || 0)}) · ${r.price === 0 ? 'Free' : '$' + r.price}</div>
          </div>
          <button class="btn-clear-filters" data-imp-single="${r.trackId}" style="padding:6px 12px;font-size:12px">+ Library</button>
        </div>
      `).join('')}
    `;

    document.querySelectorAll('[data-imp-single]').forEach((btn) => {
      btn.onclick = () => importItems([SEARCH_HITS.find((x) => String(x.trackId) === btn.dataset.impSingle)]);
    });
  } catch (err) {
    $('searchOut').textContent = 'Search failed: ' + err.message;
  }
}

async function importItems(items) {
  items = (items || []).filter(Boolean);
  if (!items.length) return;
  try {
    const res = await fetchJSON('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });
    alert(`Successfully imported ${res.imported} new app(s) to your local library!`);
    loadLibPage();
  } catch (e) {
    alert('Import failed: ' + e.message);
  }
}

// ASO Keyword Tool
async function analyzeKeyword() {
  const kw = $('kw').value.trim();
  if (!kw || kw.length < 2) {
    $('kwOut').textContent = 'Please enter at least 2 characters.';
    return;
  }
  $('kwOut').innerHTML = '<div style="color:var(--txt-muted)">Analyzing keyword difficulty &amp; top-ranking rivals…</div>';
  try {
    const data = await searchAppleStore(kw);
    const results = data.results || [];
    const top10 = results.slice(0, 10);
    if (!top10.length) {
      $('kwOut').textContent = 'No apps found for this keyword.';
      return;
    }

    const avgRatings = top10.reduce((s, r) => s + (r.userRatingCount || 0), 0) / top10.length;
    const sorted = [...results.map((r) => r.userRatingCount || 0)].sort((a, b) => a - b);
    const med = sorted.length % 2 ? sorted[sorted.length >> 1]
      : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;
    // Difficulty = how dominant the top-10 are vs the keyword's own field median.
    // Niche terms (top-10 near the median) score low; giant-dominated terms score high.
    const ratio = med > 0 ? avgRatings / med : 20;
    const diff = Math.max(1, Math.min(99, Math.round(18 * Math.log10(ratio + 1) + Math.min(25, Math.log10(results.length + 1) * 12))));
    const opp = 100 - diff;
    const diffColor = diff > 65 ? 'var(--rose-dark)' : (diff > 40 ? 'var(--amber-dark)' : 'var(--green-dark)');

    $('kwOut').innerHTML = `
      <div style="display:flex;align-items:center;gap:20px;margin-bottom:16px">
        <div style="width:68px;height:68px;border-radius:50%;border:4px solid ${diffColor};display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;color:${diffColor}">
          ${diff}
        </div>
        <div>
          <div style="font-weight:800;font-size:16px">${esc(kw)}</div>
          <div style="font-size:13px;color:var(--txt-muted);margin-top:2px">
            Difficulty: <b style="color:${diffColor}">${diff}/100</b> · Opportunity: <b style="color:var(--green-dark)">${opp}/100</b> · ${results.length} competing apps · top-10 avg ${fmtN(avgRatings)} vs field median ${fmtN(med)}
          </div>
        </div>
      </div>
      <div style="font-weight:700;font-size:13px;margin-bottom:8px">Top 10 Ranked Apps for "${esc(kw)}":</div>
      ${top10.map((r, i) => `
        <div style="font-size:12.5px;padding:5px 0;color:var(--txt-sec)">
          <b>${i + 1}. ${esc(r.trackName)}</b> — ★${(r.averageUserRating || 0).toFixed(1)} (${fmtN(r.userRatingCount || 0)} ratings)
        </div>
      `).join('')}
    `;
  } catch (err) {
    $('kwOut').textContent = 'ASO query failed: ' + err.message;
  }
}

/* ==================== INITIALIZATION & EVENT LISTENERS ==================== */
function setupEvents() {
  // Sidebar Toggle
  $('btnToggleSidebar').onclick = () => {
    $('sidebar').classList.toggle('collapsed');
  };
  $('brandHome').onclick = () => showPage('discover');

  // Navigation Items
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.onclick = () => showPage(btn.dataset.p);
  });

  // Search Omnibox
  let searchTimer = null;
  $('q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      STATE.search = $('q').value.trim();
      STATE.page = 1;
      loadLibPage();
    }, 250);
  });

  $('searchScope').addEventListener('change', () => {
    STATE.scope = $('searchScope').value;
    STATE.page = 1;
    loadLibPage();
  });

  // Header Actions
  $('btnRefresh').onclick = async () => {
    $('btnRefresh').disabled = true;
    try {
      await fetchJSON('/api/build/start?force=1');
      alert('Snapshots refresh initiated! Updating live metrics.');
      setTimeout(() => {
        loadLibPage();
        $('btnRefresh').disabled = false;
      }, 1500);
    } catch (e) {
      alert('Refresh failed: ' + e.message);
      $('btnRefresh').disabled = false;
    }
  };

  $('btnClearFilters').onclick = () => {
    STATE.search = '';
    $('q').value = '';
    STATE.cat = '';
    $('pillCatLabel').textContent = 'Category';
    STATE.tier = '';
    STATE.exclude_cats.clear();
    STATE.rel_after = '';
    STATE.price = '';
    STATE.mr = 0;
    $('pillRevLabel').textContent = 'Min revenue';
    STATE.mdl = 0;
    $('pillDlLabel').textContent = 'Min downloads';
    STATE.mrate = 0;
    $('pillRateLabel').textContent = 'Min rating';
    STATE.sort = 'rev';
    $('pillSortLabel').textContent = 'Sort: Revenue';
    STATE.page = 1;
    loadLibPage();
  };

  $('btnExport').onclick = () => {
    if (!STATE.rows.length) return alert('No data to export.');
    const csv = 'rank,title,developer,category,est_monthly_rev,est_monthly_downloads,rating,rating_count,growth_30d,store_url\n'
      + STATE.rows.map((a) => [
          a.rank || '',
          `"${String(a.title || '').replace(/"/g, '""')}"`,
          `"${String(a.dev || '').replace(/"/g, '""')}"`,
          a.cat || '',
          a.rev || 0,
          a.dl || 0,
          a.rating || 0,
          a.rc || 0,
          a.growth || 0,
          a.url || ''
        ].join(',')).join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `appkittie-apps-page-${STATE.page}.csv`;
    a.click();
  };

  // Pagination
  $('pgPrev').onclick = () => {
    if (STATE.page > 1) {
      STATE.page--;
      loadLibPage();
    }
  };
  $('pgNext').onclick = () => {
    STATE.page++;
    loadLibPage();
  };

  // Detail Modal Controls
  $('modalClose').onclick = closeDetail;
  $('detailModal').onclick = (e) => {
    if (e.target === $('detailModal')) closeDetail();
  };

  document.querySelectorAll('.detail-tab-btn').forEach((tabBtn) => {
    tabBtn.onclick = () => {
      document.querySelectorAll('.detail-tab-btn').forEach((b) => b.classList.remove('active'));
      tabBtn.classList.add('active');
      const target = tabBtn.dataset.tab;
      ['ov', 'shots', 'revs', 'ads'].forEach((t) => {
        const p = $('tab-' + t);
        if (p) p.style.display = t === target ? 'block' : 'none';
      });
    };
  });

  $('btnLoadReviews').onclick = async () => {
    if (!CURRENT_APP) return;
    $('dRevs').textContent = 'Loading reviews from Apple…';
    try {
      const data = await fetchJSON(`/api/reviews?id=${CURRENT_APP.id}`);
      const revs = data.reviews || [];
      if (!revs.length) {
        $('dRevs').innerHTML = '<div style="color:var(--txt-muted);padding:12px">No recent written reviews found for this app.</div>';
        return;
      }
      $('dRevs').innerHTML = revs.slice(0, 20).map((r) => `
        <div style="padding:10px 0;border-bottom:1px solid var(--border-light)">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
            <span style="font-weight:700;color:var(--txt-main)">${'★'.repeat(r.rating || 5)} ${esc(r.title)}</span>
            <span style="color:var(--txt-muted)">${esc(r.author || 'User')} · ${esc(r.date || '')}</span>
          </div>
          <div style="font-size:12.5px;color:var(--txt-sec);line-height:1.5">${esc(r.body)}</div>
        </div>
      `).join('');
    } catch (e) {
      $('dRevs').textContent = 'Failed to load reviews: ' + e.message;
    }
  };

  // Store search & ASO triggers
  $('btnSearch').onclick = performStoreSearch;
  $('sq').addEventListener('keydown', (e) => { if (e.key === 'Enter') performStoreSearch(); });
  $('btnImport').onclick = () => importItems(SEARCH_HITS);

  $('btnAds').onclick = () => trackAppAds($('aq').value.trim() || 'Cal AI');
  $('aq').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAds').click(); });

  // Sortable Table Headers
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.onclick = () => {
      const sortField = th.dataset.sort;
      STATE.sort = sortField;
      document.querySelectorAll('th.sortable').forEach((h) => {
        h.classList.remove('active-sort');
        const icon = h.querySelector('.sort-icon');
        if (icon) icon.textContent = '↕';
      });
      th.classList.add('active-sort');
      const icon = th.querySelector('.sort-icon');
      if (icon) icon.textContent = '↓';

      const sortMap = { rev: 'Revenue', dl: 'Downloads', growth: 'Growth', ratings: 'Ratings', rank: 'Rank', new: 'Newest' };
      $('pillSortLabel').textContent = 'Sort: ' + (sortMap[sortField] || sortField);
      STATE.page = 1;
      loadLibPage();
    };
  });

  // Global Keyboard Shortcut: Cmd/Ctrl+K or / to search
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('q').focus();
      $('q').select();
    } else if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      $('q').focus();
      $('q').select();
    }
  });

  // Popover Setup
  setupPopovers();
}

async function boot() {
  setupEvents();
  try {
    const s = await fetchJSON('/api/status');
    if (s && s.apps) {
      $('sideLibStatus').textContent = `${(s.apps || 0).toLocaleString()} apps loaded`;
      $('sideBuildInfo').textContent = `${(s.watch || 0)} tracked favorites`;
    }
  } catch (e) { /* ignore */ }

  await loadWatchlist();
  await loadLibPage();
}

boot();
