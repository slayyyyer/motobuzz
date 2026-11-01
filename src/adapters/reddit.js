/**
 * Reddit adapter.
 *
 * Reddit's public JSON listing refuses datacenter traffic, and the Atom feed is
 * throttled on most runner builds. `npm run capture:reddit` records the
 * subreddits from a home connection and this adapter falls back to that
 * snapshot whenever the feed itself is refused. It carries no score, so a Reddit
 * post contributes volume and recency rather than audience size; the build
 * spaces requests out and treats a 429 as an unavailable source, not a failure.
 */
import { INGEST, REDDIT_ENDPOINT, SUBREDDITS } from '../config.js';
import { httpsUrl, truncate } from '../lib/text.js';
import { fetchText } from './http.js';
import { parseFeed } from './feed.js';
import { redditCaptureRecordsFor } from './reddit-capture.js';

export function redditSourceDefs() {
  return SUBREDDITS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    provider: 'Reddit public Atom feed',
    homepage: `${REDDIT_ENDPOINT}/r/${entry.sub}/`,
    url: `${REDDIT_ENDPOINT}/r/${entry.sub}/.rss`,
    sub: entry.sub,
    kind: 'social',
    type: 'reddit',
  }));
}

/**
 * @param {ReturnType<typeof redditSourceDefs>[number]} def
 * @param {{relay?: string|null, now: number, fetchedAt: number}} ctx
 */
export async function loadRedditSource(def, ctx) {
  const { relay = null, now = Date.now(), fetchedAt = now, capture = null } = ctx;
  const fromCapture = () => redditCaptureRecordsFor(capture, def, { now });

  let body;
  try {
    const response = await fetchText(def.url, {
      relay,
      accept: 'application/atom+xml, application/rss+xml, */*;q=0.5',
      headers: { 'user-agent': 'windows:motobuzz:1.0 (subreddit feed reader)' },
    });
    body = response.body;
  } catch (error) {
    // Throttled or refused outright: the home-connection capture stands in.
    const captured = fromCapture();
    if (captured) return captured;
    throw error;
  }

  const parsed = parseFeed(body);
  if (!parsed.ok) {
    const captured = fromCapture();
    if (captured) return captured;
    return { status: 'malformed', error: parsed.error || 'Subreddit feed could not be parsed.', records: [], note: null };
  }
  if (parsed.isEmpty) {
    const captured = fromCapture();
    if (captured) return captured;
    return { status: 'empty', error: null, records: [], note: 'Subreddit feed returned no posts.' };
  }

  const records = [];
  let skipped = 0;

  for (const item of parsed.items.slice(0, INGEST.itemsPerSubreddit)) {
    const url = httpsUrl(item.link);
    if (!url) {
      skipped += 1;
      continue;
    }
    // Reddit omits published on some entries; updated is the posting time.
    if (!item.publishedAt) {
      skipped += 1;
      continue;
    }
    if (/r\/([a-z0-9]+)\/comments\/([a-z0-9]+)\/\.rss/i.test(url)) {
      skipped += 1;
      continue;
    }

    records.push({
      sourceId: def.id,
      kind: 'social',
      publisher: def.label,
      publisherUrl: def.homepage,
      title: truncate(item.title, INGEST.maxTitleLength),
      summary: item.summary ? truncate(item.summary, INGEST.maxSummaryLength) : null,
      url,
      publishedAt: item.publishedAt,
      fetchedAt,
      engagement: null,
      engagementLabel: null,
      replies: null,
      channel: def.label,
    });
  }

  if (records.length === 0) {
    return { status: 'empty', error: null, records: [], note: 'No usable posts in the feed.' };
  }

  return {
    status: 'live',
    error: null,
    records,
    note: skipped > 0 ? `${skipped} unusable entr${skipped === 1 ? 'y' : 'ies'} skipped` : null,
  };
}
