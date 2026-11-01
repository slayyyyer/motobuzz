/**
 * News adapters.
 *
 * Two kinds of source share one shape: the official series feeds that still
 * publish public RSS, and Google News topic queries, which reach the outlets
 * that block datacenter traffic with a login wall or a CDN challenge. Google
 * News items carry the real outlet in <source>, so the publisher shown is the
 * publisher, not the index.
 */
import { FEEDS, NEWS_QUERIES, GOOGLE_NEWS_ENDPOINT, INGEST, NEWS_TITLE_DENYLIST } from '../config.js';
import { httpsUrl, truncate } from '../lib/text.js';
import { fetchText } from './http.js';
import { parseFeed } from './feed.js';

function googleUrl(entry) {
  const query = entry.when ? `${entry.query} when:${entry.when}` : entry.query;
  const params = new URLSearchParams({
    q: query,
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  return `${GOOGLE_NEWS_ENDPOINT}?${params.toString()}`;
}

export function newsSourceDefs() {
  const feeds = FEEDS.map((feed) => ({
    id: feed.id,
    label: feed.label,
    provider: feed.provider,
    homepage: feed.homepage,
    url: feed.url,
    kind: 'news',
    type: 'feed',
  }));

  const queries = NEWS_QUERIES.map((entry) => ({
    id: entry.id,
    label: `Google News · ${entry.label}`,
    provider: 'Google News index',
    homepage: 'https://news.google.com/',
    url: googleUrl(entry),
    kind: 'news',
    type: 'google',
  }));

  return [...feeds, ...queries];
}

function stripPublisherSuffix(title, publisher) {
  if (!publisher) return title;
  const escaped = publisher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(`\\s+[-–—]\\s*${escaped}\\s*$`, 'i'), '').trim();
}

/** True for search-index spam rather than reporting; exported for the tests. */
export function isJunkTitle(title) {
  const text = String(title || '');
  if (text.trim().length === 0) return true;
  return NEWS_TITLE_DENYLIST.some((pattern) => pattern.test(text));
}

/**
 * @param {ReturnType<typeof newsSourceDefs>[number]} def
 * @param {{relay?: string|null, now: number, fetchedAt: number}} ctx
 */
export async function loadNewsSource(def, ctx) {
  const { relay = null, now = Date.now(), fetchedAt = now } = ctx;

  const response = await fetchText(def.url, { relay });
  const parsed = parseFeed(response.body);

  if (!parsed.ok) {
    return { status: 'malformed', error: parsed.error || 'Feed could not be parsed.', records: [], note: null };
  }
  if (parsed.isEmpty) {
    return { status: 'empty', error: null, records: [], note: 'Feed returned no items.' };
  }

  const records = [];
  let undated = 0;
  let unusable = 0;
  let spam = 0;

  for (const item of parsed.items.slice(0, INGEST.itemsPerFeed)) {
    const url = httpsUrl(item.link);
    if (!url) {
      unusable += 1;
      continue;
    }

    let publisher = def.label;
    let publisherUrl = def.homepage;
    let title = item.title;

    if (def.type === 'google') {
      publisher = item.sourceName ? truncate(item.sourceName, 80) : 'Google News';
      publisherUrl = httpsUrl(item.sourceUrl) || 'https://news.google.com/';
      title = stripPublisherSuffix(title, item.sourceName);
    }

    if (!item.publishedAt) {
      undated += 1;
      continue;
    }

    if (isJunkTitle(title)) {
      spam += 1;
      continue;
    }

    records.push({
      sourceId: def.id,
      kind: 'news',
      publisher,
      publisherUrl,
      title: truncate(title, INGEST.maxTitleLength),
      summary: item.summary ? truncate(item.summary, INGEST.maxSummaryLength) : null,
      url,
      publishedAt: item.publishedAt,
      fetchedAt,
      engagement: null,
      engagementLabel: null,
      replies: null,
      channel: null,
    });
  }

  if (records.length === 0) {
    const note = undated > 0 ? 'Feed items had no publication date.' : 'No usable items in the feed.';
    return { status: undated === parsed.items.length ? 'malformed' : 'empty', error: null, records: [], note };
  }

  const notes = [];
  if (undated > 0) notes.push(`${undated} undated item${undated === 1 ? '' : 's'} skipped`);
  if (unusable > 0) notes.push(`${unusable} item${unusable === 1 ? '' : 's'} without a usable link`);
  if (spam > 0) notes.push(`${spam} live-stream page${spam === 1 ? '' : 's'} skipped`);

  return {
    status: 'live',
    error: null,
    records,
    note: notes.length ? notes.join('; ') : null,
  };
}
