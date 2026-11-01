/**
 * The local Instagram capture.
 *
 * GitHub's runners are answered with a login shell or a 429, so the hourly build
 * cannot read Instagram itself. An ordinary home connection usually can. This
 * module is the read side of `npm run instagram:capture`: the script writes
 * snapshots/instagram.json, it gets committed, and the build uses it for any
 * profile it could not read live.
 *
 * Nothing here trusts the file beyond its shape. A missing, empty or malformed
 * capture is null, and the live routes run exactly as they would without one.
 */
import { DECAY, INGEST, INSTAGRAM_CAPTURE } from '../config.js';
import { httpsUrl, truncate } from '../lib/text.js';

/**
 * @param {unknown} raw
 * @returns {{capturedAt: number|null, handles: Record<string, object>}|null}
 */
export function parseInstagramCapture(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const handles = raw.handles;
  if (!handles || typeof handles !== 'object' || Array.isArray(handles)) return null;

  const cleaned = {};
  for (const [handle, entry] of Object.entries(handles)) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.posts)) continue;
    const capturedAt = Number(entry.capturedAt);
    if (!Number.isFinite(capturedAt)) continue;
    cleaned[String(handle).toLowerCase()] = {
      capturedAt,
      via: typeof entry.via === 'string' ? entry.via : null,
      username: typeof entry.username === 'string' ? entry.username : null,
      followers: Number.isFinite(entry.followers) ? entry.followers : null,
      posts: entry.posts,
    };
  }

  return { capturedAt: Number.isFinite(Number(raw.capturedAt)) ? Number(raw.capturedAt) : null, handles: cleaned };
}

/** A capture older than INSTAGRAM_CAPTURE.maxAgeHours is not used at all. */
export function captureIsFresh(entry, now) {
  if (!entry || !Number.isFinite(entry.capturedAt)) return false;
  const age = now - entry.capturedAt;
  return age >= -60_000 && age <= INSTAGRAM_CAPTURE.maxAgeHours * 3_600_000;
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
      title: truncate(typeof post.title === 'string' && post.title ? post.title : `Instagram post by @${def.handle}`, INGEST.maxTitleLength),
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

  const hours = Math.max(0, Math.round((now - entry.capturedAt) / 3_600_000));
  return {
    status: 'cached',
    error: null,
    records,
    note: `Read locally ${hours < 1 ? 'under an hour' : `${hours} h`} ago, where Instagram served the page.`,
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
