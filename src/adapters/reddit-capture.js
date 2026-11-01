/**
 * The local Reddit capture.
 *
 * Reddit throttles datacenter traffic, so on most runner builds two of the three
 * subreddits come back 429. A home connection is served the public Atom feed
 * normally. This module is the read side of `npm run capture`: the script writes
 * snapshots/reddit.json, it gets committed, and the build uses it for any
 * subreddit it could not read live.
 *
 * Reddit's public feed carries no score, so a captured post contributes volume
 * and recency rather than audience size, exactly as a live one does.
 */
import { DECAY, INGEST, REDDIT_CAPTURE } from '../config.js';
import { httpsUrl, truncate } from '../lib/text.js';
import { captureAgeLabel, entryIsFresh, readCaptureEntries } from './local-capture.js';

/**
 * @param {unknown} raw
 * @returns {{capturedAt: number|null, subreddits: Record<string, object>}|null}
 */
export function parseRedditCapture(raw) {
  const parsed = readCaptureEntries(raw, 'subreddits');
  if (!parsed) return null;
  return { capturedAt: parsed.capturedAt, subreddits: parsed.entries };
}

/**
 * Records for one subreddit out of a committed capture, or null when the
 * capture has nothing usable for it.
 *
 * @param {ReturnType<typeof parseRedditCapture>|null} capture
 * @param {{id: string, label: string, sub: string, homepage: string}} def
 * @param {{now?: number}} [ctx]
 */
export function redditCaptureRecordsFor(capture, def, ctx = {}) {
  const { now = Date.now() } = ctx;
  if (!capture || !def || typeof def.sub !== 'string') return null;
  const entry = capture.subreddits[def.sub.toLowerCase()];
  if (!entryIsFresh(entry, now, REDDIT_CAPTURE.maxAgeHours)) return null;

  const records = [];
  for (const post of entry.posts) {
    const url = httpsUrl(post?.url);
    const publishedAt = Number(post?.publishedAt);
    if (!url || !Number.isFinite(publishedAt)) continue;
    // A record cannot be older than the cache keeps, nor newer than "now".
    if (publishedAt > now + 3_600_000) continue;
    if (now - publishedAt > DECAY.social.maxAgeHours * 3_600_000) continue;

    records.push({
      sourceId: def.id,
      kind: 'social',
      publisher: def.label,
      publisherUrl: httpsUrl(def.homepage),
      title: truncate(
        typeof post.title === 'string' && post.title ? post.title : `Reddit post in ${def.label}`,
        INGEST.maxTitleLength,
      ),
      summary: typeof post.summary === 'string' && post.summary ? truncate(post.summary, INGEST.maxSummaryLength) : null,
      url,
      publishedAt,
      fetchedAt: entry.capturedAt,
      engagement: null,
      engagementLabel: null,
      replies: null,
      channel: def.label,
      dateBasis: 'exact',
    });
  }

  if (records.length === 0) return null;

  return {
    status: 'cached',
    error: null,
    records,
    note: `Read locally ${captureAgeLabel(entry.capturedAt, now)}, where Reddit answered.`,
  };
}
