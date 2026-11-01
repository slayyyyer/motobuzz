import { readFileSync, writeFileSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8');
const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/* ---------------- src/config.js (CRLF) ---------------- */
const cfgPath = 'src/config.js';
let cfg = read(cfgPath);
const cEol = eolOf(cfg);
const cfgAnchor = [`  postsPerProfile: 4,`, '});', ''].join(cEol);
must(cfg.split(cfgAnchor).length === 2, 'config discovery anchor');
const discoveryBlock = [
  '  postsPerProfile: 4,',
  '});',
  '',
  '/**',
  " * The Meta app route: one Graph API call per handle through `business_discovery`.",
  ' * It is the only route that is neither scraped nor tied to an IP, but it needs an',
  ' * access token belonging to an Instagram Business or Creator account that holds a',
  ' * role on the app, plus that account\'s own IG user id. See the README for setup.',
  ' */',
  'export const INSTAGRAM_DISCOVERY = Object.freeze({',
  "  host: 'https://graph.facebook.com',",
  "  version: 'v26.0',",
  '  /**',
  '   * Newest posts kept per profile. Deliberately low: Business Discovery sits on',
  '   * Platform rate limits, roughly 200 calls an hour per app at one app user.',
  '   */',
  '  postsPerProfile: 4,',
  '  /** Public fields the IG Media node exposes through field expansion. */',
  '  fields: Object.freeze([',
  "    'timestamp',",
  "    'like_count',",
  "    'comments_count',",
  "    'permalink',",
  "    'media_type',",
  "    'caption',",
  '  ]),',
  '  /** Graph error codes: 190 is a dead token, 110/2207013 a handle it cannot see. */',
  '  errorCodes: Object.freeze({ tokenRejected: 190, notDiscoverable: 110, notFoundSubcode: 2207013 }),',
  '});',
  '',
].join(cEol);
cfg = cfg.replace(cfgAnchor, discoveryBlock);
writeFileSync(cfgPath, cfg);

/* ---------------- src/adapters/instagram.js (LF) ---------------- */
const igPath = 'src/adapters/instagram.js';
let ig = read(igPath);

// 1. import the new block.
const oldImport = [
  'import {',
  '  DECAY,',
  '  INGEST,',
  '  INSTAGRAM_CRAWLER_UA,',
  '  INSTAGRAM_FALLBACK,',
  '  INSTAGRAM_PROFILES,',
  '  INSTAGRAM_SESSION,',
  "} from '../config.js';",
].join('\n');
const newImport = [
  'import {',
  '  DECAY,',
  '  INGEST,',
  '  INSTAGRAM_CRAWLER_UA,',
  '  INSTAGRAM_DISCOVERY,',
  '  INSTAGRAM_FALLBACK,',
  '  INSTAGRAM_PROFILES,',
  '  INSTAGRAM_SESSION,',
  "} from '../config.js';",
].join('\n');
must(ig.includes(oldImport), 'instagram import');
ig = ig.replace(oldImport, newImport);

// 2. Rewrite the route docstring so the order it describes is the real one.
const docStart = ig.indexOf(' * Three routes, in order:');
const docEnd = ig.indexOf(' * Every failure is reported');
must(docStart > 0 && docEnd > docStart, 'docstring markers');
const newDoc = [
  ' * Four routes, in order:',
  ' *',
  ' * 0. A Meta app reading `business_discovery`. The Graph API returns exact',
  ' *    timestamps, likes and comments for any public Business or Creator account',
  ' *    in one call per handle, with no scraping, no cookie and no IP reputation to',
  ' *    manage, so it wins whenever a token is configured — see INSTAGRAM_DISCOVERY.',
  ' *',
  ' * 1. A stored session cookie. Instagram\'s own web app reads profiles through',
  ' *    `web_profile_info`, which returns exact timestamps and engagement for a',
  ' *    signed-in session in one request. The cookie is never obtained here — see',
  ' *    INSTAGRAM_SESSION.',
  ' *',
  ' * 2. The profile page. Instagram serves a browser a login shell, but a crawler',
  ' *    user agent gets the rendered page with a timeline blob, and each post\'s own',
  ' *    page carries an exact publish time plus its like and comment counts. It',
  ' *    needs no third party, though the signed-out page is not always current.',
  ' *',
  ' * 3. A fallback for hosts Instagram refuses (GitHub\'s runners are answered with',
  ' *    429 whatever the user agent). DuckDuckGo finds recent post permalinks, and',
  ' *    the microlink metadata API reads one post from its own infrastructure. That',
  ' *    route is coarse: microlink reports the publish DAY, not the hour, so its',
  ' *    records are stamped at midday UTC and marked `dateBasis: \'day\'` rather than',
  ' *    being passed off as exact.',
  ' *',
].join('\n');
ig = ig.slice(0, docStart) + newDoc + ig.slice(docEnd);

// 3. Discovery helpers, inserted before sessionConfig's docstring.
const sessionDocStart = ig.indexOf('/**\n * Read the stored cookie,');
must(sessionDocStart > 0, 'session docstring');
const discoveryCode = [
  '/**',
  ' * The token and the app owner\'s own IG user id. Discovery is performed *as* that',
  ' * account, so both are required; with either missing the route is skipped.',
  ' */',
  'export function discoveryConfig(env = process.env) {',
  "  const token = String(env.INSTAGRAM_TOKEN || '').trim();",
  "  const businessId = String(env.INSTAGRAM_BUSINESS_ID || '').trim();",
  '  if (!token || !businessId) return null;',
  '  return { token, businessId };',
  '}',
  '',
  '/**',
  ' * Read a `business_discovery` response. Graph reports every refusal as an error',
  ' * object rather than an HTTP status, so the code decides the message: a dead',
  ' * token, a handle it cannot see (personal, private, age-gated, or simply wrong —',
  ' * Instagram does not say which), or anything else.',
  ' */',
  'export function parseDiscoveryMedia(payload) {',
  '  const failure = payload?.error;',
  '  if (failure) {',
  '    const code = Number(failure.code);',
  '    const subcode = Number(failure.error_subcode);',
  '    const kind =',
  '      code === INSTAGRAM_DISCOVERY.errorCodes.tokenRejected',
  "        ? 'token_rejected'",
  '        : code === INSTAGRAM_DISCOVERY.errorCodes.notDiscoverable ||',
  '            subcode === INSTAGRAM_DISCOVERY.errorCodes.notFoundSubcode',
  "          ? 'not_discoverable'",
  "          : 'unknown';",
  '    return {',
  '      error: kind,',
  '      message: failure.error_user_msg || failure.message || null,',
  '      username: null,',
  '      followers: null,',
  '      posts: [],',
  '    };',
  '  }',
  '',
  '  const found = payload?.business_discovery;',
  '  if (!found) return { error: \'no_profile\', message: null, username: null, followers: null, posts: [] };',
  '',
  '  const posts = [];',
  '  for (const item of found.media?.data ?? []) {',
  '    const permalink = httpsUrl(item.permalink);',
  '    const publishedAt = Date.parse(item.timestamp);',
  '    if (!permalink || !Number.isFinite(publishedAt)) continue;',
  '    posts.push({',
  '      permalink,',
  "      caption: typeof item.caption === 'string' ? item.caption : null,",
  "      isVideo: item.media_type === 'VIDEO',",
  '      publishedAt,',
  '      likes: Number.isFinite(item.like_count) ? item.like_count : null,',
  '      comments: Number.isFinite(item.comments_count) ? item.comments_count : null,',
  '    });',
  '  }',
  '  posts.sort((left, right) => right.publishedAt - left.publishedAt);',
  '',
  '  return {',
  '    error: null,',
  '    message: null,',
  "    username: typeof found.username === 'string' ? found.username : null,",
  '    followers: Number.isFinite(found.followers_count) ? found.followers_count : null,',
  '    posts,',
  '  };',
  '}',
  '',
].join('\n');
ig = ig.slice(0, sessionDocStart) + discoveryCode + ig.slice(sessionDocStart);

// 4. The route itself, before loadInstagramSession.
const loaderStart = ig.indexOf('/**\n * The authenticated route. Requested directly, not through the relay: the relay');
must(loaderStart > 0, 'session loader docstring');
const loaderCode = [
  '/**',
  ' * One Graph API call per handle, made directly: the token must not transit the',
  ' * relay either. Errors come back with HTTP 400 and a JSON body, so the response',
  ' * is read without fetchText, which would throw the body away.',
  ' */',
  'export async function loadInstagramDiscovery(def, ctx) {',
  '  const { now = Date.now(), fetchedAt = now } = ctx;',
  '  const config = discoveryConfig();',
  "  if (!config) return { status: 'skipped', error: null, records: [], note: null, snapshot: null };",
  '',
  '  const fields = [',
  "    'followers_count',",
  "    'media_count',",
  '    `media.limit(${INSTAGRAM_DISCOVERY.postsPerProfile}){${INSTAGRAM_DISCOVERY.fields.join(\',\')}}`,',
  '  ].join(\',\');',
  '  const target = [',
  "    'business_discovery.username(',",
  '    encodeURIComponent(def.handle),',
  "    '){',",
  '    fields,',
  "    '}',",
  "  ].join('');",
  '  const url =',
  '    `${INSTAGRAM_DISCOVERY.host}/${INSTAGRAM_DISCOVERY.version}/${encodeURIComponent(config.businessId)}` +',
  '    `?fields=${encodeURIComponent(target)}&access_token=${encodeURIComponent(config.token)}`;',
  '',
  '  const snapshot = {',
  '    handle: def.handle,',
  '    url: def.url,',
  '    username: null,',
  '    fullName: null,',
  '    followers: null,',
  '    biography: null,',
  "    via: 'Meta app (business_discovery)',",
  '    posts: [],',
  '  };',
  '',
  '  let payload = null;',
  '  try {',
  '    const response = await fetch(url, { signal: AbortSignal.timeout(INGEST.instagramTimeoutMs) });',
  '    payload = JSON.parse(await response.text());',
  '  } catch (error) {',
  "    const reason = error?.name === 'TimeoutError' ? 'timed out' : 'request failed';",
  '    return { status: \'unavailable\', error: `Graph API ${reason}.`, records: [], note: null, snapshot };',
  '  }',
  '',
  '  const profile = parseDiscoveryMedia(payload);',
  '  snapshot.username = profile.username;',
  '  snapshot.followers = profile.followers;',
  '',
  '  if (profile.error) {',
  '    const detail =',
  "      profile.error === 'token_rejected'",
  "        ? 'The Meta access token was rejected (expired or revoked).'",
  "        : profile.error === 'not_discoverable'",
  "          ? 'Instagram has no public Business or Creator account for this handle.'",
  "          : `Graph API refused the lookup${profile.message ? `: ${truncate(profile.message, 120)}` : ''}.`;",
  '    return { status: \'unavailable\', error: detail, records: [], note: `business_discovery: ${profile.error}`, snapshot };',
  '  }',
  '',
  '  const records = [];',
  '  for (const post of profile.posts) {',
  '    if (records.length >= INSTAGRAM_DISCOVERY.postsPerProfile) break;',
  '    if (now - post.publishedAt > DECAY.social.maxAgeHours * 3_600_000) continue;',
  '',
  '    const caption = post.caption ? truncate(post.caption, INGEST.maxSummaryLength) : null;',
  '    snapshot.posts.push({',
  '      shortcode: post.permalink.split(\'/p/\')[1]?.replace(/\\/$/, \'\') ?? null,',
  '      caption,',
  '      publishedAt: post.publishedAt,',
  '      likes: post.likes,',
  '      comments: post.comments,',
  '      isVideo: post.isVideo,',
  "      dateBasis: 'exact',",
  '    });',
  '',
  '    records.push({',
  '      sourceId: def.id,',
  "      kind: 'social',",
  '      publisher: def.label,',
  '      publisherUrl: httpsUrl(def.homepage),',
  '      title: truncate(post.caption || `Instagram post by @${def.handle}`, INGEST.maxTitleLength),',
  '      summary: null,',
  '      url: post.permalink,',
  '      publishedAt: post.publishedAt,',
  '      fetchedAt,',
  '      engagement: post.likes,',
  "      engagementLabel: post.likes === null ? null : 'likes',",
  '      replies: post.comments,',
  '      channel: `@${def.handle}`,',
  "      dateBasis: 'exact',",
  '    });',
  '  }',
  '',
  '  if (records.length === 0) {',
  "    return { status: 'empty', error: null, records: [], note: 'No posts inside the retention window.', snapshot };",
  '  }',
  '',
  "  return { status: 'live', error: null, records, note: 'Exact via the Graph API.', snapshot };",
  '}',
  '',
].join('\n');
ig = ig.slice(0, loaderStart) + loaderCode + ig.slice(loaderStart);

// 5. Call it first in loadInstagramSource, and surface its reason at the end.
const oldOrder = [
  '  // A stored session gives exact timestamps in one request, so it goes first.',
  '  const session = await loadInstagramSession(def, ctx);',
  "  if (session.status === 'live') return session;",
];
const newOrder = [
  '  // The Graph API is the steadiest route, so it goes first when a token exists.',
  '  const discovery = await loadInstagramDiscovery(def, ctx);',
  "  if (discovery.status === 'live') return discovery;",
  "  const discoveryNote = discovery.status === 'unavailable' ? discovery.error : null;",
  '',
  '  // A stored session gives exact timestamps in one request.',
  '  const session = await loadInstagramSession(def, ctx);',
  "  if (session.status === 'live') return session;",
].join('\n');
must(ig.includes(oldOrder), 'source ordering');
ig = ig.replace(oldOrder, newOrder);

must(ig.includes("      error: sessionNote || 'No posts found in the profile page.',"), 'error chain');
ig = ig.replace(
  "      error: sessionNote || 'No posts found in the profile page.',",
  "      error: discoveryNote || sessionNote || 'No posts found in the profile page.',",
);
writeFileSync(igPath, ig);

/* ---------------- .github/workflows/pages.yml ---------------- */
const wPath = '.github/workflows/pages.yml';
let w = read(wPath);
const wEol = eolOf(w);
const wLines = w.split(wEol);
const at = wLines.findIndex((line) => line.includes('INSTAGRAM_SESSIONID'));
must(at > -1, 'workflow session env');
if (!wLines.some((line) => line.includes('INSTAGRAM_TOKEN'))) {
  const indent = wLines[at].match(/^\s*/)[0];
  wLines.splice(
    at + 1,
    0,
    `${indent}INSTAGRAM_TOKEN: \${{ secrets.INSTAGRAM_TOKEN }}`,
    `${indent}INSTAGRAM_BUSINESS_ID: \${{ secrets.INSTAGRAM_BUSINESS_ID }}`,
  );
  writeFileSync(wPath, wLines.join(wEol));
}

/* ---------------- tests/run.js (CRLF) ---------------- */
const tPath = 'tests/run.js';
let t = read(tPath);
const tEol = eolOf(t);

const importAnchor = '  parseWebProfile,';
must(t.split(importAnchor).length === 2, 'test import anchor');
t = t.replace(importAnchor, '  parseDiscoveryMedia,\n  parseWebProfile,'.split('\n').join(tEol));

const testAnchor = "test('reads a post page for its publish time and engagement', () => {";
must(t.split(testAnchor).length === 2, 'discovery test anchor');
const newTests = [
  'const DISCOVERY_PAYLOAD = {',
  '  business_discovery: {',
  "    username: 'kenroczen94',",
  '    followers_count: 1_738_601,',
  '    media: {',
  '      data: [',
  '        {',
  "          timestamp: '2026-10-31T18:04:13+0000',",
  '          like_count: 12_400,',
  '          comments_count: 87,',
  "          permalink: 'https://www.instagram.com/p/DfJu1kasgcb/',",
  "          media_type: 'VIDEO',",
  "          caption: 'Auckland',",
  '        },',
  '        {',
  "          timestamp: '2026-10-30T09:12:00+0000',",
  '          like_count: 9_100,',
  '          comments_count: 31,',
  "          permalink: 'https://www.instagram.com/p/DfES0kasgbd/',",
  "          media_type: 'IMAGE',",
  '        },',
  '      ],',
  '    },',
  '  },',
  '};',
  '',
  "test('reads business_discovery media, newest first, with exact timestamps', () => {",
  '  const profile = parseDiscoveryMedia(DISCOVERY_PAYLOAD);',
  '  assert.equal(profile.error, null);',
  "  assert.equal(profile.username, 'kenroczen94');",
  '  assert.equal(profile.followers, 1_738_601);',
  '  assert.equal(profile.posts.length, 2);',
  '  assert.equal(profile.posts[0].publishedAt, Date.parse(\'2026-10-31T18:04:13Z\'));',
  '  assert.equal(profile.posts[0].likes, 12_400);',
  '  assert.equal(profile.posts[0].isVideo, true);',
  '  // Business Discovery omits captions for some media, so a missing one is normal.',
  '  assert.equal(profile.posts[1].caption, null);',
  '});',
  '',
  "test('a personal or missing handle is reported, not treated as empty', () => {",
  '  const personal = parseDiscoveryMedia({',
  "    error: { message: 'Invalid user id', code: 110, error_subcode: 2207013 },",
  '  });',
  "  assert.equal(personal.error, 'not_discoverable');",
  '  const expired = parseDiscoveryMedia({ error: { message: \'Error validating access token\', code: 190 } });',
  "  assert.equal(expired.error, 'token_rejected');",
  '});',
  '',
  "test('requires both a token and the app owner's IG user id', () => {",
  '  assert.equal(discoveryConfig({}), null);',
  "  assert.equal(discoveryConfig({ INSTAGRAM_TOKEN: 'tok' }), null);",
  "  assert.equal(discoveryConfig({ INSTAGRAM_BUSINESS_ID: '123' }), null);",
  "  assert.equal(discoveryConfig({ INSTAGRAM_TOKEN: 'tok', INSTAGRAM_BUSINESS_ID: '123' }).businessId, '123');",
  '});',
  '',
].join(tEol);
t = t.replace(testAnchor, newTests + testAnchor);

const cfgImportAnchor = "  sessionConfig,";
must(t.split(cfgImportAnchor).length === 2, 'sessionConfig import anchor');
t = t.replace(cfgImportAnchor, `  discoveryConfig,${tEol}  sessionConfig,`);
writeFileSync(tPath, t);

/* ---------------- README.md (CRLF) ---------------- */
const rPath = 'README.md';
let r = read(rPath);
const rEol = eolOf(r);
const insertAt = '**X is not scraped.**';
must(r.includes(insertAt), 'README X anchor');
const metaBlock = [
  '**A Meta app is the steady route, when you are willing to register one.** With an app, an Instagram Business or',
  'Creator account holding a role on it, and that account linked to a Facebook Page, the Graph API endpoint',
  "`business_discovery` returns another public professional account's newest media in one call — exact `timestamp`,",
  '`like_count`, `comments_count` and `permalink`, with no scraping, no cookie and nothing for Instagram to rate-limit',
  'by IP. Store the access token as `INSTAGRAM_TOKEN` and that account\'s own IG user id as `INSTAGRAM_BUSINESS_ID`;',
  'with either missing the route is skipped. Three limits are real: only Business or Creator targets are readable, so a',
  'personal rider account answers `not_discoverable` and the source says so instead of pretending it is empty; captions',
  'are sometimes omitted by that endpoint, in which case the post is titled from its handle; and a long-lived token',
  'expires after about 60 days and cannot be refreshed once dead, so it needs rotating in the secret by hand. The same',
  'Standard-access token works without App Review as long as the account it belongs to holds a role on the app.',
  '',
].join(rEol);
r = r.replace(insertAt, metaBlock + insertAt);
writeFileSync(rPath, r);

console.log('meta app route applied');
