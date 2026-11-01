/**
 * App bootstrap.
 *
 * One fetch on load, one automatic re-check per ten minutes (matching the Pages
 * asset cache), and a clock tick so relative times stay honest without
 * re-fetching anything.
 */
import { AUTO_REFRESH_MS, CACHE_STALE_HOURS, CLOCK_TICK_MS, FEED_PAGE_SIZE, TOPICS } from '../config.js';
import { loadCache } from './cache.js';
import { render, renderFeed } from './render.js';

const LAST_VISIT_KEY = 'motobuzz:last-visit';

function readLastVisit() {
  try {
    const raw = window.localStorage.getItem(LAST_VISIT_KEY);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 && value < Date.now() ? value : null;
  } catch {
    return null;
  }
}

function writeLastVisit(timestamp) {
  try {
    window.localStorage.setItem(LAST_VISIT_KEY, String(timestamp));
  } catch {
    // Private mode or a blocked store: visit history is optional.
  }
}

const state = {
  cache: null,
  error: null,
  status: 'loading',
  loadedAt: null,
  lastVisit: readLastVisit(),
  filter: { kind: 'all', topic: 'all', query: '' },
  visibleCount: FEED_PAGE_SIZE,
};

let refreshTimer = null;
let tickTimer = null;
let inFlight = null;

function paint() {
  render(state);
  renderFeed(state);
}

async function refresh({ silent = false } = {}) {
  if (inFlight) return inFlight;

  state.status = 'loading';
  if (!silent || !state.cache) paint();

  const previousCache = state.cache;
  inFlight = loadCache()
    .then(({ cache, notes }) => {
      state.cache = cache;
      state.error = notes.length ? notes.join(' ') : null;
      state.status = 'ready';
      state.loadedAt = Date.now();
    })
    .catch((error) => {
      // A failed refresh never replaces a good reading with nothing.
      state.cache = previousCache;
      state.error = error instanceof Error ? error.message : 'Snapshot could not be read.';
      state.status = 'error';
    })
    .finally(() => {
      inFlight = null;
      paint();
    });

  return inFlight;
}

function wireFilters() {
  const select = document.getElementById('topic-filter');
  if (select) {
    select.innerHTML = [
      '<option value="all">All topics</option>',
      ...TOPICS.map((topic) => `<option value="${topic.id}">${topic.label}</option>`),
    ].join('');
    select.value = state.filter.topic;
    select.addEventListener('change', () => {
      state.filter.topic = select.value;
      state.visibleCount = FEED_PAGE_SIZE;
      renderFeed(state);
    });
  }

  for (const button of document.querySelectorAll('[data-kind]')) {
    button.addEventListener('click', () => {
      state.filter.kind = button.dataset.kind || 'all';
      state.visibleCount = FEED_PAGE_SIZE;
      paint();
    });
  }

  const search = document.getElementById('feed-search');
  if (search) {
    let debounce = null;
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.filter.query = search.value.trim().toLowerCase();
        state.visibleCount = FEED_PAGE_SIZE;
        renderFeed(state);
      }, 120);
    });
  }

  const more = document.getElementById('load-more');
  if (more) {
    more.addEventListener('click', () => {
      state.visibleCount += FEED_PAGE_SIZE;
      renderFeed(state);
    });
  }

  const refreshButton = document.getElementById('refresh');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      refresh();
    });
  }
}

function schedule() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh({ silent: true });
  }, AUTO_REFRESH_MS);

  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (!state.cache) return;
    const ageHours = (Date.now() - state.cache.generatedAt) / 3_600_000;
    if (ageHours > CACHE_STALE_HOURS) refresh({ silent: true });
    else paint();
  }, CLOCK_TICK_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.cache) return;
    if (Date.now() - state.cache.generatedAt > AUTO_REFRESH_MS) refresh({ silent: true });
  });
}

wireFilters();
paint();
refresh();
schedule();

// The visit marker moves forward only after the page has shown a snapshot.
window.addEventListener('pagehide', () => {
  if (state.cache) writeLastVisit(Date.now());
});
