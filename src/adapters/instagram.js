/**
 * Instagram adapter.
 *
 * Instagram serves a logged-out browser a 500 KB JavaScript shell containing no
 * posts at all. It serves a crawler user agent the same URL with a rendered page
 * holding a `polaris_timeline_connection` blob: recent posts, their captions and
 * media ids. Each post's own page then carries the exact publish time and the
 * like/comment counts in its metadata.
 *
 * That is undocumented markup, so every failure is reported (malformed / empty)
 * rather than swallowed, and nothing here fabricates a date. Posts whose post
 * page cannot be read are dropped instead of being stamped with "now".
 */
import { DECAY, INGEST, INSTAGRAM_CRAWLER_UA, INSTAGRAM_PROFILES } from '../config.js';
import { decodeEntities, httpsUrl, parseCount, truncate } from '../lib/text.js';
import { fetchText, sleep } from './http.js';

const BASE = 'https://www.instagram.com';
const MAX_DEPTH = 40;

function walkFor(node, predicate, depth = 0) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = walkFor(item, predicate, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  for (const value of Object.values(node)) {
    const hit = walkFor(value, predicate, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Instagram's URL-safe base64: a media id in base64 is the post shortcode. */
export function shortcodeFromPk(pk) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let value;
  try {
    value = BigInt(pk);
  } catch {
    return null;
  }
  if (value <= 0n) return null;
  let out = '';
  while (value > 0n) {
    out = alphabet[Number(value % 64n)] + out;
    value /= 64n;
  }
  return out;
}

export function instagramSourceDefs() {
  return INSTAGRAM_PROFILES.map((entry) => ({
    id: entry.id,
    label: entry.label,
    provider: 'Instagram profile page',
    homepage: `${BASE}/${entry.handle}/`,
    url: `${BASE}/${entry.handle}/`,
    handle: entry.handle,
    kind: 'social',
    type: 'instagram',
  }));
}

/**
 * Lift the profile and its recent posts out of a crawler-rendered page.
 * Exported so the suite can run it against a fixture without the network.
 */
export function extractProfile(html) {
  const source = String(html || '');
  let profile = null;
  let timeline = null;

  for (const block of source.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    const raw = block[1];
    if (!raw.includes('polaris_timeline_connection') && !raw.includes('follower_count')) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!timeline) {
      const hit = walkFor(parsed, (node) => Array.isArray(node.polaris_timeline_connection?.edges));
      if (hit) timeline = hit.polaris_timeline_connection;
    }
    if (!profile) {
      const hit = walkFor(
        parsed,
        (node) => Number.isFinite(node.follower_count) && typeof node.username === 'string',
      );
      if (hit) profile = hit;
    }
    if (timeline && profile) break;
  }

  const posts = [];
  for (const edge of timeline?.edges || []) {
    const node = edge?.node;
    if (!node) continue;
    const pk = node.pk ? String(node.pk) : String(node.id || '').replace(/^POLARIS_/, '');
    if (!/^\d{6,}$/.test(pk)) continue;
    const caption = typeof node.caption?.text === 'string' ? node.caption.text : null;
    posts.push({
      pk,
      caption,
      isVideo: node.media_type === 2,
      shortcode: shortcodeFromPk(pk),
    });
  }

  return {
    username: profile?.username ?? null,
    fullName: profile?.full_name ?? null,
    followers: Number.isFinite(profile?.follower_count) ? profile.follower_count : null,
    biography: typeof profile?.biography === 'string' ? profile.biography : null,
    posts,
  };
}

/**
 * A single post page carries its own metadata:
 * "13K likes, 46 comments - kenroczen94 on October 31, 2026: "…"" plus an exact
 * epoch in `taken_at`, with `<time dateTime>` as the fallback.
 */
export function extractPostMeta(html) {
  const source = String(html || '');
  const og = decodeEntities(
    (source.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i) || [, ''])[1],
  );

  const likes = og.match(/([\d.,]+\s*[kmb]?)\s+likes?\b/i);
  const comments = og.match(/([\d.,]+\s*[kmb]?)\s+comments?\b/i);
  const author = og.match(/-\s*([A-Za-z0-9._]+)\s+on\s+/);

  let publishedAt = null;
  const taken = source.match(/"taken_at"\s*:\s*(\d{9,})/);
  if (taken) publishedAt = Number(taken[1]) * 1000;

  if (!Number.isFinite(publishedAt)) {
    const stamps = [...source.matchAll(/dateTime="([^"]+)"/gi)]
      .map((match) => Date.parse(match[1]))
      .filter((value) => Number.isFinite(value));
    // A post is older than every comment on it, so the earliest stamp is the post.
    if (stamps.length > 0) publishedAt = Math.min(...stamps);
  }

  if (!Number.isFinite(publishedAt)) {
    const stated = og.match(/on\s+([A-Z][a-z]+ \d{1,2}, \d{4})/);
    if (stated) {
      const parsed = Date.parse(stated[1]);
      if (Number.isFinite(parsed)) publishedAt = parsed;
    }
  }

  return {
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
    likes: likes ? parseCount(likes[1]) : null,
    comments: comments ? parseCount(comments[1]) : null,
    author: author ? author[1] : null,
  };
}

/**
 * @param {ReturnType<typeof instagramSourceDefs>[number]} def
 * @param {{relay?: string|null, now: number, fetchedAt: number}} ctx
 */
export async function loadInstagramSource(def, ctx) {
  const { relay = null, now = Date.now(), fetchedAt = now } = ctx;
  const headers = { 'user-agent': INSTAGRAM_CRAWLER_UA };

  const page = await fetchText(def.url, {
    relay,
    headers,
    accept: 'text/html,application/xhtml+xml',
    timeoutMs: INGEST.instagramTimeoutMs,
  });

  if (!/<html[\s>]/i.test(page.body.slice(0, 4000))) {
    return { status: 'malformed', error: 'Profile page was not HTML.', records: [], note: null, snapshot: null };
  }

  const profile = extractProfile(page.body);
  const snapshot = {
    handle: def.handle,
    url: def.url,
    username: profile.username,
    fullName: profile.fullName,
    followers: profile.followers,
    biography: profile.biography,
    posts: [],
  };

  if (profile.posts.length === 0) {
    return {
      status: 'malformed',
      error: 'No posts found in the profile page.',
      records: [],
      note: 'Instagram markup may have changed, or the account is private.',
      snapshot,
    };
  }

  const records = [];
  let undated = 0;

  for (const [index, post] of profile.posts.entries()) {
    if (index >= INGEST.instagramPostsPerProfile) break;
    if (!post.caption || !post.shortcode) continue;

    const url = httpsUrl(`${BASE}/p/${post.shortcode}/`);
    if (!url) continue;

    if (index > 0) await sleep(INGEST.instagramSpacingMs);

    let meta = null;
    try {
      const postPage = await fetchText(url, {
        relay,
        headers,
        accept: 'text/html,application/xhtml+xml',
        timeoutMs: INGEST.instagramTimeoutMs,
      });
      meta = extractPostMeta(postPage.body);
    } catch {
      meta = null;
    }

    const entry = {
      shortcode: post.shortcode,
      caption: truncate(post.caption, INGEST.maxSummaryLength),
      publishedAt: meta?.publishedAt ?? null,
      likes: meta?.likes ?? null,
      comments: meta?.comments ?? null,
      isVideo: post.isVideo,
    };
    snapshot.posts.push(entry);

    if (!entry.publishedAt) {
      undated += 1;
      continue;
    }
    if (now - entry.publishedAt > DECAY.social.maxAgeHours * 3_600_000) continue;

    records.push({
      sourceId: def.id,
      kind: 'social',
      publisher: def.label,
      publisherUrl: httpsUrl(def.homepage),
      title: truncate(post.caption, INGEST.maxTitleLength),
      summary: entry.caption && entry.caption !== truncate(post.caption, INGEST.maxTitleLength) ? entry.caption : null,
      url,
      publishedAt: entry.publishedAt,
      fetchedAt,
      engagement: entry.likes,
      engagementLabel: entry.likes === null ? null : 'likes',
      replies: entry.comments,
      channel: `@${def.handle}`,
    });
  }

  if (records.length === 0) {
    return {
      status: 'empty',
      error: null,
      records: [],
      note: undated > 0 ? 'Recent posts had no readable publish time.' : 'No posts inside the retention window.',
      snapshot,
    };
  }

  return { status: 'live', error: null, records, note: null, snapshot };
}
