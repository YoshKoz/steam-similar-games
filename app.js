const TOP_N_TAGS = 10;
const MAX_RESULTS = 40;
const MIN_MATCHED_TAGS = 2;

// Near-universal tags that don't signal genre similarity — off by default,
// but still toggleable so the user can opt in.
const GENERIC_TAGS = new Set([
  'Indie', 'Singleplayer', 'Multiplayer', 'Casual', 'Free to Play',
  'Early Access', 'Great Soundtrack', 'Online Co-Op', 'Local Co-Op',
  'Co-op', 'PvP', 'Family Friendly', 'Funny', 'Controller'
]);

const $status = document.getElementById('status');
const $source = document.getElementById('source');
const $tagbar = document.getElementById('tagbar');
const $filters = document.getElementById('filters');
const $results = document.getElementById('results');
const $appid = document.getElementById('appid');
const $go = document.getElementById('go');
const $fWin = document.getElementById('f-win');
const $fMac = document.getElementById('f-mac');
const $fLinux = document.getElementById('f-linux');
const $fFree = document.getElementById('f-free');
const $fMaxPrice = document.getElementById('f-maxprice');
const $addTag = document.getElementById('add-tag');
const $tagInput = document.getElementById('tag-input');
const $tagAddBtn = document.getElementById('tag-add-btn');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let allTagLists = {}; // tagName -> Map(appid -> {name, positive, negative, price, platforms})
let tagVotes = {};     // tagName -> weight by position in the source game's tag list
let tagRarity = {};    // tagName -> rarity weight (rarer tag = higher weight)
let sourceAppId = null;
let tagIdMapPromise = null; // tag name (lowercase) -> numeric Steam tagid
let runGeneration = 0; // bumped per search so an in-flight fetch loop from a previous search can't clobber the new one's state

[$fWin, $fMac, $fLinux, $fFree, $fMaxPrice].forEach(el => {
  el.addEventListener('input', () => computeAndRender());
});

$tagAddBtn.addEventListener('click', addTagFromInput);
$tagInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addTagFromInput();
});

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const pre = params.get('appid');
  if (pre) {
    $appid.value = pre;
    resolveAndRun(pre);
  }
});

$go.addEventListener('click', () => {
  const id = $appid.value.trim();
  if (id) resolveAndRun(id);
});
$appid.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $go.click();
});

// Steam endpoints send no CORS headers, so the browser can't fetch them
// directly. Primary route is our own server.py proxy (same origin, no rate
// limits, requests come from the user's real IP so currency is correct).
// Public corsproxy.io remains only as a last resort for when the page is
// served by something other than server.py.
async function fetchRaw(url) {
  const local = await fetch('/proxy?url=' + encodeURIComponent(url)).catch(() => null);
  if (local && local.ok) return local;
  const direct = await fetch(url).catch(() => null);
  if (direct && direct.ok) return direct;
  const proxied = await fetch('https://corsproxy.io/?url=' + encodeURIComponent(url));
  if (!proxied.ok) throw new Error('Request failed: ' + url);
  return proxied;
}

async function fetchJSON(url) {
  return (await fetchRaw(url)).json();
}

async function fetchText(url) {
  return (await fetchRaw(url)).text();
}

// Steam's own store page server-renders its "popular user-defined tags"
// chips into static HTML, in relevance order.
async function getTagsFromStorePage(appid) {
  const html = await fetchText(`https://store.steampowered.com/app/${appid}/?l=english`);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tags = [];
  doc.querySelectorAll('.glance_tags.popular_tags a.app_tag').forEach(a => {
    const name = a.textContent.trim();
    if (name) tags.push(name);
  });
  return tags;
}

// Steam tag names need a numeric tagid for the store search API. This
// endpoint is the store's own tag picker data, fetched and cached once.
// Maps lowercase name -> {id, name} (name keeps Steam's proper casing).
async function getTagIdMap() {
  if (!tagIdMapPromise) {
    tagIdMapPromise = fetchJSON('https://store.steampowered.com/tagdata/populartags/english')
      .then(list => {
        const map = new Map();
        for (const t of list || []) map.set(t.name.toLowerCase(), { id: t.tagid, name: t.name });
        return map;
      })
      .catch(() => new Map());
  }
  return tagIdMapPromise;
}

// Games that carry a given tag, sourced straight from Steam's own store
// search (same data SteamDB itself is built on) — includes review score
// for free, so no separate rating lookup is needed.
async function getGamesByTag(tagid) {
  // cc=nl pins the store region: requests go through a CORS proxy whose exit
  // node region otherwise decides the currency, giving a mix of C$/€/$ rows.
  const url = `https://store.steampowered.com/search/results/?query&start=0&count=100&tags=${tagid}&category1=998&supportedlang=english&cc=nl&infinite=1`;
  const data = await fetchJSON(url);
  const html = data && data.results_html;
  if (!html) return { map: new Map(), total: 0 };

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const map = new Map();
  doc.querySelectorAll('a.search_result_row').forEach(row => {
    const id = row.dataset.dsAppid;
    if (!id) return;
    const name = row.querySelector('.search_name .title');
    const tip = row.querySelector('.search_review_summary');
    let positive = 0, negative = 0;
    if (tip) {
      const m = /(\d+)% of the ([\d,]+) user reviews/.exec(tip.getAttribute('data-tooltip-html') || '');
      if (m) {
        const total = parseInt(m[2].replace(/,/g, ''), 10);
        positive = Math.round(total * (parseInt(m[1], 10) / 100));
        negative = total - positive;
      }
    }

    const priceEl = row.querySelector('.search_price_discount_combined');
    const priceCents = priceEl ? parseInt(priceEl.dataset.priceFinal, 10) : NaN;
    const price = Number.isNaN(priceCents) ? null : priceCents / 100;
    // Rendered price string keeps the user's real store currency (€/£/…)
    // instead of a hardcoded $ that misrepresents regional prices.
    const priceTextEl = row.querySelector('.discount_final_price');
    const priceText = priceTextEl ? priceTextEl.textContent.trim() : null;

    const platforms = {
      win: !!row.querySelector('.search_platforms .platform_img.win'),
      mac: !!row.querySelector('.search_platforms .platform_img.mac'),
      linux: !!row.querySelector('.search_platforms .platform_img.linux'),
    };
    // Rows occasionally omit the platform icons block entirely; assume
    // Windows rather than silently excluding the game from every filter.
    if (!platforms.win && !platforms.mac && !platforms.linux) platforms.win = true;

    map.set(id, { name: name ? name.textContent.trim() : `App ${id}`, positive, negative, price, priceText, platforms });
  });

  return { map, total: (data && data.total_count) || map.size };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Looks up a tag by name, fetches its games (with one retry — the
// CORS-proxy fallback flakes under load), filters out net-negative-reviewed
// games, and computes the rarity weight. Used both for the source game's
// initial top tags and for tags the user adds manually.
async function fetchTagData(tagName) {
  const tagIdMap = await getTagIdMap();
  const entry = tagIdMap.get(tagName.toLowerCase());
  if (!entry) return { ok: false, reason: 'unknown-tag' };

  let result = null;
  for (let attempt = 0; attempt < 2 && result === null; attempt++) {
    if (attempt > 0) await sleep(500);
    try {
      result = await getGamesByTag(entry.id);
    } catch (e) {
      result = null;
    }
  }
  if (result === null) return { ok: false, reason: 'fetch-failed' };

  const map = new Map();
  for (const [id, info] of result.map) {
    // Skip games whose review balance is negative (more thumbs-down than up).
    if (info.positive + info.negative > 0 && info.negative > info.positive) continue;
    map.set(id, info);
  }
  // Rarer tags (fewer games carry them) are more diagnostic of genuine
  // similarity than tags shared by thousands of games.
  const rarity = 1 / Math.log2(result.total + 2);
  return { ok: true, map, rarity, properName: entry.name };
}

async function resolveAndRun(input) {
  if (/^\d+$/.test(input)) {
    run(input);
    return;
  }

  $status.textContent = `Searching for "${input}"…`;
  $status.className = '';
  $source.classList.add('hidden');
  $tagbar.classList.add('hidden');
  $addTag.classList.add('hidden');
  $filters.classList.add('hidden');
  $results.innerHTML = '';

  let matches;
  try {
    matches = await fetchJSON(`https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(input)}`);
  } catch (e) {
    $status.textContent = 'Search failed. ' + e.message;
    $status.className = 'error';
    return;
  }

  // Only keep entries that look like actual games (numeric appid).
  matches = (matches || []).filter(m => /^\d+$/.test(String(m.appid)));

  if (matches.length === 0) {
    $status.textContent = `No games found matching "${input}". Try the exact title or a Steam App ID.`;
    $status.className = 'error';
    return;
  }

  if (matches.length === 1) {
    run(matches[0].appid);
    return;
  }

  renderMatchPicker(matches, input);
}

function renderMatchPicker(matches, input) {
  $status.textContent = `Multiple matches for "${input}" — pick one:`;
  $status.className = '';
  $results.innerHTML = matches.slice(0, 15).map(m => `
    <div class="result-row match-pick" data-appid="${m.appid}">
      <div class="name">${escapeHtml(m.name)}</div>
      <div class="overlap">#${m.appid}</div>
    </div>
  `).join('');

  $results.querySelectorAll('.match-pick').forEach(row => {
    row.addEventListener('click', () => run(row.dataset.appid));
  });
}

// Bump the version whenever the snapshot format changes — otherwise old
// cached shapes silently break new rendering code.
const CACHE_VERSION = 3;
function cacheKey(appid) { return `ssgf:v${CACHE_VERSION}:${appid}`; }

// Drop snapshots from older cache versions so they don't rot in storage.
for (const key of Object.keys(localStorage)) {
  if (key.startsWith('ssgf:') && !key.startsWith(`ssgf:v${CACHE_VERSION}:`)) {
    localStorage.removeItem(key);
  }
}

function loadCache(appid) {
  try {
    const raw = localStorage.getItem(cacheKey(appid));
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (Date.now() - snap.ts > CACHE_TTL_MS) return null;
    return snap;
  } catch (e) {
    return null;
  }
}

function saveCache(appid, snap) {
  const payload = JSON.stringify({ ...snap, ts: Date.now() });
  try {
    localStorage.setItem(cacheKey(appid), payload);
  } catch (e) {
    // Quota hit — evict every old snapshot (ours only) and retry once.
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('ssgf:')) localStorage.removeItem(key);
    }
    try {
      localStorage.setItem(cacheKey(appid), payload);
    } catch (e2) {
      // Still failing (private browsing / tiny quota) — skip caching.
    }
  }
}

function applyCachedSnapshot(snap) {
  renderSourceCard(snap.game, sourceAppId);
  tagVotes = snap.tagVotes;
  tagRarity = snap.tagRarity;
  allTagLists = {};
  for (const [tag, entries] of snap.allTagLists) allTagLists[tag] = new Map(entries);
  renderTagBar(snap.tags);
  $filters.classList.remove('hidden');

  const notes = [`Loaded from cache (saved ${Math.round((Date.now() - snap.ts) / 60000)}m ago).`];
  if (snap.usedGenreFallback) notes.push('This game is age-gated on Steam, so results are based on broad genre only (less precise).');
  if (snap.failedTags.length) notes.push(`Couldn't load data for: ${snap.failedTags.join(', ')}.`);
  $status.innerHTML = escapeHtml(notes.join(' ')) + ' <a href="#" id="force-refresh">Refresh</a>';
  document.getElementById('force-refresh').addEventListener('click', (e) => {
    e.preventDefault();
    localStorage.removeItem(cacheKey(sourceAppId));
    run(sourceAppId, true);
  });

  computeAndRender();
}

async function run(appid, forceFresh) {
  if (!/^\d+$/.test(appid)) {
    $status.textContent = 'Enter a numeric Steam App ID, not a game name (find it in the store URL, e.g. store.steampowered.com/app/2287430/).';
    $status.className = 'error';
    return;
  }

  sourceAppId = appid;
  const myGeneration = ++runGeneration;
  history.replaceState(null, '', '?appid=' + encodeURIComponent(appid));
  $source.classList.add('hidden');
  $tagbar.classList.add('hidden');
  $addTag.classList.add('hidden');
  $filters.classList.add('hidden');
  $results.innerHTML = '';
  $status.textContent = 'Loading game details…';
  $status.className = '';

  if (!forceFresh) {
    const cached = loadCache(appid);
    if (cached) {
      applyCachedSnapshot(cached);
      return;
    }
  }

  let game;
  try {
    const resp = await fetchJSON(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`);
    const entry = resp && resp[appid];
    if (!entry || !entry.success) throw new Error('no data');
    game = entry.data;
  } catch (e) {
    if (myGeneration !== runGeneration) return; // superseded by a newer search
    $status.textContent = 'Failed to fetch game data. ' + e.message;
    $status.className = 'error';
    return;
  }
  if (myGeneration !== runGeneration) return; // superseded by a newer search

  if (!game || !game.name) {
    $status.textContent = 'No data found for that App ID.';
    $status.className = 'error';
    return;
  }

  renderSourceCard(game, appid);

  // Tags come from Steam's own store page, server-rendered in the site's
  // relevance order (most-diagnostic tags first).
  let tags = [];
  try {
    tags = (await getTagsFromStorePage(appid)).slice(0, TOP_N_TAGS);
  } catch (e) {
    tags = [];
  }
  if (myGeneration !== runGeneration) return; // superseded by a newer search

  let usedGenreFallback = false;
  if (tags.length === 0) {
    // Mature-rated apps (e.g. Baldur's Gate 3) 302 to an age-check wall
    // instead of the real store page, which has no tags on it. There's no
    // client-side way to bypass that (needs a Cookie header, which browser
    // fetch refuses to let JS set). Fall back to the coarser genre list from
    // the official appdetails API, which isn't age-gated.
    tags = [...new Set((game.genres || []).map(g => g.description))].slice(0, TOP_N_TAGS);
    usedGenreFallback = true;
    if (tags.length === 0) {
      $status.textContent = 'This game has no tag or genre data available.';
      $status.className = 'error';
      return;
    }
  }

  // Store page lists tags in descending relevance order — weight accordingly.
  tagVotes = {};
  tags.forEach((t, i) => { tagVotes[t] = tags.length - i; });

  renderTagBar(tags);
  $filters.classList.remove('hidden');
  $status.textContent = `Fetching games for ${tags.length} tags…`;

  allTagLists = {};
  tagRarity = {};
  let loaded = 0;
  const failedTags = [];

  // Firing all tag requests at once floods the CORS-proxy fallback and
  // makes most of them fail. Cap concurrency and space out retries.
  const TAG_CONCURRENCY = 3;
  const queue = tags.slice();

  async function worker() {
    while (queue.length) {
      const tag = queue.shift();
      const outcome = await fetchTagData(tag);
      if (myGeneration !== runGeneration) return; // superseded — don't touch state
      if (outcome.ok) {
        allTagLists[tag] = outcome.map;
        tagRarity[tag] = outcome.rarity;
      } else {
        allTagLists[tag] = new Map();
        tagRarity[tag] = 0;
        failedTags.push(tag);
      }
      loaded++;
      $status.textContent = `Fetching games for tags… (${loaded}/${tags.length})`;
    }
  }

  await Promise.all(Array.from({ length: Math.min(TAG_CONCURRENCY, tags.length) }, worker));
  if (myGeneration !== runGeneration) return; // superseded by a newer search

  // With too few tags actually loaded, results are driven by review score
  // of whatever tag(s) happened to work rather than genuine similarity —
  // refuse to show misleading recommendations.
  const loadedOk = tags.length - failedTags.length;
  if (loadedOk < Math.min(2, tags.length)) {
    $status.textContent = `Couldn't load data for: ${failedTags.join(', ')} — too few tags loaded to give reliable results. Try again.`;
    $status.className = 'error';
    $tagbar.classList.add('hidden');
    $addTag.classList.add('hidden');
    $filters.classList.add('hidden');
    return;
  }

  const notes = [];
  if (usedGenreFallback) notes.push('This game is age-gated on Steam, so results are based on broad genre only (less precise).');
  if (failedTags.length) notes.push(`Couldn't load data for: ${failedTags.join(', ')} — results based on remaining tags only.`);
  $status.textContent = notes.join(' ');

  // Store only the fields the UI needs — the raw appdetails payload carries
  // full HTML descriptions/screenshots (hundreds of KB per game) and would
  // exhaust the localStorage quota after a handful of lookups.
  const slimGame = {
    name: game.name,
    header_image: game.header_image,
    developers: (game.developers || []).slice(0, 1),
    release_date: game.release_date ? { date: game.release_date.date } : undefined,
    genres: game.genres,
  };
  saveCache(appid, {
    game: slimGame, tags, tagVotes, tagRarity, usedGenreFallback, failedTags,
    allTagLists: Object.entries(allTagLists).map(([tag, map]) => [tag, Array.from(map)]),
  });

  computeAndRender();
}

function renderSourceCard(game, appid) {
  $source.classList.remove('hidden');
  const header = game.header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`;
  const developer = (game.developers || [])[0] || '';
  const released = (game.release_date && game.release_date.date) || '';
  $source.innerHTML = `
    <img src="${header}" onerror="this.style.display='none'" />
    <div class="info">
      <h2>${escapeHtml(game.name)}</h2>
      <div class="meta">${escapeHtml(developer)}${developer && released ? ' · ' : ''}${escapeHtml(released)}</div>
    </div>
  `;
}

function renderTagBar(tags) {
  $tagbar.classList.remove('hidden');
  $addTag.classList.remove('hidden');
  $tagbar.innerHTML = tags.map(t => {
    const active = GENERIC_TAGS.has(t) ? '' : 'active';
    return `<span class="tag-pill ${active}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}<span class="tag-remove" data-tag="${escapeHtml(t)}">×</span></span>`;
  }).join('');

  $tagbar.querySelectorAll('.tag-pill').forEach(wireOnePill);
}

function wireOnePill(pill) {
  pill.addEventListener('click', (e) => {
    if (e.target.classList.contains('tag-remove')) return; // handled below
    pill.classList.toggle('active');
    computeAndRender();
  });
  pill.querySelector('.tag-remove').addEventListener('click', (e) => {
    e.stopPropagation();
    removeTag(pill.dataset.tag);
  });
}

function removeTag(tagName) {
  const pill = Array.from($tagbar.querySelectorAll('.tag-pill'))
    .find(p => p.dataset.tag === tagName);
  if (pill) pill.remove();
  delete allTagLists[tagName];
  delete tagVotes[tagName];
  delete tagRarity[tagName];

  if (!$tagbar.querySelector('.tag-pill')) {
    $results.innerHTML = '<div class="error">All tags removed — add one to see results.</div>';
    return;
  }
  computeAndRender();
}

async function addTagFromInput() {
  const raw = $tagInput.value.trim();
  if (!raw) return;

  const existing = Array.from($tagbar.querySelectorAll('.tag-pill'))
    .find(p => p.dataset.tag.toLowerCase() === raw.toLowerCase());
  if (existing) {
    existing.classList.add('active');
    $tagInput.value = '';
    computeAndRender();
    return;
  }

  $tagAddBtn.disabled = true;
  $tagAddBtn.textContent = 'Adding…';

  const outcome = await fetchTagData(raw);

  $tagAddBtn.disabled = false;
  $tagAddBtn.textContent = 'Add tag';

  if (!outcome.ok) {
    $status.textContent = outcome.reason === 'unknown-tag'
      ? `"${raw}" isn't a real Steam tag.`
      : `Couldn't load data for "${raw}" — try again.`;
    $status.className = 'error';
    return;
  }

  $status.textContent = '';
  $status.className = '';
  const tagName = outcome.properName;
  allTagLists[tagName] = outcome.map;
  tagRarity[tagName] = outcome.rarity;
  // User explicitly asked for this tag — weight it as fully relevant,
  // same as the source game's own top tag.
  tagVotes[tagName] = Math.max(1, ...Object.values(tagVotes));

  $tagbar.insertAdjacentHTML('beforeend',
    `<span class="tag-pill active" data-tag="${escapeHtml(tagName)}">${escapeHtml(tagName)}<span class="tag-remove" data-tag="${escapeHtml(tagName)}">×</span></span>`);
  wireOnePill($tagbar.lastElementChild);

  $tagInput.value = '';
  computeAndRender();
}

function computeAndRender() {
  const activeTags = Array.from($tagbar.querySelectorAll('.tag-pill.active'))
    .map(el => el.dataset.tag);

  if (activeTags.length === 0) {
    $results.innerHTML = '<div class="error">Select at least one tag.</div>';
    return;
  }

  // Weight = how strongly the source game itself carries the tag (vote share)
  // times how rare/diagnostic the tag is across all of Steam.
  const maxVotes = Math.max(...activeTags.map(t => tagVotes[t] || 0), 1);
  const tagWeight = {};
  for (const t of activeTags) {
    const voteShare = (tagVotes[t] || 0) / maxVotes;
    tagWeight[t] = voteShare * (tagRarity[t] || 0);
  }

  const scores = new Map(); // appid -> {name, score, matched, matchedTags, positive, negative, price, platforms}
  for (const tag of activeTags) {
    const map = allTagLists[tag];
    if (!map) continue;
    for (const [id, game] of map) {
      if (id === String(sourceAppId)) continue;
      const entry = scores.get(id) || {
        name: game.name, score: 0, matched: 0, matchedTags: [],
        positive: game.positive, negative: game.negative,
        price: game.price, priceText: game.priceText, platforms: game.platforms,
      };
      entry.score += tagWeight[tag];
      entry.matched++;
      entry.matchedTags.push(tag);
      scores.set(id, entry);
    }
  }

  const platformOk = (p) => (!p) || (
    ($fWin.checked && p.win) || ($fMac.checked && p.mac) || ($fLinux.checked && p.linux)
  );
  const priceOk = (info) => {
    if ($fFree.checked) return info.price === 0;
    const max = parseFloat($fMaxPrice.value);
    if (!Number.isNaN(max) && info.price !== null && info.price > max) return false;
    return true;
  };

  let ranked = Array.from(scores.entries())
    .filter(([, info]) => info.matched >= Math.min(MIN_MATCHED_TAGS, activeTags.length))
    .filter(([, info]) => platformOk(info.platforms) && priceOk(info))
    .sort((a, b) => b[1].score - a[1].score);

  // Collapse sequels/editions of the same game (e.g. "RollerCoaster Tycoon 2"
  // and "RollerCoaster Tycoon 2: Triple Thrill Pack") to whichever scored
  // highest, so one franchise doesn't crowd out other recommendations.
  const seenFranchise = new Map(); // normalized title -> appid kept
  const deduped = [];
  for (const [id, info] of ranked) {
    const key = normalizeTitle(info.name);
    if (seenFranchise.has(key)) continue;
    seenFranchise.set(key, id);
    deduped.push([id, info]);
  }
  ranked = deduped.slice(0, MAX_RESULTS);

  if (ranked.length === 0) {
    $results.innerHTML = '<div class="error">No sufficiently similar games found — try enabling more tags or loosening filters.</div>';
    return;
  }

  // Final display order: more matched tags first, review rating breaks ties.
  ranked.sort((a, b) => b[1].matched - a[1].matched || rating(b[1]) - rating(a[1]));

  $results.innerHTML = ranked.map(([id, info], i) => `
    <div class="result-row">
      <div class="rank">${i + 1}</div>
      <div class="name-block">
        <div class="name"><a href="https://store.steampowered.com/app/${id}/" target="_blank" rel="noopener">${escapeHtml(info.name)}</a></div>
        <div class="matched-tags">matched: ${info.matchedTags.map(escapeHtml).join(', ')}</div>
      </div>
      <div class="price">${escapeHtml(formatPrice(info))}</div>
      <div class="overlap">${info.matched}/${activeTags.length} tags · ${formatRating(info)}</div>
    </div>
  `).join('');
}

// Strips edition/sequel noise so franchise entries group together:
// "Sacred Gold" / "Sacred: Underworld" / "Sacred 3" all normalize the same.
function normalizeTitle(name) {
  const key = name
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/:.*$/, '')
    .replace(/\s*[-–—].*$/, '')
    .replace(/\b(gold|deluxe|ultimate|complete|definitive|goty|game of the year|remastered|remake|hd|anniversary|collection|edition|trilogy|bundle|pack)\b/g, '')
    .replace(/\b(i{1,3}|iv|v|vi{0,3}|ix|x)\b/g, '')
    .replace(/\d+/g, '')
    .replace(/[^a-z]/g, '')
    .trim();
  // Very short/empty keys (single-word or numeral-only titles) risk merging
  // unrelated games — only dedupe when the stripped title is distinctive.
  return key.length >= 3 ? key : name.toLowerCase();
}

function formatPrice(info) {
  if (info.priceText) return info.priceText;
  if (info.price === null || info.price === undefined) return '';
  if (info.price === 0) return 'Free';
  return info.price.toFixed(2);
}

function rating(info) {
  const total = (info.positive || 0) + (info.negative || 0);
  return total > 0 ? info.positive / total : -1; // unrated games sort last
}

function formatRating(info) {
  const total = (info.positive || 0) + (info.negative || 0);
  return total > 0 ? Math.round((info.positive / total) * 100) + '% positive' : 'no reviews';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
