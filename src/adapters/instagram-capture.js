/**
 * The local Instagram capture.
 *
 * GitHub's runners are answered with a login shell or a 429, so the hourly build
 * cannot read Instagram itself. An ordinary home connection usually can.
 * `npm run capture:instagram` writes snapshots/instagram.json, it gets committed,
 * and the build uses it for any profile it could not read live.
 *
 * The file's shape, its freshness window and its age label live in
 * local-capture.js, which the Reddit capture shares; this module only maps a
 * captured post into an Instagram record.
 */
import { DECAY, INGEST, INSTAGRAM_CAPTURE } from '../config.js';
import { httpsUrl, truncate } from '../lib/text.js';
import { captureAgeLabel, entryIsFresh, readCaptureEntries } from './local-capture.js';

/**
 * @param {unknown} raw
 * @returns {{capturedAt: number|null, handles: Record<string, object>}|null}
 */
export function parseInstagramCapture(raw) {
  const parsed = readCaptureEntries(raw, 'handles');
  if (!parsed) return null;
  return { capturedAt: parsed.capturedAt, handles: parsed.entries };
}

/** A capture older than INSTAGRAM_CAPTURE.maxAgeHours is not used at all. */
export function captureIsFresh(entry, now) {
  return entryIsFresh(entry, now, INSTAGRAM_CAPTURE.maxAgeHours);
}

/**
 * Records for one handle out of a committed capture, or null when the capture
 * has nothing usable for it. Publish times are kept exactly as captured: a read
 * made where Instagram served the real page carries exact hours, and one that
 * only reached the coarse route stays day-precision.
 *
 * @param {ReturnType<typeof parseInstagramCapture>|null} capture
 * @param {{id: string, label: string, handle: string, homepage: string, url: string}} def
 * @param {{now?: number}} [ctx]
 */
export function captureRecordsFor(capture, def, ctx = {}) {
  const { now = Date.now() } = ctx;
  if (!capture || !def || typeof def.handle !== 'string') return null;
  const entry = capture.handles[def.handle.toLowerCase()];
  if (!captureIsFresh(entry, now)) return null;

  const records = [];
  for (const post of entry.posts) {
    const url = httpsUrl(post?.url);
    const publishedAt = Number(post?.publishedAt);
    if (!url || !Number.isFinite(publishedAt)) continue;
    // A record cannot be older than the cache keeps, nor newer than "now".
    if (publishedAt > now + 3_600_000) continue;
    if (now - publishedAt > DECAY.social.maxAgeHours * 3_600_000) continue;

    const likes = Number.isFinite(post.likes) ? post.likes : null;
    const comments = Number.isFinite(post.comments) ? post.comments : null;
    records.push({
      sourceId: def.id,
      kind: 'social',
      publisher: def.label,
      publisherUrl: httpsUrl(def.homepage),
      title: truncate(
        typeof post.title === 'string' && post.title ? post.title : `Instagram post by @${def.handle}`,
        INGEST.maxTitleLength,
      ),
      summary: typeof post.summary === 'string' && post.summary ? truncate(post.summary, INGEST.maxSummaryLength) : null,
      url,
      publishedAt,
      fetchedAt: entry.capturedAt,
      engagement: likes,
      engagementLabel: likes === null ? null : 'likes',
      replies: comments,
      channel: `@${def.handle}`,
      dateBasis: post.dateBasis === 'day' ? 'day' : 'exact',
    });
  }

  if (records.length === 0) return null;

  return {
    status: 'cached',
    error: null,
    records,
    note: `Read locally ${captureAgeLabel(entry.capturedAt, now)}, where Instagram served the page.`,
    snapshot: {
      handle: def.handle,
      url: def.url,
      username: entry.username,
      fullName: null,
      followers: entry.followers,
      biography: null,
      via: 'local capture',
      posts: [],
    },
  };
}
