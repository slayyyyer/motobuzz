/**
 * Instagram adapter.
 *
 * Four routes, in order:
 *
 * 0. A Meta app reading `business_discovery`. The Graph API returns exact
 *    timestamps, likes and comments for any public Business or Creator account
 *    in one call per handle, with no scraping, no cookie and no IP reputation to
 *    manage, so it wins whenever a token is configured - see INSTAGRAM_DISCOVERY.
 *
 * 1. A stored session cookie. Instagram's own web app reads profiles through
 *    `web_profile_info`, which returns exact timestamps and engagement for a
 *    signed-in session in one request, so it wins whenever a cookie is set.
 *    The cookie is never obtained here - see INSTAGRAM_SESSION.
 *
 * 2. The profile page. A crawler user agent is served a rendered page with a
 *    timeline blob, and each post's own page carries an exact publish time plus
 *    its like and comment counts. No third party, though the signed-out page is
 *    not always current.
 *
 * 3. A fallback for hosts Instagram refuses (GitHub's runners are answered with
 *    429 whatever the user agent). DuckDuckGo finds recent post permalinks and
 *    the microlink metadata API reads one post from its own infrastructure. It
 *    is coarse: microlink reports the publish DAY, not the hour, so those
 *    records are stamped at midday UTC and marked `dateBasis: 'day'`.
 *
 * 0. A stored session cookie. Instagram's own web app reads profiles through
 *    `web_profile_info`, which returns exact timestamps and engagement for a
 *    signed-in session in one request, so it wins whenever one is configured.
 *    The cookie is never obtained here — see INSTAGRAM_SESSION.
 *
 * 1. The profile page. Instagram serves a browser a login shell, but a crawler
 *    user agent gets the rendered page with a `polaris_timeline_connection`
 *    blob, and each post's own page carries an exact publish time plus its
 *    like/comment counts. This is the accurate route and needs no third party.
 *
 * 2. A fallback for hosts Instagram refuses (GitHub's runners get the login
 *    shell whatever the user agent). DuckDuckGo finds recent post permalinks,
 *    and the microlink metadata API reads one post from its own infrastructure,
 *    which is not blocked. That route is coarse: microlink reports the publish
 *    DAY, not the hour, so its records are stamped at midday UTC and marked
 *    `dateBasis: 'day'` rather than being passed off as exact.
 *
 * Every failure is reported (malformed / empty) instead of swallowed, and no
 * record is ever dated "now".
 */
import {
  DECAY,
  INGEST,
  INSTAGRAM_CRAWLER_UA,
  INSTAGRAM_DISCOVERY,
  INSTAGRAM_FALLBACK,
  INSTAGRAM_PROFILES,
  INSTAGRAM_SESSION,
} from '../config.js';
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
 * Lift the profile and its recent posts out of a rendered page.
 *
 * Instagram renamed both containers in 2026: the profile arrives as
 * `xig_user_by_username` and its timeline as `polaris_ordered_timeline_connection`
 * where each post carries its shortcode in `code` and no timestamp at all. The
 * older names are still read, so a page that predates the change parses too.
 * Posts come back newest first by media id, which is what makes the newest few
 * worth a post-page fetch for their exact publish time.
 */
export function extractProfile(html) {
  const source = String(html || '');
  let profile = null;
  let timeline = null;

  for (const block of source.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    const raw = block[1];
    if (!/xig_user_|polaris_(ordered_)?timeline_connection|follower_count/.test(raw)) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!timeline) {
      const hit = walkFor(
        parsed,
        (node) =>
          Array.isArray(node.polaris_ordered_timeline_connection?.edges) ||
          Array.isArray(node.polaris_timeline_connection?.edges),
      );
      if (hit) timeline = hit.polaris_ordered_timeline_connection ?? hit.polaris_timeline_connection;
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
    const stated = typeof node.code === 'string' ? node.code : node.shortcode;
    const shortcode = stated || shortcodeFromPk(pk);
    if (!shortcode || !/^[A-Za-z0-9_-]{6,}$/.test(shortcode)) continue;
    const rawCaption = node.caption;
    const caption =
      typeof rawCaption === 'string' ? rawCaption : typeof rawCaption?.text === 'string' ? rawCaption.text : null;
    posts.push({ pk, caption, isVideo: node.media_type === 2, shortcode });
  }

  // An integer media id grows with every post, so descending is newest-first.
  posts.sort((left, right) => {
    try {
      const diff = BigInt(right.pk) - BigInt(left.pk);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    } catch {
      return 0;
    }
  });

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

/** Post permalinks out of a DuckDuckGo results page, plain or URL-encoded. */
export function parseSearchCodes(html) {
  const source = decodeEntities(String(html || ''));
  const codes = new Set();
  for (const match of source.matchAll(/instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]{6,})/g)) codes.add(match[1]);
  for (const match of source.matchAll(/instagram\.com%2F(?:p|reel)%2F([A-Za-z0-9_-]{6,})/gi)) codes.add(match[1]);
  return [...codes];
}

/**
 * Read one post from a microlink response. The description is Instagram's own
 * og:description, so the counts are real; the date is day-precision, which is
 * why the returned timestamp sits at midday UTC and callers mark it as coarse.
 */
export function parseMicrolinkPost(payload, code) {
  const data = payload?.data;
  if (!data) return null;

  const description = decodeEntities(String(data.description || ''));
  const likes = description.match(/([\d.,]+\s*[kmb]?)\s+likes?\b/i);
  const comments = description.match(/([\d.,]+\s*[kmb]?)\s+comments?\b/i);
  const author = description.match(/-\s*([A-Za-z0-9._]+)\s+on\s+/);
  const caption = description.match(/:\s*[“"]([\s\S]+?)[”"]\.?\s*$/);
  const stated = description.match(/on\s+([A-Z][a-z]+ \d{1,2}, \d{4})/);

  let publishedAt = null;
  const parsedDate = data.date ? Date.parse(data.date) : Number.NaN;
  if (Number.isFinite(parsedDate)) publishedAt = parsedDate;
  else if (stated) {
    const parsedStated = Date.parse(stated[1]);
    if (Number.isFinite(parsedStated)) publishedAt = parsedStated;
  }
  if (!Number.isFinite(publishedAt)) return null;

  // Centre the unknown hour in the reported day rather than inventing one.
  const at = new Date(publishedAt);
  const centred = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 12, 0, 0);

  return {
    code,
    author: author ? author[1] : null,
    likes: likes ? parseCount(likes[1]) : null,
    comments: comments ? parseCount(comments[1]) : null,
    caption: caption ? caption[1].trim() : null,
    publishedAt: centred,
    dateBasis: 'day',
  };
}

/**
 * Read the stored cookie, accepting either the bare value or a pasted
 * `sessionid=…; csrftoken=…` jar. Every cookie is kept, because the jar is what
 * makes the session look like the browser that created it. Returns null when
 * nothing is configured, so the authenticated route simply does not run.
 */
export function sessionConfig(env = process.env) {
  const raw = String(env.INSTAGRAM_SESSIONID || '').trim();
  if (!raw) return null;
  // A bare id is the common paste; otherwise keep every cookie that came with it.
  if (!raw.includes('=')) return /^[\w.:%-]+$/.test(raw) ? { cookie: `sessionid=${raw}` } : null;
  const jar = raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z0-9_.-]+=\S+$/.test(part));
  if (!jar.some((part) => part.startsWith('sessionid='))) return null;
  return { cookie: jar.join('; ') };
}

/**
 * Lift a profile out of `web_profile_info`: exact `taken_at_timestamp`, real
 * like and comment counts, the caption, and no second request.
 */
export function parseWebProfile(payload) {
  const user = payload?.data?.user;
  if (!user) {
    const message = `${payload?.message || ''} ${payload?.status || ''}`.toLowerCase();
    const error = message.includes('checkpoint')
      ? 'checkpoint_required'
      : message.includes('login') || message.includes('unauth') || payload?.require_login
        ? 'login_required'
        : 'no_user';
    return { error, username: null, fullName: null, followers: null, biography: null, posts: [] };
  }

  const posts = [];
  for (const edge of user.edge_owner_to_timeline_media?.edges ?? []) {
    const node = edge?.node;
    if (!node?.shortcode) continue;
    const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text;
    const taken = Number(node.taken_at_timestamp);
    posts.push({
      shortcode: node.shortcode,
      caption: typeof caption === 'string' ? caption : null,
      isVideo: node.is_video === true,
      publishedAt: Number.isFinite(taken) ? taken * 1000 : null,
      likes: Number.isFinite(node.edge_liked_by?.count) ? node.edge_liked_by.count : null,
      comments: Number.isFinite(node.edge_media_to_comment?.count) ? node.edge_media_to_comment.count : null,
    });
  }

  return {
    error: null,
    username: user.username ?? null,
    fullName: user.full_name ?? null,
    followers: Number.isFinite(user.edge_followed_by?.count) ? user.edge_followed_by.count : null,
    biography: typeof user.biography === 'string' ? user.biography : null,
    posts,
  };
}

function fallbackIsDue(now) {
  const hours = Math.floor(now / 3_600_000);
  return hours % INSTAGRAM_FALLBACK.intervalHours === 0;
}

/** microlink reports exhausted quota as status fail with code ERATE. */
export function isMetadataRateLimited(payload) {
  return payload?.status === 'fail' && /ERATE|rate limit/i.test(`${payload?.code || ''} ${payload?.message || ''}`);
}

/**
 * Coarse route for hosts Instagram refuses: find permalinks with DuckDuckGo,
 * read the unseen ones through microlink. Capped hard, because the free tier is
 * small and this must never become the load-bearing path.
 */
export async function loadInstagramFallback(def, ctx) {
  const { relay = null, now = Date.now(), fetchedAt = now, seenPostCodes = new Set() } = ctx;
  const headers = { 'user-agent': INSTAGRAM_FALLBACK.searchUserAgent };

  if (!fallbackIsDue(now)) {
    return {
      status: 'empty',
      error: null,
      records: [],
      note: 'Coarse fallback runs every few hours; nothing due this run.',
      snapshot: null,
    };
  }

  const query = `site:instagram.com/p ${def.handle}`;
  const search = await fetchText(`${INSTAGRAM_FALLBACK.searchUrl}?q=${encodeURIComponent(query)}`, {
    relay,
    headers,
    accept: 'text/html,application/xhtml+xml',
    timeoutMs: INGEST.instagramTimeoutMs,
  });

  const codes = parseSearchCodes(search.body)
    .slice(0, INSTAGRAM_FALLBACK.searchResults)
    .filter((code) => !seenPostCodes.has(code));

  // DuckDuckGo answers a suspected bot with 202 and a challenge page, not results.
  if (search.status === 202 || /challenge|captcha|anomaly/i.test(search.body)) {
    return {
      status: 'unavailable',
      error: 'Search refused the query with a bot challenge.',
      records: [],
      note: null,
      snapshot: null,
    };
  }
  if (codes.length === 0) {
    return {
      status: 'empty',
      error: null,
      records: [],
      note: 'Search found no post permalinks this profile has not already supplied.',
      snapshot: null,
    };
  }

  const records = [];
  const posts = [];
  let consulted = 0;
  let rateLimited = false;

  for (const code of codes) {
    if (consulted >= INSTAGRAM_FALLBACK.metadataCallsPerRun) break;
    if (records.length >= INSTAGRAM_FALLBACK.postsPerProfile) break;
    consulted += 1;
    if (consulted > 1) await sleep(INGEST.instagramSpacingMs);

    let post = null;
    try {
      const response = await fetchText(
        `${INSTAGRAM_FALLBACK.metadataUrl}?url=${encodeURIComponent(`${BASE}/p/${code}/`)}`,
        {
          relay,
          headers: { 'user-agent': INSTAGRAM_FALLBACK.searchUserAgent },
          accept: 'application/json',
          timeoutMs: INGEST.instagramTimeoutMs,
        },
      );
      const payload = JSON.parse(response.body);
      if (isMetadataRateLimited(payload)) {
        rateLimited = true;
        break;
      }
      post = parseMicrolinkPost(payload, code);
    } catch {
      post = null;
    }
    if (!post) continue;
    // The search may surface other accounts quoting this rider; only keep the profile's own posts.
    if (post.author && post.author.toLowerCase() !== def.handle.toLowerCase()) continue;
    if (now - post.publishedAt > DECAY.social.maxAgeHours * 3_600_000) continue;

    const url = httpsUrl(`${BASE}/p/${code}/`);
    if (!url) continue;

    posts.push({
      shortcode: code,
      caption: post.caption ? truncate(post.caption, INGEST.maxSummaryLength) : null,
      publishedAt: post.publishedAt,
      likes: post.likes,
      comments: post.comments,
      dateBasis: 'day',
    });

    records.push({
      sourceId: def.id,
      kind: 'social',
      publisher: def.label,
      publisherUrl: httpsUrl(def.homepage),
      title: truncate(post.caption || `Instagram post by @${def.handle}`, INGEST.maxTitleLength),
      summary: null,
      url,
      publishedAt: post.publishedAt,
      fetchedAt,
      engagement: post.likes,
      engagementLabel: post.likes === null ? null : 'likes',
      replies: post.comments,
      channel: `@${def.handle}`,
      dateBasis: 'day',
    });
  }

  const snapshot = {
    handle: def.handle,
    url: def.url,
    username: def.handle,
    fullName: null,
    followers: null,
    biography: null,
    via: 'search+metadata',
    posts,
  };

  if (rateLimited && records.length === 0) {
    return {
      status: 'unavailable',
      error: 'Metadata API daily limit reached.',
      records: [],
      note: null,
      snapshot,
    };
  }

  if (records.length === 0) {
    return {
      status: 'empty',
      error: null,
      records: [],
      note: 'Coarse fallback found no readable post metadata.',
      snapshot,
    };
  }

  return { status: 'live', error: null, records, note: 'Coarse fallback: day-precision dates.', snapshot };
}

/**
 * @param {ReturnType<typeof instagramSourceDefs>[number]} def
 * @param {{relay?: string|null, now: number, fetchedAt: number, seenPostCodes?: Set<string>}} ctx
 */
/**
 * The authenticated route. Requested directly, not through the relay: the relay
 * forwards a fixed set of headers, and a session cookie should not be handed to
 * an intermediary anyway.
 */
/**
 * The token and the app owner's own IG user id. Discovery is performed *as* that
 * account, so both are required; with either missing the route is skipped.
 */
export function discoveryConfig(env = process.env) {
  const token = String(env.INSTAGRAM_TOKEN || '').trim();
  const businessId = String(env.INSTAGRAM_BUSINESS_ID || '').trim();
  if (!token || !businessId) return null;
  return { token, businessId };
}

/**
 * Read a `business_discovery` response. Graph reports every refusal as an error
 * object rather than an HTTP status, so the code decides the message: a dead
 * token, a handle it cannot see (personal, private, age-gated, or simply wrong -
 * Instagram does not say which), or anything else.
 */
export function parseDiscoveryMedia(payload) {
  const failure = payload?.error;
  if (failure) {
    const code = Number(failure.code);
    const subcode = Number(failure.error_subcode);
    const kind =
      code === INSTAGRAM_DISCOVERY.errorCodes.tokenRejected
        ? 'token_rejected'
        : code === INSTAGRAM_DISCOVERY.errorCodes.notDiscoverable ||
            subcode === INSTAGRAM_DISCOVERY.errorCodes.notFoundSubcode
          ? 'not_discoverable'
          : 'unknown';
    return {
      error: kind,
      message: failure.error_user_msg || failure.message || null,
      username: null,
      followers: null,
      posts: [],
    };
  }

  const found = payload?.business_discovery;
  if (!found) return { error: 'no_profile', message: null, username: null, followers: null, posts: [] };

  const posts = [];
  for (const item of found.media?.data ?? []) {
    const permalink = httpsUrl(item.permalink);
    const publishedAt = Date.parse(item.timestamp);
    if (!permalink || !Number.isFinite(publishedAt)) continue;
    posts.push({
      permalink,
      caption: typeof item.caption === 'string' ? item.caption : null,
      isVideo: item.media_type === 'VIDEO',
      publishedAt,
      likes: Number.isFinite(item.like_count) ? item.like_count : null,
      comments: Number.isFinite(item.comments_count) ? item.comments_count : null,
    });
  }
  posts.sort((left, right) => right.publishedAt - left.publishedAt);

  return {
    error: null,
    message: null,
    username: typeof found.username === 'string' ? found.username : null,
    followers: Number.isFinite(found.followers_count) ? found.followers_count : null,
    posts,
  };
}

/**
 * One Graph API call per handle, made directly: the token must not transit the
 * relay either. Errors arrive as HTTP 400 with a JSON body, so this reads the
 * response itself instead of fetchText, which would throw the body away.
 */
export async function loadInstagramDiscovery(def, ctx) {
  const { now = Date.now(), fetchedAt = now } = ctx;
  const config = discoveryConfig();
  if (!config) return { status: 'skipped', error: null, records: [], note: null, snapshot: null };

  const fields = [
    'followers_count',
    'media_count',
    `media.limit(${INSTAGRAM_DISCOVERY.postsPerProfile}){${INSTAGRAM_DISCOVERY.fields.join(",")}}`,
  ].join(',');
  const target =
    `business_discovery.username(${encodeURIComponent(def.handle)}){${fields}}`;
  const url =
    `${INSTAGRAM_DISCOVERY.host}/${INSTAGRAM_DISCOVERY.version}/${encodeURIComponent(config.businessId)}` +
    `?fields=${encodeURIComponent(target)}&access_token=${encodeURIComponent(config.token)}`;

  const snapshot = {
    handle: def.handle,
    url: def.url,
    username: null,
    fullName: null,
    followers: null,
    biography: null,
    via: 'Meta app (business_discovery)',
    posts: [],
  };

  let payload = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(INGEST.instagramTimeoutMs) });
    payload = JSON.parse(await response.text());
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'timed out' : 'request failed';
    return { status: 'unavailable', error: `Graph API ${reason}.`, records: [], note: null, snapshot };
  }

  const profile = parseDiscoveryMedia(payload);
  snapshot.username = profile.username;
  snapshot.followers = profile.followers;

  if (profile.error) {
    const detail =
      profile.error === 'token_rejected'
        ? 'The Meta access token was rejected (expired or revoked).'
        : profile.error === 'not_discoverable'
          ? 'Instagram has no public Business or Creator account for this handle.'
          : `Graph API refused the lookup${profile.message ? `: ${truncate(profile.message, 120)}` : ''}.`;
    return { status: 'unavailable', error: detail, records: [], note: `business_discovery: ${profile.error}`, snapshot };
  }

  const records = [];
  for (const post of profile.posts) {
    if (records.length >= INSTAGRAM_DISCOVERY.postsPerProfile) break;
    if (now - post.publishedAt > DECAY.social.maxAgeHours * 3_600_000) continue;

    const caption = post.caption ? truncate(post.caption, INGEST.maxSummaryLength) : null;
    snapshot.posts.push({
      shortcode: post.permalink.split('/p/')[1]?.replace(/\/$/, '') ?? null,
      caption,
      publishedAt: post.publishedAt,
      likes: post.likes,
      comments: post.comments,
      isVideo: post.isVideo,
      dateBasis: 'exact',
    });

    records.push({
      sourceId: def.id,
      kind: 'social',
      publisher: def.label,
      publisherUrl: httpsUrl(def.homepage),
      title: truncate(post.caption || `Instagram post by @${def.handle}`, INGEST.maxTitleLength),
      summary: null,
      url: post.permalink,
      publishedAt: post.publishedAt,
      fetchedAt,
      engagement: post.likes,
      engagementLabel: post.likes === null ? null : 'likes',
      replies: post.comments,
      channel: `@${def.handle}`,
      dateBasis: 'exact',
    });
  }

  if (records.length === 0) {
    return { status: 'empty', error: null, records: [], note: 'No posts inside the retention window.', snapshot };
  }

  return { status: 'live', error: null, records, note: 'Exact via the Graph API.', snapshot };
}
export async function loadInstagramSession(def, ctx) {
  const { now = Date.now(), fetchedAt = now } = ctx;
  const session = sessionConfig();
  if (!session) return { status: 'skipped', error: null, records: [], note: null, snapshot: null };

  const snapshot = {
    handle: def.handle,
    url: def.url,
    username: null,
    fullName: null,
    followers: null,
    biography: null,
    via: 'session cookie',
    posts: [],
  };

  let payload = null;
  try {
    const response = await fetchText(
      `${INSTAGRAM_SESSION.profileUrl}?username=${encodeURIComponent(def.handle)}`,
      {
        relay: null,
        headers: {
          ...INSTAGRAM_SESSION.headers,
          'user-agent': INSTAGRAM_SESSION.userAgent,
          'x-ig-app-id': INSTAGRAM_SESSION.appId,
          'x-requested-with': 'XMLHttpRequest',
          referer: `${BASE}/${def.handle}/`,
          cookie: session.cookie,
        },
        accept: 'application/json',
        timeoutMs: INGEST.instagramTimeoutMs,
      },
    );
    payload = JSON.parse(response.body);
  } catch (error) {
    const reason = error?.status ? `HTTP ${error.status}` : 'network failure';
    return {
      status: 'unavailable',
      error: `Session request failed (${reason}).`,
      records: [],
      note: null,
      snapshot,
    };
  }

  const profile = parseWebProfile(payload);
  snapshot.username = profile.username;
  snapshot.fullName = profile.fullName;
  snapshot.followers = profile.followers;
  snapshot.biography = profile.biography;

  if (profile.error) {
    const detail =
      profile.error === 'checkpoint_required'
        ? 'Instagram wants a challenge solved for this session.'
        : 'Instagram rejected the stored session.';
    return { status: 'unavailable', error: detail, records: [], note: `web_profile_info: ${profile.error}`, snapshot };
  }

  const records = [];
  for (const post of profile.posts.slice(0, INSTAGRAM_SESSION.postsPerProfile)) {
    const url = httpsUrl(`${BASE}/p/${post.shortcode}/`);
    if (!url || !Number.isFinite(post.publishedAt)) continue;
    if (now - post.publishedAt > DECAY.social.maxAgeHours * 3_600_000) continue;

    const caption = post.caption ? truncate(post.caption, INGEST.maxSummaryLength) : null;
    snapshot.posts.push({
      shortcode: post.shortcode,
      caption,
      publishedAt: post.publishedAt,
      likes: post.likes,
      comments: post.comments,
      isVideo: post.isVideo,
      dateBasis: 'exact',
    });

    records.push({
      sourceId: def.id,
      kind: 'social',
      publisher: def.label,
      publisherUrl: httpsUrl(def.homepage),
      title: truncate(post.caption || `Instagram post by @${def.handle}`, INGEST.maxTitleLength),
      summary: null,
      url,
      publishedAt: post.publishedAt,
      fetchedAt,
      engagement: post.likes,
      engagementLabel: post.likes === null ? null : 'likes',
      replies: post.comments,
      channel: `@${def.handle}`,
      dateBasis: 'exact',
    });
  }

  if (records.length === 0) {
    return { status: 'empty', error: null, records: [], note: 'No posts inside the retention window.', snapshot };
  }

  return { status: 'live', error: null, records, note: 'Exact via stored session.', snapshot };
}

export async function loadInstagramSource(def, ctx) {
  const { relay = null, now = Date.now(), fetchedAt = now } = ctx;
  const headers = { 'user-agent': INSTAGRAM_CRAWLER_UA };
  // The relay forwards a fixed header set, so a cookie only travels direct.
  const jar = sessionConfig();
  if (jar && !relay) headers.cookie = jar.cookie;

  // A stored session gives exact timestamps in one request.
  // The Graph API is the steadiest route, so it goes first when a token exists.
  const discovery = await loadInstagramDiscovery(def, ctx);
  if (discovery.status === 'live') return discovery;
  const discoveryNote = discovery.status === 'unavailable' ? discovery.error : null;

  const session = await loadInstagramSession(def, ctx);
  if (session.status === 'live') return session;
  const sessionNote = session.status === 'unavailable' ? session.error : null;
  const firstFailure = discoveryNote || sessionNote;

  let page = null;
  let pageError = null;
  try {
    page = await fetchText(def.url, {
      relay,
      headers,
      accept: 'text/html,application/xhtml+xml',
      timeoutMs: INGEST.instagramTimeoutMs,
    });
  } catch (error) {
    pageError = error;
  }

  if (!page) {
    const fallback = await loadInstagramFallback(def, ctx);
    if (fallback.records.length > 0) return fallback;
    throw pageError;
  }

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
    via: 'profile page',
    posts: [],
  };

  if (profile.posts.length === 0) {
    // The host is refused a rendered profile (the runner case): try the coarse route.
    const fallback = await loadInstagramFallback(def, ctx);
    // Keep a specific fallback failure visible instead of flattening it to "login shell".
    if (fallback.records.length > 0 || fallback.status === 'unavailable') {
      return { ...fallback, snapshot: fallback.snapshot ?? snapshot };
    }
    return {
      status: 'malformed',
      error: firstFailure || 'No posts found in the profile page.',
      records: [],
      note: 'Instagram served the login shell, and the coarse fallback found nothing.',
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
      dateBasis: 'exact',
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
      dateBasis: 'exact',
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
