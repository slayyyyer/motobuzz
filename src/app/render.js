/**
 * All rendering. Pure functions from cache state to DOM, no framework.
 * Anything that came from a feed is escaped before it is inserted.
 */
import { BUZZ, DECAY, ENTITY_BY_ID, FEED_PAGE_SIZE, TOPIC_LABELS, TOPICS, WINDOW } from '../config.js';
import { clockTime, compactNumber, percent, pluralize, relativeTime } from './format.js';

const ARC_LENGTH = 251.33;
const TREND_LABEL = { rising: 'rising', cooling: 'cooling', steady: 'holding' };
const STATUS_LABEL = {
  live: 'live',
  empty: 'empty',
  cached: 'cached',
  malformed: 'malformed',
  unavailable: 'unavailable',
  unconfigured: 'not configured',
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}

function trendClass(trend) {
  return trend === 'rising' ? 'trend-up' : trend === 'cooling' ? 'trend-down' : '';
}

function trendGlyph(trend) {
  return trend === 'rising' ? '▲' : trend === 'cooling' ? '▼' : '▬';
}

function gaugeClass(level) {
  if (level === 'quiet' || level === 'idle') return 'neutral';
  if (level === 'warming') return 'cool';
  return 'warm';
}

function timeZone(state) {
  return state?.cache?.site?.timezone || 'America/New_York';
}

/* ---------- masthead ---------- */

function renderStatus(state) {
  const node = byId('cache-status');
  const cache = state.cache;

  if (!cache) {
    node.textContent = state.error
      ? `${state.error} ${state.status === 'loading' ? '' : 'Waiting for the next build.'}`.trim()
      : 'Loading the latest snapshot…';
    return;
  }

  const tz = timeZone(state);
  const built = clockTime(cache.generatedAt, tz);
  const live = cache.sources.filter((source) => source.status === 'live').length;
  const ageHours = (Date.now() - cache.generatedAt) / 3_600_000;
  const stale = ageHours > 2 ? ` · snapshot is ${Math.round(ageHours)}h old` : '';
  const trouble = state.error ? ` · ${state.error}` : '';

  node.textContent = `Built ${built} ${cache.site?.timezoneLabel || tz} · ${live} of ${cache.sources.length} sources live · ${pluralize(
    cache.buzz.activeItems,
    'active record',
  )}${stale}${trouble}`;
}

/* ---------- stage ---------- */

function renderGauge(state) {
  const svg = byId('gauge');
  const fill = byId('gauge-fill');
  const needle = byId('gauge-needle');
  const score = state.cache?.buzz.score ?? 0;
  const label = state.cache?.buzz.label ?? 'No signal';
  const note = state.cache?.buzz.note ?? '';

  svg.classList.remove('neutral', 'warm', 'cool');
  svg.classList.add(gaugeClass(state.cache?.buzz.level));

  fill.style.strokeDashoffset = String(ARC_LENGTH * (1 - Math.max(0, Math.min(100, score)) / 100));
  needle.style.transform = `rotate(${-90 + Math.max(0, Math.min(100, score)) * 1.8}deg)`;

  document.getElementById('gauge-title').textContent = `Buzz meter: ${score} out of 100`;
  document.getElementById('gauge-desc').textContent = state.cache
    ? `${label}. ${note}`
    : 'The meter has no snapshot yet.';

  byId('score').textContent = state.cache ? String(score) : '--';
  byId('band').textContent = state.cache ? label : 'No signal yet';

  const stage = document.querySelector('.stage');
  if (stage) stage.dataset.level = state.cache?.buzz.level || 'quiet';

  byId('headline').textContent =
    state.cache?.buzz.headline ||
    (state.error ? 'No snapshot is available, so there is nothing to read.' : 'Waiting for the first snapshot from the build.');
  byId('headline-basis').textContent = state.cache ? `Basis: ${state.cache.buzz.headlineBasis}` : '';
}

function renderTicks() {
  const group = byId('gauge-ticks');
  if (group.childElementCount > 0) return;
  const parts = [];
  for (let value = 0; value <= 100; value += 10) {
    const angle = Math.PI + (value / 100) * Math.PI;
    const major = value % 25 === 0;
    const inner = major ? 62 : 66;
    const outer = 71;
    parts.push(
      `<line class="gauge-tick${major ? ' major' : ''}" x1="${(100 + inner * Math.cos(angle)).toFixed(1)}" y1="${(
        100 + inner * Math.sin(angle)
      ).toFixed(1)}" x2="${(100 + outer * Math.cos(angle)).toFixed(1)}" y2="${(100 + outer * Math.sin(angle)).toFixed(1)}" />`,
    );
  }
  group.innerHTML = parts.join('');
}

function renderMeta(state) {
  const node = byId('meta-strip');
  const buzz = state.cache?.buzz;
  if (!buzz) {
    node.innerHTML = '';
    return;
  }
  const counts = `${buzz.counts.news} news · ${buzz.counts.social} social`;
  const momentum = buzz.momentum;
  const momentumText = `x${momentum.toFixed(2)} ${TREND_LABEL[buzz.momentumLabel]}`;

  node.innerHTML = [
    `<li class="meta-pill"><b>${buzz.activeItems}</b> records / ${WINDOW.scoreHours}h</li>`,
    `<li class="meta-pill">${buzz.publishersRepresented} publishers</li>`,
    `<li class="meta-pill">${counts}</li>`,
    `<li class="meta-pill ${trendClass(buzz.momentumLabel)}">${trendGlyph(buzz.momentumLabel)} ${momentumText}</li>`,
    buzz.newestItemAt
      ? `<li class="meta-pill">newest ${relativeTime(buzz.newestItemAt)}</li>`
      : '<li class="meta-pill">no dated records</li>',
  ].join('');
}

function renderHistory(state) {
  const node = byId('history-bars');
  const buckets = state.cache?.buzz.buckets || [];
  if (buckets.length === 0) {
    node.innerHTML = '';
    byId('history-note').textContent = '';
    return;
  }

  const max = Math.max(...buckets.map((bucket) => bucket.energy), 0.001);
  node.innerHTML = buckets
    .map((bucket, index) => {
      const height = Math.max(2, Math.round((bucket.energy / max) * 100));
      const latest = index === buckets.length - 1 ? ' latest' : '';
      const empty = bucket.items === 0 ? ' empty' : '';
      const hour = clockTime(bucket.start, timeZone(state));
      return `<span class="history-bar${empty}${latest}" style="height:${height}%" title="${esc(hour)} — ${bucket.items} record${
        bucket.items === 1 ? '' : 's'
      }"></span>`;
    })
    .join('');

  const peak = buckets.reduce((best, bucket) => (bucket.energy > best.energy ? bucket : best), buckets[0]);
  byId('history-note').textContent = peak.items
    ? `peak ${clockTime(peak.start, timeZone(state))} · ${pluralize(peak.items, 'record')}`
    : 'no records in the last day';
}

function renderSinceLast(state) {
  const node = byId('since-last');
  const cache = state.cache;
  if (!cache) {
    node.textContent = '';
    return;
  }
  if (!state.lastVisit) {
    node.textContent = 'First visit here: the meter is showing everything in the current snapshot.';
    return;
  }
  const since = cache.items.filter((item) => item.publishedAt > state.lastVisit).length;
  const ago = relativeTime(state.lastVisit);
  node.textContent = since > 0
    ? `${pluralize(since, 'new record')} since you last looked (${ago}).`
    : `Nothing new since you last looked (${ago}).`;
}

/* ---------- threads ---------- */

function renderThreads(state) {
  const node = byId('threads');
  const threads = state.cache?.threads || [];
  if (threads.length === 0) {
    node.innerHTML = '<li class="panel-sub">No theme has any records in the window.</li>';
    return;
  }
  const maxShare = Math.max(...threads.map((thread) => thread.share), 0.01);

  node.innerHTML = threads
    .map((thread) => {
      const width = Math.max(4, Math.round((thread.share / maxShare) * 100));
      const exemplar = thread.exemplar;
      return `<li class="thread">
        <div class="thread-top">
          <span class="thread-title">${esc(thread.label)}</span>
          <span class="trend ${thread.trend}">${trendGlyph(thread.trend)} ${TREND_LABEL[thread.trend]}</span>
        </div>
        ${thread.entity ? `<p class="thread-entity">Most named: ${esc(thread.entity.name)}</p>` : ''}
        <div class="heat-bar"><span style="width:${width}%"></span></div>
        <div class="thread-foot">
          <span>${pluralize(thread.itemCount, 'record')}</span>
          <span>${pluralize(thread.sources, 'source')}</span>
          <span>${percent(thread.share)} of the buzz</span>
          <span>${thread.momentum.toFixed(2)}x</span>
        </div>
        ${
          exemplar
            ? `<a class="thread-link" href="${esc(exemplar.url)}" target="_blank" rel="noopener noreferrer">${esc(
                exemplar.title,
              )}</a>`
            : ''
        }
      </li>`;
    })
    .join('');
}

/* ---------- heat ---------- */

function sparkBars(series) {
  const max = Math.max(...series, 0.001);
  return series
    .map((value) => {
      const height = value > 0 ? Math.max(8, Math.round((value / max) * 100)) : 4;
      return `<i class="${value > 0 ? '' : 'zero'}" style="height:${height}%"></i>`;
    })
    .join('');
}

function renderHeat(state) {
  const node = byId('heat');
  // Series names appear in almost every headline, so they would flatten this table.
  const entities = (state.cache?.entities || []).filter((entity) => entity.kind !== 'series');
  if (entities.length === 0) {
    node.innerHTML = '<p class="panel-sub">No rider, brand, or team is named in the current window.</p>';
    return;
  }
  const maxHeat = Math.max(...entities.map((entity) => entity.heat), 0.01);

  node.innerHTML = entities
    .map((entity, index) => {
      const width = Math.max(3, Math.round((entity.heat / maxHeat) * 100));
      return `<div class="heat-row">
        <span class="heat-rank">${index + 1}</span>
        <span class="heat-name">
          <strong title="${esc(entity.name)}">${esc(entity.name)}</strong>
          <span class="kind-tag">${esc(entity.kind)}</span>
        </span>
        <span class="heat-spark" aria-hidden="true">${sparkBars(entity.series)}</span>
        <span class="heat-bar"><span style="width:${width}%"></span></span>
        <span class="heat-meta">
          <span>${pluralize(entity.mentions, 'mention')}</span>
          <span>${pluralize(entity.sources, 'source')}</span>
          <span class="${trendClass(entity.trend)}">${trendGlyph(entity.trend)} ${entity.momentum.toFixed(2)}x</span>
        </span>
      </div>`;
    })
    .join('');
}

/* ---------- where ---------- */

function splitRow(label, parts) {
  const total = parts.reduce((sum, part) => sum + part.value, 0) || 1;
  const segments = parts
    .filter((part) => part.value > 0)
    .map((part) => `<span class="${part.cls}" style="width:${(part.value / total) * 100}%"></span>`)
    .join('');
  const legend = parts
    .filter((part) => part.value > 0)
    .map((part) => `${esc(part.label)} ${percent(part.value / total)}`)
    .join(' · ');
  return `<div class="split">
    <div class="split-label"><span>${esc(label)}</span><span>${legend}</span></div>
    <div class="split-track">${segments}</div>
  </div>`;
}

function renderWhere(state) {
  const node = byId('where');
  const cache = state.cache;
  if (!cache) {
    node.innerHTML = '<p class="panel-sub">Waiting for a snapshot.</p>';
    return;
  }
  const region = cache.region || {};
  const counts = cache.buzz.counts;

  node.innerHTML = `<div class="where-block">
    ${splitRow('Series', [
      { label: 'American series', value: region.us || 0, cls: 'split-us' },
      { label: 'World championship', value: region.world || 0, cls: 'split-world' },
      { label: 'Both', value: region.mixed || 0, cls: 'split-mixed' },
      { label: 'Unclear', value: region.unknown || 0, cls: 'split-unknown' },
    ])}
    ${splitRow('Source type', [
      { label: 'News', value: counts.news, cls: 'split-news' },
      { label: 'Social', value: counts.social, cls: 'split-social' },
    ])}
    <div class="where-facts">
      <span class="meta-pill">${cache.buzz.sourcesRepresented} sources answering</span>
      <span class="meta-pill">${pluralize(cache.items.length, 'record')} in the cache</span>
      <span class="meta-pill">${cache.build?.duplicatesDropped ?? 0} duplicates dropped</span>
    </div>
  </div>`;
}

/* ---------- sources ---------- */

function renderSources(state) {
  const node = byId('sources');
  const sources = state.cache?.sources || [];
  if (sources.length === 0) {
    node.innerHTML = '<p class="panel-sub">No source information in this snapshot.</p>';
    return;
  }

  const groups = [
    { id: 'news', label: 'News' },
    { id: 'social', label: 'Social' },
  ];

  node.innerHTML = `<div class="source-groups">
    ${groups
      .map((group) => {
        const entries = sources.filter((source) => source.kind === group.id);
        if (entries.length === 0) return '';
        return `<div class="source-group">
          <h3>${group.label}</h3>
          <div class="source-list">
            ${entries
              .map((source) => {
                const detail = source.error || source.note || '';
                const title = [
                  `${source.label} — ${STATUS_LABEL[source.status] || source.status}`,
                  source.provider,
                  detail,
                  source.lastSuccessAt ? `last success ${relativeTime(source.lastSuccessAt)}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ');
                const inner = `<span>${esc(source.label)}</span><span class="source-count">${
                  source.recordCount > 0 ? source.recordCount : '—'
                }</span>`;
                return source.homepage
                  ? `<a class="source-chip" data-status="${esc(source.status)}" href="${esc(
                      source.homepage,
                    )}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${inner}</a>`
                  : `<span class="source-chip" data-status="${esc(source.status)}" title="${esc(title)}">${inner}</span>`;
              })
              .join('')}
          </div>
        </div>`;
      })
      .join('')}
  </div>`;
}

/* ---------- feed ---------- */

const KIND_LABEL = { news: 'news', social: 'social' };

function entityNames(item, limit = 2) {
  return (item.entities || [])
    .map((id) => ENTITY_BY_ID[id]?.name)
    .filter(Boolean)
    .slice(0, limit);
}

function matchesFilter(item, filter) {
  if (filter.kind !== 'all' && item.kind !== filter.kind) return false;
  if (filter.topic !== 'all' && !(item.topics || []).includes(filter.topic)) return false;
  if (filter.query) {
    const haystack = [item.title, item.publisher, item.summary, ...entityNames(item, 4)].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(filter.query)) return false;
  }
  return true;
}

export function renderFeed(state) {
  const node = byId('feed');
  const empty = byId('feed-empty');
  const more = byId('load-more');
  const count = byId('explore-count');
  const cache = state.cache;

  if (!cache) {
    node.innerHTML = '';
    empty.hidden = true;
    more.hidden = true;
    count.textContent = '';
    return;
  }

  const filtered = cache.items
    .filter((item) => matchesFilter(item, state.filter))
    .sort((a, b) => b.publishedAt - a.publishedAt);

  const visible = filtered.slice(0, state.visibleCount);
  count.textContent = `${filtered.length} of ${cache.items.length}`;

  node.innerHTML = visible
    .map((item) => {
      const topics = (item.topics || []).slice(0, 2).map((topic) => TOPIC_LABELS[topic] || topic);
      const names = entityNames(item);
      const engagement = item.engagement !== null && item.engagementLabel
        ? `${compactNumber(item.engagement)} ${item.engagementLabel}`
        : null;
      return `<li class="feed-item">
        <a class="feed-title" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
        <div class="feed-meta">
          <span class="feed-kind ${esc(item.kind)}">${KIND_LABEL[item.kind] || esc(item.kind)}</span>
          <span>${esc(item.publisher)}</span>
          <span>${relativeTime(item.publishedAt)}</span>
          ${engagement ? `<span>${esc(engagement)}</span>` : ''}
          ${names.length ? `<span>${esc(names.join(', '))}</span>` : ''}
          ${topics.map((topic) => `<span class="topic-tag">${esc(topic)}</span>`).join('')}
        </div>
      </li>`;
    })
    .join('');

  empty.hidden = filtered.length > 0;
  more.hidden = filtered.length <= state.visibleCount;
}

/* ---------- method ---------- */

function renderMethod(state) {
  const node = byId('method');
  const cache = state.cache;
  const bands = BUZZ.bands
    .map((band) => `<tr><td>${band.min}–100</td><td>${esc(band.label)}</td><td>${esc(band.note)}</td></tr>`)
    .join('');

  const build = cache?.build;
  const buildFacts = build
    ? `<ul class="note-list">
        <li>Built ${clockTime(cache.generatedAt, timeZone(state))} ${cache.site?.timezoneLabel || ''}, in ${build.durationMs} ms.</li>
        <li>${build.sourcesLive} of ${build.sourcesAttempted} sources answered on this run; ${build.sourcesWithRecords} produced records.</li>
        <li>${build.recordsKept} records kept, ${build.duplicatesDropped} duplicates dropped, ${build.recordsRetained} carried over from the previous snapshot.</li>
        <li>${build.relay ? 'Fetched through the allowlisted relay.' : 'Fetched directly from the runner.'} ${
          build.bridge ? 'A social bridge is configured.' : 'No social bridge is configured, so Instagram and X are not read.'
        }</li>
      </ul>`
    : '<p class="panel-sub">No build information in this snapshot.</p>';

  node.innerHTML = `<div class="method-grid">
    <div>
      <h3>The number</h3>
      <p>Every record carries energy: <code>kind weight × engagement × 2^(−age ÷ half-life)</code>.
      The score is <code>100 × (1 − e^(−total energy ÷ ${BUZZ.saturationEnergy}))</code>, so the meter rises
      steeply with the first few stories and flattens as the room gets loud. Momentum compares the last
      ${WINDOW.momentumHours} hours with the ${WINDOW.momentumHours}–${WINDOW.scoreHours} hours before it.</p>
    </div>
    <div>
      <h3>Decay and eligibility</h3>
      <table class="method-table">
        <thead><tr><th>Kind</th><th>Half-life</th><th>Drops out after</th></tr></thead>
        <tbody>
          <tr><td>News</td><td>${DECAY.news.halfLifeHours}h</td><td>${DECAY.news.maxAgeHours}h</td></tr>
          <tr><td>Social</td><td>${DECAY.social.halfLifeHours}h</td><td>${DECAY.social.maxAgeHours}h</td></tr>
        </tbody>
      </table>
    </div>
    <div>
      <h3>Bands</h3>
      <table class="method-table">
        <thead><tr><th>Score</th><th>Label</th><th>Reading</th></tr></thead>
        <tbody>${bands}</tbody>
      </table>
    </div>
    <div>
      <h3>Rules</h3>
      <ul class="note-list">
        <li>The same story is counted once, matched by URL and by normalized headline, so syndicated copies do not inflate the meter.</li>
        <li>Topics and names come from fixed keyword and alias lists in <code>src/config.js</code>. No language model runs anywhere.</li>
        <li>A source that fails keeps its still-valid earlier records and is labelled cached; a genuinely empty response is labelled empty, not cached.</li>
        <li>Pinned subreddit posts and undated items are dropped rather than dated by guesswork.</li>
        <li>Engagement is used only where a source publishes it: YouTube view counts. Reddit's public feed carries no score, so it adds volume, not audience.</li>
        <li>The cache is rebuilt once an hour. Nothing on this page can refresh itself into a stronger reading.</li>
      </ul>
    </div>
    <div>
      <h3>This build</h3>
      ${buildFacts}
    </div>
    <div>
      <h3>Watchlist</h3>
      <p>${Object.keys(ENTITY_BY_ID).length} names are tracked across ${TOPICS.length} topics. A name only counts when the
      story's title or summary actually contains it, and ambiguous surnames are only matched as full names, so a
      different rider with the same last name cannot inherit someone else's buzz.</p>
    </div>
  </div>`;
}

/* ---------- entry point ---------- */

export function render(state) {
  byId('refresh').disabled = state.status === 'loading';

  renderStatus(state);
  renderTicks();
  renderGauge(state);
  renderMeta(state);
  renderHistory(state);
  renderSinceLast(state);
  renderThreads(state);
  renderHeat(state);
  renderWhere(state);
  renderSources(state);
  renderMethod(state);
  renderFeed(state);

  for (const button of document.querySelectorAll('[data-kind]')) {
    button.setAttribute('aria-pressed', String(button.dataset.kind === state.filter.kind));
  }
  const select = document.getElementById('topic-filter');
  if (select) select.value = state.filter.topic;
}

export { FEED_PAGE_SIZE, esc };
