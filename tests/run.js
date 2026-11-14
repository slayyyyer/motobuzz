/**
 * The test suite. Node's built-in assertions and this file's own runner; no
 * dependencies, no fixtures on disk. Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseFeed, parseDate } from '../src/adapters/feed.js';
import { extractChannelVideos, videosFromFeed } from '../src/adapters/youtube.js';
import { buildAtomFeed } from '../src/engine/feed.js';
import { saveDiagnostics } from '../src/engine/diagnostics.js';
import { applyDigest, generateDigest, parseDigest, parseDigestDetailed, planDigest } from '../src/engine/digest.js';
import { coverageNoteText } from '../src/app/render.js';
import { buildSourceRows, dedupeRecords, retainPrevious } from '../src/engine/pipeline.js';
import {
  applyEnrichment,
  enrichLabels,
  enrichmentConfig,
  isUnlabelled,
  parseEnrichment,
} from '../src/engine/enrich.js';
import { isJunkTitle } from '../src/adapters/news.js';
import { matchUpstream } from '../proxy/allowlist.js';
import { classify, isMotocrossOutlet } from '../src/engine/classify.js';
import { inspectRecord } from '../src/engine/audit.js';
import {
  buildSnapshot,
  engagementFactor,
  isEligible,
  recencyFactor,
  stableId,
  urlKey,
} from '../src/engine/score.js';
import { validateCache } from '../src/engine/validate.js';
import {
  decodeEntities,
  httpsUrl,
  normalizeForMatch,
  parseCount,
  parseRelativeTime,
  stripTags,
  titleKey,
  truncate,
} from '../src/lib/text.js';
import {
  BUZZ,
  DECAY,
  FEEDS,
  NEWS_QUERIES,
  RIDER_QUERY_GROUP_SIZE,
  RIDERS,
  WINDOW,
  YOUTUBE_CHANNELS,
} from '../src/config.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const NOW = Date.parse('2026-11-01T12:00:00Z');
const HOUR = 3_600_000;

/* ---------- text ---------- */

test('decodes named and numeric entities', () => {
  assert.equal(decodeEntities('Ken &amp; Jett&#39;s &#x2014; win'), "Ken & Jett's — win");
  assert.equal(decodeEntities('&unknown; stays'), '&unknown; stays');
});

test('strips tags and CDATA, collapses whitespace', () => {
  assert.equal(stripTags('<![CDATA[<p>Hello <b>world</b></p>]]>'), 'Hello world');
  assert.equal(stripTags('<div>a\n\n  b</div>'), 'a b');
});

test('normalizes diacritics and punctuation for matching', () => {
  assert.equal(normalizeForMatch('Simon Längenfelder'), 'simon langenfelder');
  assert.equal(normalizeForMatch('MXGP: Round 18!'), 'mxgp round 18');
});

test('title keys ignore case and punctuation', () => {
  assert.equal(titleKey('KTM SIGNS A Deal!'), titleKey('ktm signs a  deal'));
});

test('only https urls survive', () => {
  assert.equal(httpsUrl('http://example.com/a'), null);
  assert.equal(httpsUrl('javascript:alert(1)'), null);
  assert.equal(httpsUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(httpsUrl('not a url'), null);
});

test('truncate keeps the limit', () => {
  assert.equal(truncate('abcdef', 4).length, 4);
  assert.equal(truncate('abc', 10), 'abc');
});

test('parseCount reads compact and worded counts', () => {
  assert.equal(parseCount('25K'), 25_000);
  assert.equal(parseCount('1.2M views'), 1_200_000);
  assert.equal(parseCount('25 thousand views'), 25_000);
  assert.equal(parseCount('812 views'), 812);
  assert.equal(parseCount(''), null);
});

test('parseRelativeTime reads long and compact forms', () => {
  assert.equal(NOW - parseRelativeTime('2d ago', NOW), 2 * 24 * HOUR);
  assert.equal(NOW - parseRelativeTime('3 hours ago', NOW), 3 * HOUR);
  assert.equal(NOW - parseRelativeTime('Streamed 12m ago', NOW), 12 * 60_000);
  assert.equal(NOW - parseRelativeTime('1 week ago', NOW), 7 * 24 * HOUR);
  assert.equal(parseRelativeTime('yesterday', NOW), null);
});

/* ---------- feed parsing ---------- */

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Test</title>
<item><title><![CDATA[Ken Roczen signs with Suzuki]]></title>
<link>https://www.supercrosslive.com/2026/10/roczen-suzuki</link>
<pubDate>Fri, 30 Oct 2026 13:39:46 +0000</pubDate>
<description><![CDATA[<p>Two more years.</p>]]></description></item>
<item><title>Second story</title><link>https://example.com/two</link>
<dc:date>2026-10-31T08:00:00Z</dc:date></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Sub</title>
<entry><title>Top post</title><link rel="alternate" href="https://example.com/community/top_post" />
<updated>2026-10-31T09:00:00Z</updated><content type="html"><![CDATA[<p>Body text</p>]]></content></entry>
</feed>`;

test('parses RSS items with dates', () => {
  const parsed = parseFeed(RSS);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, 'rss');
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].title, 'Ken Roczen signs with Suzuki');
  assert.equal(parsed.items[0].publishedAt, Date.parse('2026-10-30T13:39:46Z'));
  assert.equal(parsed.items[1].publishedAt, Date.parse('2026-10-31T08:00:00Z'));
});

test('parses Atom entries and alternate links', () => {
  const parsed = parseFeed(ATOM);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, 'atom');
  assert.equal(parsed.items[0].link, 'https://example.com/community/top_post');
  assert.equal(parsed.items[0].summary, 'Body text');
});

test('an HTML error page is malformed, not empty', () => {
  const parsed = parseFeed('<html><body>404</body></html>');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /HTML/i);
});

test('an empty feed is empty, not malformed', () => {
  const parsed = parseFeed('<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.isEmpty, true);
});

test('unparseable dates come back null instead of now', () => {
  assert.equal(parseDate('sometime last week'), null);
  assert.equal(parseDate(''), null);
});

/* ---------- youtube ---------- */

const CHANNEL_HTML = `<html><body><script>var x = {"richItemRenderer":{"content":{"lockupViewModel":{
"contentImage":{"thumbnailViewModel":{"image":{"sources":[{"url":"https://i.ytimg.com/vi/VYr6C6OWNA0/hq.jpg"}]}}},
"contentId":"VYr6C6OWNA0","contentType":"LOCKUP_CONTENT_TYPE_VIDEO",
"metadata":{"lockupMetadataViewModel":{"title":{"content":"Testing the 2027 bike"},
"metadata":{"contentMetadataViewModel":{"metadataRows":[{"metadataParts":[
{"text":{"content":"25K"},"accessibilityLabel":"25 thousand views"},
{"text":{"content":"2d ago"},"accessibilityLabel":"2 days ago"}]}]}}}}}}}};</script></body></html>`;

test('extracts channel videos from the page JSON', () => {
  const videos = extractChannelVideos(CHANNEL_HTML, NOW);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].id, 'VYr6C6OWNA0');
  assert.equal(videos[0].title, 'Testing the 2027 bike');
  assert.equal(videos[0].views, 25_000);
  assert.equal(videos[0].publishedAt, NOW - 2 * 24 * HOUR);
});

test('a page with no entries yields nothing rather than throwing', () => {
  assert.deepEqual(extractChannelVideos('<html><body>nope</body></html>', NOW), []);
});

const YT_FEED = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
  xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
<entry><id>yt:video:B2VWf8m_YLk</id><yt:videoId>B2VWf8m_YLk</yt:videoId>
<title>Ranking Every 250SX Champion</title>
<link rel="alternate" href="https://www.youtube.com/watch?v=B2VWf8m_YLk"/>
<published>2026-11-11T16:00:14+00:00</published>
<media:group><media:community><media:statistics views="9363"/></media:community></media:group>
</entry></feed>`;

test('reads a channel feed with its publish times and view counts', () => {
  const videos = videosFromFeed(parseFeed(YT_FEED));
  assert.equal(videos.length, 1);
  assert.equal(videos[0].id, 'B2VWf8m_YLk');
  assert.equal(videos[0].views, 9363);
  assert.equal(videos[0].publishedAt, Date.parse('2026-11-11T16:00:14Z'));
});

/* ---------- optional LLM enrichment ---------- */

test('enrichment stays off without a key and refuses non-loopback http', () => {
  assert.equal(enrichmentConfig({}), null);
  assert.equal(enrichmentConfig({ LLM_API_KEY: 'k', LLM_API_BASE: 'http://api.example.com/v4' }), null);
  assert.equal(enrichmentConfig({ LLM_API_KEY: 'k', LLM_API_BASE: 'not a url' }), null);
  const https = enrichmentConfig({ LLM_API_KEY: 'k' });
  assert.equal(https.model, 'glm-4.5-flash');
  assert.ok(https.base.startsWith('https://'));
  assert.equal(enrichmentConfig({ ZAI_API_KEY: 'k' }).model, 'glm-4.5-flash');
  assert.equal(enrichmentConfig({ NEWS_MODEL_API_KEY: 'k' }).model, 'glm-4.5-flash');
  assert.equal(enrichmentConfig({ LLM_API_KEY: 'k', LLM_MODEL: 'other' }).model, 'other');
  const local = enrichmentConfig({ LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:8799' });
  assert.equal(local.base, 'http://127.0.0.1:8799');
});

test('parses fenced JSON and rejects rubbish', () => {
  assert.equal(parseEnrichment('```json\n{"results":[{"id":"a"}]}\n```').length, 1);
  assert.equal(parseEnrichment('[{"id":"b"}]').length, 1);
  assert.deepEqual(parseEnrichment('not json at all'), []);
});

test('only ids that exist in config survive, and labelled records stay untouched', () => {
  const records = [
    { id: 'bare', title: 'Week 1', topics: [], entities: [] },
    { id: 'sorted', title: 'KTM signs a rider', topics: ['signings'], entities: [] },
  ];
  const labelled = applyEnrichment(records, [
    { id: 'bare', topics: ['signings', 'invented-topic'], entities: ['ken-roczen', 'invented-rider'] },
    { id: 'sorted', topics: ['injury'], entities: ['ken-roczen'] },
  ]);
  assert.equal(labelled, 1);
  assert.deepEqual(records[0].topics, ['signings']);
  assert.deepEqual(records[0].entities, ['ken-roczen']);
  assert.deepEqual(records[1].topics, ['signings']);
});

test('a failing provider leaves keyword labels exactly as they were', async () => {
  const records = [{ id: 'bare', title: 'Week 1', topics: [], entities: [] }];
  const failing = async () => ({ ok: false, status: 500 });
  const report = await enrichLabels(records, { env: { LLM_API_KEY: 'k' }, fetchImpl: failing });
  assert.equal(report.labelled, 0);
  assert.match(report.error, /500/);
  assert.deepEqual(records[0].topics, []);

  const broken = async () => {
    throw new Error('network down');
  };
  const second = await enrichLabels(records, { env: { LLM_API_KEY: 'k' }, fetchImpl: broken });
  assert.equal(second.labelled, 0);
  assert.equal(second.error, 'Request failed.');
});

test('a good reply labels bare records and nothing else', async () => {
  const records = [
    { id: 'bare', title: 'Week 1', topics: [], entities: [] },
    { id: 'sorted', title: 'Team announcement', topics: ['signings'], entities: ['ktm'] },
  ];
  const fake = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({ results: [{ id: 'bare', topics: ['signings'], entities: ['ken-roczen'] }] }),
          },
        },
      ],
    }),
  });
  const report = await enrichLabels(records, { env: { LLM_API_KEY: 'k' }, fetchImpl: fake });
  assert.equal(report.requested, 1);
  assert.equal(isUnlabelled(records[0]), false);
  assert.deepEqual(records[0].topics, ['signings']);
  assert.deepEqual(records[1].entities, ['ktm']);
});

test('a throttled request is retried once, with Z.ai thinking switched off', async () => {
  const records = [{ id: 'bare', title: 'Week 1', topics: [], entities: [] }];
  const bodies = [];
  let calls = 0;
  const flaky = async (url, options) => {
    calls += 1;
    bodies.push(JSON.parse(options.body));
    if (calls === 1) return { ok: false, status: 429 };
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ results: [{ id: 'bare', topics: ['signings'], entities: [] }] }),
            },
          },
        ],
      }),
    };
  };
  const report = await enrichLabels(records, {
    env: { LLM_API_KEY: 'k' },
    fetchImpl: flaky,
    retryDelayMs: 1,
  });
  assert.equal(calls, 2);
  assert.equal(report.labelled, 1);
  assert.equal(report.error, null);
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  assert.equal(bodies[0].model, 'glm-4.5-flash');
  assert.equal(bodies[0].temperature, 0);
});

/* ---------- optional digest ---------- */

test('a digest keeps only claims that cite records from the build', () => {
  const records = [{ id: 'a' }, { id: 'b' }];
  const claims = applyDigest(
    [
      { text: 'Ken Roczen has extended with Suzuki for another season.', recordIds: ['a'] },
      { text: 'A claim that cites a record that is not in the build.', recordIds: ['ghost'] },
      { text: 'Another claim, citing two records that exist here.', recordIds: ['a', 'b', 'a'] },
      { text: 'Short.', recordIds: ['a'] },
    ],
    records,
  );
  assert.equal(claims.length, 2);
  assert.deepEqual(claims[0].recordIds, ['a']);
  assert.deepEqual(claims[1].recordIds, ['a', 'b']);
});

test('digest JSON is read from an envelope, a code fence, or a short lead-in', () => {
  const envelope = parseDigest('{"claims":[{"text":"A claim here.","recordIds":["a"]}]}');
  assert.equal(envelope.length, 1);
  const fenced = parseDigest('```json\n[{"text":"A claim here.","recordIds":["a"]}]\n```');
  assert.equal(fenced.length, 1);
  const prefixed = parseDigest('Here is the JSON:\n{"claims":[{"text":"A claim here.","recordIds":["a"]}]}');
  assert.equal(prefixed.length, 1);
  const broken = parseDigestDetailed('not json at all');
  assert.deepEqual(broken.claims, []);
  assert.match(broken.reason, /neither JSON nor cited lines/i);
});

test('records covering one story are grouped and ranked by combined weight', () => {
  const plan = planDigest([
    { id: 's1', title: 'Jalek Swoll joins Phoenix Racing Honda for 2027', weight: 0.2, entities: ['jalek-swoll'] },
    { id: 's2', title: 'Phoenix Racing Honda deal marks new chapter for Swoll', weight: 0.2, entities: ['jalek-swoll'] },
    { id: 's3', title: 'Jalek Swoll on being back and joining Phoenix Honda', weight: 0.1, entities: ['jalek-swoll'] },
    { id: 'h1', title: 'Seth Hammaker targets the 2027 250SX championship', weight: 0.5 },
    { id: 'p1', title: 'Entry list: 2026 Paris Supercross', weight: 0.1 },
    { id: 'p2', title: 'Entry list 2026 Supercross of Tallin - Estonia', weight: 0.1 },
    { id: 'x1', title: 'Video: Perth AusX Supercross press day', weight: 0.1 },
  ]);
  assert.equal(plan.storyOf.get('s1'), plan.storyOf.get('s2'));
  assert.equal(plan.storyOf.get('s2'), plan.storyOf.get('s3'));
  assert.notEqual(plan.storyOf.get('s1'), plan.storyOf.get('h1'));
  assert.notEqual(plan.storyOf.get('p1'), plan.storyOf.get('p2'));
  assert.notEqual(plan.storyOf.get('p1'), plan.storyOf.get('x1'));
  assert.equal(plan.storyOf.get('s1'), 1);
  assert.equal(plan.items.find((item) => item.id === 's1').coverage, 3);
  assert.equal(plan.stories, 5);
});

test('digest claims follow story order, cite one story, and keep one per story', () => {
  const records = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const storyOf = new Map([
    ['a', 1],
    ['b', 1],
    ['c', 2],
  ]);
  const storyOrder = new Map([
    [1, 0],
    [2, 1],
  ]);
  const claims = applyDigest(
    [
      { text: 'The second story comes second in the digest.', recordIds: ['c'] },
      { text: 'The first story comes first in the digest.', recordIds: ['a'] },
      { text: 'A second claim about the first story is dropped.', recordIds: ['b'] },
    ],
    records,
    storyOf,
    storyOrder,
  );
  assert.equal(claims.length, 2);
  assert.deepEqual(claims[0].recordIds, ['a']);
  assert.deepEqual(claims[1].recordIds, ['c']);

  const trimmed = applyDigest([{ text: 'A claim that mixes two different stories.', recordIds: ['a', 'b', 'c'] }], records, storyOf, storyOrder);
  assert.deepEqual(trimmed[0].recordIds, ['a', 'b']);
});

test('a digest is read from claim lines when the provider ignores JSON mode', () => {
  const parsed = parseDigestDetailed('Ken Roczen has extended with Suzuki. || a, b\nAnother headline, in plain words. || c');
  assert.equal(parsed.claims.length, 2);
  assert.deepEqual(parsed.claims[0].recordIds, ['a', 'b']);
  assert.equal(parsed.reason, null);
  const bullets = parseDigestDetailed('- A claim with a bullet. || a\n2. A numbered claim. || b');
  assert.deepEqual(bullets.claims.map((claim) => claim.text), ['A claim with a bullet.', 'A numbered claim.']);
});

test('a digest accepts the record_ids spelling and a single cited id', () => {
  const records = [{ id: 'a' }, { id: 'b' }];
  const claims = applyDigest(
    [
      { text: 'One claim citing the alternate field name.', record_ids: ['a'] },
      { text: 'Another claim citing a single bare id.', recordIds: 'b' },
    ],
    records,
  );
  assert.equal(claims.length, 2);
  assert.deepEqual(claims[0].recordIds, ['a']);
  assert.deepEqual(claims[1].recordIds, ['b']);
});

test('no key means no digest, and a failing call leaves the score alone', async () => {
  const records = [{ id: 'a', title: 'Ken Roczen extends with Suzuki', topics: [], entities: [] }];
  const off = await generateDigest(records, { env: {} });
  assert.equal(off.configured, false);
  assert.equal(off.digest, null);

  const failing = async () => ({ ok: false, status: 500 });
  const report = await generateDigest(records, {
    env: { LLM_API_KEY: 'k', LLM_API_BASE: 'http://127.0.0.1:8799' },
    fetchImpl: failing,
  });
  assert.equal(report.digest, null);
  assert.match(report.error, /500/);
  assert.equal(records[0].weight, undefined);
});

test('a good digest comes back cited and never touches the records', async () => {
  const records = [
    { id: 'a', title: 'Ken Roczen extends with Suzuki for 2027', topics: ['signings'], entities: ['ken-roczen'] },
  ];
  const fake = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              claims: [{ text: 'Ken Roczen has extended with Suzuki for 2027.', recordIds: ['a'] }],
            }),
          },
        },
      ],
    }),
  });
  const report = await generateDigest(records, { env: { LLM_API_KEY: 'k' }, fetchImpl: fake });
  assert.equal(report.claimCount, 1);
  assert.equal(report.digest.model, 'glm-4.5-flash');
  assert.deepEqual(report.digest.claims[0].recordIds, ['a']);
  assert.equal(records[0].weight, undefined);
});

/* ---------- classification ---------- */

test('classifies a signing story and finds the rider', () => {
  const labels = classify({ title: 'Ken Roczen signs a two-year extension with Suzuki for 2027 Supercross', summary: null });
  assert.ok(labels.topics.includes('signings'));
  assert.ok(labels.entities.includes('ken-roczen'));
  assert.ok(labels.entities.includes('suzuki'));
});

test('classifies an injury story', () => {
  const labels = classify({ title: 'Haiden Deegan out after wrist surgery', summary: null });
  assert.ok(labels.topics.includes('injury'));
  assert.ok(labels.entities.includes('haiden-deegan'));
});

test('finds Jalek Swoll in a real headline but not the word swollen', () => {
  const labels = classify({
    title: 'Official: Jalek Swoll Joins Phoenix Racing Honda for 2027 SuperMotocross',
    summary: null,
  });
  assert.ok(labels.entities.includes('jalek-swoll'));

  const bare = classify({ title: 'Rider has a swollen ankle after the main event', summary: null });
  assert.ok(!bare.entities.includes('jalek-swoll'));
});

test('rider-name queries cover every rider on the watchlist', () => {
  const queries = NEWS_QUERIES.filter((entry) => entry.id.startsWith('gnews-riders-'));
  assert.ok(queries.length >= 2, 'the watchlist is split across several queries');

  const covered = new Set();
  const sizes = [];
  for (const entry of queries) {
    assert.ok(entry.query.length <= 320, `${entry.id} is too long for Google News`);
    const names = entry.query.split(' OR ').map((part) => part.replace(/^"|"$/g, ''));
    assert.ok(names.length <= RIDER_QUERY_GROUP_SIZE, `${entry.id} names too many riders`);
    sizes.push(names.length);
    for (const name of names) covered.add(name);
  }
  // Round-robin dealing: no group may be thin while another is full.
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `uneven groups: ${sizes.join(',')}`);
  for (const rider of RIDERS) {
    assert.ok(covered.has(rider.name), `${rider.name} is never queried by name`);
  }
});

test('does not match a keyword inside a larger word', () => {
  const labels = classify({ title: 'Designer graphics kit released for the 2027 model', summary: null });
  assert.ok(!labels.topics.includes('signings'));
});

test('ambiguous surnames are only matched as full names', () => {
  const wrong = classify({ title: 'Cooper Webb takes the win in Anaheim', summary: null });
  assert.ok(wrong.entities.includes('cooper-webb'));
  assert.ok(!wrong.entities.includes('justin-cooper'));

  const bare = classify({ title: 'Martin leads the points standings', summary: null });
  assert.ok(!bare.entities.includes('jeremy-martin'));
});

test('common-name riders require motocross context', () => {
  const book = classify({
    title: 'Pierce Brown prepares to wrap up his Red Rising series and say goodbye to his beloved hero',
    publisherUrl: 'https://www.thebookseller.com/',
    summary: null,
  });
  assert.ok(!book.entities.includes('pierce-brown'));

  const football = classify({
    title: 'Pierce Brown 2026 Stats per Game - NCAAF',
    publisherUrl: 'https://www.espn.com/',
    summary: null,
  });
  assert.ok(!football.entities.includes('pierce-brown'));

  const race = classify({ title: 'Pierce Brown returns to racing at Anaheim 1 Supercross', summary: null });
  assert.ok(race.entities.includes('pierce-brown'));

  const withSummary = classify({
    title: 'Pierce Brown joins the team',
    summary: 'The motocross rider will race in 2027.',
  });
  assert.ok(withSummary.entities.includes('pierce-brown'));

  // The gate is for common names only: a distinctive rider still counts without a context word.
  const distinctive = classify({ title: 'Jalek Swoll will not retire', summary: null });
  assert.ok(distinctive.entities.includes('jalek-swoll'));
});

test('brands and teams need motocross context', () => {
  const carReview = classify({ title: '2027 Honda Civic review: a practical sedan', summary: null });
  assert.ok(!carReview.entities.includes('honda'));
  assert.ok(!carReview.entities.includes('honda-hrc'));

  const electricMtb = classify({
    title: 'Honda unveils its first high-end electric-assist mountain bike, the RN0',
    summary: null,
  });
  assert.ok(!electricMtb.entities.includes('honda'));

  // A generic context word cannot rescue a car story when the product is explicit.
  const carAtMotocross = classify({
    title: 'Honda Civic Type R review: a motocross-inspired car',
    summary: null,
  });
  assert.ok(!carAtMotocross.entities.includes('honda'));

  const energyDrink = classify({ title: 'Red Bull KTM launches a new energy drink', summary: null });
  assert.ok(!energyDrink.entities.includes('red-bull-ktm'));
  assert.ok(!energyDrink.entities.includes('ktm'));

  const motocross = classify({
    title: 'Honda HRC signs a new rider for the 2027 Supercross season',
    summary: null,
  });
  assert.ok(motocross.entities.includes('honda'));
  assert.ok(motocross.entities.includes('honda-hrc'));

  const team = classify({ title: 'Red Bull KTM reveals its 2027 Supercross roster', summary: null });
  assert.ok(team.entities.includes('red-bull-ktm'));
  assert.ok(team.entities.includes('ktm'));
});

test('the context audit catches non-MX brand hits and dropped MX brand/team stories', () => {
  const honda = { id: 'honda', name: 'Honda', aliases: ['Honda'], kind: 'brand' };
  const car = { title: '2027 Honda Civic review: a practical sedan', summary: null };
  assert.equal(inspectRecord(car, honda).status, 'dropped');
  assert.equal(
    inspectRecord(car, honda, { labels: { entities: ['honda'] }, hasContext: false }).status,
    'non-mx-counted',
  );

  const carWithMotocross = {
    title: 'Honda Civic Type R review: a motocross-inspired car',
    summary: null,
  };
  assert.equal(inspectRecord(carWithMotocross, honda).status, 'dropped');
  assert.equal(
    inspectRecord(carWithMotocross, honda, { labels: { entities: ['honda'] } }).status,
    'non-mx-counted',
  );

  const hondaHrc = { id: 'honda-hrc', name: 'Honda HRC', aliases: ['Honda HRC'], kind: 'team' };
  const motocross = { title: 'Honda HRC wins the Supercross main event', summary: null };
  assert.equal(inspectRecord(motocross, hondaHrc).status, 'kept');
  assert.equal(
    inspectRecord(motocross, hondaHrc, { labels: { entities: [] }, hasContext: true }).status,
    'near-miss',
  );
});

test('legitimate MX headlines survive without a context keyword in the title', () => {
  const fixtures = [
    { id: 'jorge-prado', title: 'Five Questions: Jorge Prado', publisherUrl: 'https://www.motoonline.com.au/' },
    {
      id: 'jason-anderson',
      title: 'Jason Anderson is back: The world champion is attacking again',
      publisherUrl: 'https://mxnews-online.com/',
    },
    {
      id: 'jason-anderson',
      title: 'Jason Anderson Back on the Bike After Temporary Break',
      publisherUrl: 'https://mxvice.com/',
    },
    { id: 'dean-wilson', title: 'Dean Wilson Injured in Practice Crash', publisherUrl: 'https://vurbmoto.com/' },
    {
      id: 'jorge-prado',
      title: 'Haiden Deegan wins Ridgedale 450 Moto 1, Jorge Prado finishes fifth',
      publisherUrl: 'https://www.nbcsports.com/',
    },
  ];
  for (const fixture of fixtures) {
    const labels = classify({ title: fixture.title, publisherUrl: fixture.publisherUrl, summary: null });
    assert.ok(labels.entities.includes(fixture.id), `${fixture.title} should still count for ${fixture.id}`);
  }
});

test('motocross context comes from a real domain or configured source id', () => {
  assert.ok(isMotocrossOutlet({ sourceId: 'mxvice' }));
  assert.ok(isMotocrossOutlet({ publisherUrl: 'https://www.racerxonline.com/' }));
  assert.ok(isMotocrossOutlet({ url: 'https://www.motoonline.com.au/news/story' }));
  assert.ok(!isMotocrossOutlet({ publisherUrl: 'https://www.thebookseller.com/' }));
  assert.ok(!isMotocrossOutlet({ sourceId: 'gnews-riders-5' }));
});

test('the LLM pass cannot attach a gated entity without motocross context', () => {
  const book = [{ id: 'book', title: 'Pierce Brown wraps up his Red Rising series', summary: null, topics: [], entities: [] }];
  assert.equal(applyEnrichment(book, [{ id: 'book', entities: ['pierce-brown'] }]), 0);
  assert.deepEqual(book[0].entities, []);

  const race = [
    { id: 'race', title: 'Pierce Brown returns at Anaheim Supercross', summary: null, topics: [], entities: [] },
  ];
  assert.equal(applyEnrichment(race, [{ id: 'race', entities: ['pierce-brown'] }]), 1);
  assert.deepEqual(race[0].entities, ['pierce-brown']);

  const car = [{ id: 'car', title: '2027 Honda Civic review: a practical sedan', summary: null, topics: [], entities: [] }];
  assert.equal(applyEnrichment(car, [{ id: 'car', entities: ['honda', 'honda-hrc'] }]), 0);
  assert.deepEqual(car[0].entities, []);

  const motocross = [
    { id: 'mx', title: 'Honda HRC signs a rider for Supercross', summary: null, topics: [], entities: [] },
  ];
  assert.equal(applyEnrichment(motocross, [{ id: 'mx', entities: ['honda', 'honda-hrc'] }]), 1);
  assert.deepEqual(motocross[0].entities, ['honda', 'honda-hrc']);
});

test('regions split American and world series', () => {
  assert.equal(classify({ title: 'Anaheim 1 Supercross preview', summary: null }).region, 'us');
  assert.equal(classify({ title: 'MXGP of Kegums results', summary: null }).region, 'world');
});

test('topic labels resolve for every topic in config', () => {
  for (const topic of ['signings', 'injury', 'results', 'schedule', 'tech', 'business', 'safety', 'culture']) {
    const labels = classify({ title: `Generic ${topic} placeholder`, summary: null });
    assert.ok(Array.isArray(labels.topics));
  }
});

test('does not read "returns to Auckland" as an injury', () => {
  const labels = classify({ title: 'Roczen and Davies Dominate as AUSX Returns to Auckland', summary: null });
  assert.ok(!labels.topics.includes('injury'));
});

test('the World Supercross series matches its official name', () => {
  const labels = classify({ title: 'World Supercross announces its 2027 calendar', summary: null });
  assert.ok(labels.entities.includes('wsx'));
});

test('every YouTube channel has a channel id and every news feed is allowlisted', () => {
  for (const entry of YOUTUBE_CHANNELS) {
    assert.match(entry.channelId, /^UC[\w-]{22}$/, `${entry.handle} has no channel id`);
  }
  for (const feed of FEEDS) {
    assert.equal(matchUpstream(feed.url).allowed, true, `${feed.label} is not on the relay allowlist`);
  }
});

test('drops live-stream spam headlines but keeps real ones', () => {
  assert.equal(isJunkTitle('『LIVeSTREAMS』 Boost Mobile AUSX Supercross 2026 today Live Updates!'), true);
  assert.equal(isJunkTitle('LIVE STREAM: AUSX Auckland round two'), true);
  assert.equal(isJunkTitle('Ken Roczen Extends with Suzuki for 2027'), false);
  assert.equal(isJunkTitle('How to watch: Herlings in the Japan finale'), false);
});

/* ---------- build pipeline ---------- */

test('a retained record from a source no longer configured is dropped', () => {
  const previous = {
    items: [
      record({ sourceId: 'ig-gone', url: 'https://example.com/ig' }),
      record({ url: 'https://example.com/keep' }),
      record({ url: 'https://example.com/old', publishedAt: NOW - 49 * HOUR }),
      record({ url: 'https://example.com/junk', title: 'LIVE STREAM: Auckland' }),
    ],
  };
  const out = retainPrevious(previous, { configuredSourceIds: new Set(['test']), now: NOW });
  assert.equal(out.retained.length, 1);
  assert.equal(out.retained[0].url, 'https://example.com/keep');
  assert.equal(out.unconfiguredRetained, 1);
  assert.equal(out.retainedBySource.get('test'), 1);
});

test('dedupe drops duplicates and records outside the window', () => {
  const out = dedupeRecords(
    [
      record({ url: 'https://example.com/a' }),
      record({ url: 'https://example.com/a/', title: 'Other copy' }),
      record({ url: 'https://example.com/b', title: 'A headline' }),
      record({ url: 'https://example.com/c', title: 'Too old', publishedAt: NOW - 49 * HOUR }),
    ],
    { now: NOW },
  );
  assert.equal(out.deduped.length, 1);
  assert.equal(out.duplicates, 2);
});

test('a failed source that kept records reads as cached, not live', () => {
  const attempts = [
    { def: { id: 'a', label: 'A', kind: 'news' }, status: 'unavailable', records: [], error: 'refused', fetchedAt: NOW },
    { def: { id: 'b', label: 'B', kind: 'news' }, status: 'live', records: [{ url: 'https://example.com/x' }], fetchedAt: NOW },
    { def: { id: 'c', label: 'C', kind: 'news' }, status: 'live', records: [], fetchedAt: NOW },
  ];
  const rows = buildSourceRows(attempts, {
    itemCounts: new Map([['b', 0]]),
    previousSources: new Map([['a', { lastSuccessAt: NOW - HOUR }]]),
    retainedBySource: new Map([['a', 2]]),
  });
  assert.equal(rows[0].status, 'cached');
  assert.equal(rows[0].recordCount, 0);
  assert.equal(rows[0].lastSuccessAt, NOW - HOUR);
  assert.equal(rows[1].status, 'live');
  assert.match(rows[1].note, /duplicates/);
  assert.equal(rows[2].status, 'empty');
});

test('a thin build is described as thin, a normal one says nothing', () => {
  assert.equal(coverageNoteText({ sourcesAttempted: 28, sourcesLive: 26 }), null);
  assert.match(coverageNoteText({ sourcesAttempted: 28, sourcesLive: 4 }), /4 of 28 sources answered/);
  assert.equal(coverageNoteText(null), null);
});

test('a failed parse leaves a diagnostic excerpt on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motobuzz-diag-'));
  try {
    const written = await saveDiagnostics(
      [
        {
          def: { id: 'yt-test' },
          fetchedAt: NOW,
          diagnostic: { stage: 'channel page', bytes: 11, excerpt: '<html>bad</html>' },
        },
        { def: { id: 'yt-ok' }, fetchedAt: NOW, diagnostic: null },
      ],
      { root },
    );
    assert.equal(written.length, 1);
    const text = await readFile(written[0], 'utf8');
    assert.match(text, /yt-test.*stage=channel page/);
    assert.match(text, /<html>bad<\/html>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the Atom feed carries the records, escapes titles, and uses absolute links', () => {
  const snapshot = buildSnapshot([record({ title: 'Tomac & Jett <win>' })], { now: NOW });
  const xml = buildAtomFeed(
    { generatedAt: NOW, site: { name: 'MotoBuzz' }, buzz: snapshot.buzz, items: snapshot.items },
    { selfUrl: 'feed.xml', siteUrl: 'https://example.github.io/motobuzz/' },
  );
  assert.match(xml, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
  assert.match(xml, /Tomac &amp; Jett &lt;win&gt;/);
  assert.equal((xml.match(/<entry>/g) || []).length, 1);
  assert.match(xml, /<link rel="self" href="https:\/\/example.github.io\/motobuzz\/feed.xml"\/>/);
  assert.match(xml, /<link rel="alternate" href="https:\/\/example.github.io\/motobuzz\/"\/>/);
});

/* ---------- scoring ---------- */

function record(overrides = {}) {
  return {
    id: stableId(`x|${overrides.url || 'https://example.com/a'}`),
    sourceId: 'test',
    kind: 'news',
    title: 'A headline',
    summary: null,
    url: 'https://example.com/a',
    publisher: 'Test',
    publisherUrl: 'https://example.com',
    channel: null,
    publishedAt: NOW - HOUR,
    fetchedAt: NOW,
    engagement: null,
    engagementLabel: null,
    topics: ['results'],
    entities: ['eli-tomac'],
    region: 'us',
    ...overrides,
  };
}

test('recency decays by half over one half-life', () => {
  const fresh = recencyFactor({ kind: 'news', publishedAt: NOW }, NOW);
  const old = recencyFactor({ kind: 'news', publishedAt: NOW - DECAY.news.halfLifeHours * HOUR }, NOW);
  assert.ok(Math.abs(fresh - 1) < 1e-9);
  assert.ok(Math.abs(old - 0.5) < 1e-6);
});

test('social engagement raises energy but with a log scale', () => {
  const quiet = engagementFactor({ kind: 'social', engagement: 1 });
  const loud = engagementFactor({ kind: 'social', engagement: 500_000 });
  assert.ok(loud > quiet);
  assert.ok(loud < 12, 'a viral post cannot dominate without bound');
  assert.equal(engagementFactor({ kind: 'news', engagement: 999_999 }), 1);
});

test('eligibility enforces per-kind maximum age', () => {
  assert.ok(isEligible(record({ publishedAt: NOW - 47 * HOUR }), NOW));
  assert.ok(!isEligible(record({ publishedAt: NOW - 49 * HOUR }), NOW));
  assert.ok(isEligible(record({ kind: 'social', publishedAt: NOW - 60 * HOUR }), NOW));
  assert.ok(!isEligible(record({ publishedAt: NOW + 5 * HOUR }), NOW));
});

test('an empty room scores zero and says so', () => {
  const snapshot = buildSnapshot([], { now: NOW });
  assert.equal(snapshot.buzz.score, 0);
  assert.equal(snapshot.buzz.activeItems, 0);
  // With no records, the page must say it has nothing rather than guess.
  assert.match(snapshot.buzz.headline, /No signal|No sources answered/i);
});

test('the score rises with energy and never exceeds 100', () => {
  const few = buildSnapshot([record()], { now: NOW });
  const many = buildSnapshot(
    Array.from({ length: 60 }, (_, index) =>
      record({ url: `https://example.com/${index}`, title: `Story ${index}`, publishedAt: NOW - index * 60_000 }),
    ),
    { now: NOW },
  );
  assert.ok(momentumSanity(few));
  assert.ok(many.buzz.score > few.buzz.score);
  assert.ok(many.buzz.score <= 100);
  assert.ok(many.buzz.energy > few.buzz.energy);
});

function momentumSanity(snapshot) {
  return Number.isFinite(snapshot.buzz.momentum) && snapshot.buzz.momentum > 0;
}

test('the score saturates instead of growing without bound', () => {
  const huge = buildSnapshot(
    Array.from({ length: 380 }, (_, index) =>
      record({ url: `https://example.com/h${index}`, title: `Story ${index}`, publishedAt: NOW - index * 1000 }),
    ),
    { now: NOW },
  );
  assert.ok(huge.buzz.score <= 100);
  assert.ok(huge.buzz.score > 90);
});

test('momentum reports rising when the last six hours dominate', () => {
  const rising = buildSnapshot(
    Array.from({ length: 12 }, (_, index) =>
      record({ url: `https://example.com/r${index}`, title: `Recent ${index}`, publishedAt: NOW - index * 60_000 }),
    ),
    { now: NOW },
  );
  assert.equal(rising.buzz.momentumLabel, 'rising');
});

test('momentum reports cooling when only older records exist', () => {
  const cooling = buildSnapshot(
    Array.from({ length: 12 }, (_, index) =>
      record({ url: `https://example.com/c${index}`, title: `Older ${index}`, publishedAt: NOW - (10 + index) * HOUR }),
    ),
    { now: NOW },
  );
  assert.equal(cooling.buzz.momentumLabel, 'cooling');
});

test('buckets sum to the chatter they represent', () => {
  const snapshot = buildSnapshot(
    Array.from({ length: 5 }, (_, index) =>
      record({ url: `https://example.com/b${index}`, title: `Story ${index}`, publishedAt: NOW - index * HOUR }),
    ),
    { now: NOW },
  );
  assert.equal(snapshot.buzz.buckets.length, WINDOW.bucketCount);
  const items = snapshot.buzz.buckets.reduce((sum, bucket) => sum + bucket.items, 0);
  assert.equal(items, 5);
});

test('entities are ranked and carry a trend and series', () => {
  const snapshot = buildSnapshot(
    [
      record({ url: 'https://example.com/1', entities: ['eli-tomac'], title: 'Tomac wins' }),
      record({ url: 'https://example.com/2', entities: ['eli-tomac'], title: 'Tomac again' }),
      record({ url: 'https://example.com/3', entities: ['ktm'], title: 'KTM news' }),
    ],
    { now: NOW },
  );
  assert.equal(snapshot.entities[0].id, 'eli-tomac');
  assert.equal(snapshot.entities[0].mentions, 2);
  assert.equal(snapshot.entities[0].series.length, 12);
  assert.ok(['rising', 'cooling', 'steady'].includes(snapshot.entities[0].trend));
});

test('region shares are fractions of the total', () => {
  const snapshot = buildSnapshot(
    [
      record({ url: 'https://example.com/1', region: 'us' }),
      record({ url: 'https://example.com/2', region: 'world' }),
    ],
    { now: NOW },
  );
  assert.equal(snapshot.region.us, 0.5);
  assert.equal(snapshot.region.world, 0.5);
});

test('buzz bands cover the whole scale', () => {
  assert.equal(BUZZ.bands[0].min, 0);
  assert.deepEqual(
    BUZZ.bands.map((band) => band.min),
    [...BUZZ.bands.map((band) => band.min)].sort((a, b) => a - b),
  );
});

test('urlKey drops tracking parameters and trailing slashes', () => {
  assert.equal(
    urlKey('https://Example.com/news/story/?utm_source=x&id=7#frag'),
    urlKey('https://example.com/news/story?id=7'),
  );
});

/* ---------- validation ---------- */

function validCache(overrides = {}) {
  const snapshot = buildSnapshot([record()], { now: NOW });
  return {
    schemaVersion: 1,
    generatedAt: NOW,
    site: { name: 'MotoBuzz', timezone: 'America/New_York' },
    build: { durationMs: 10 },
    buzz: snapshot.buzz,
    threads: snapshot.threads,
    entities: snapshot.entities,
    region: snapshot.region,
    sources: [
      {
        sourceId: 'test',
        label: 'Test',
        kind: 'news',
        status: 'live',
        fetchedAt: NOW,
        recordCount: 1,
      },
    ],
    items: snapshot.items,
    ...overrides,
  };
}

test('accepts a well-formed cache', () => {
  const result = validateCache(validCache(), { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.cache.items.length, 1);
});

test('rejects an unknown schema version outright', () => {
  const result = validateCache(validCache({ schemaVersion: 99 }), { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.cache, null);
});

test('rejects a cache with a nonsense generation time', () => {
  assert.equal(validateCache(validCache({ generatedAt: NOW + 48 * HOUR }), { now: NOW }).ok, false);
  assert.equal(validateCache(validCache({ generatedAt: 'soon' }), { now: NOW }).ok, false);
});

test('drops individual bad records and keeps the good ones', () => {
  const cache = validCache();
  cache.items.push({ ...cache.items[0], url: 'http://insecure.example.com/x' });
  cache.items.push({ ...cache.items[0], title: '' });
  const result = validateCache(cache, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.cache.items.length, 1);
  assert.equal(result.droppedRecords, 2);
});

test('rejects a cache whose every record is unusable', () => {
  const cache = validCache();
  cache.items = [{ title: 'no url' }];
  assert.equal(validateCache(cache, { now: NOW }).ok, false);
});

test('rejects a cache with no buzz block', () => {
  const cache = validCache();
  delete cache.buzz;
  assert.equal(validateCache(cache, { now: NOW }).ok, false);
});

test('a digest citing a record that is not in the cache is trimmed away', () => {
  const cache = validCache();
  cache.digest = {
    model: 'test',
    generatedAt: NOW,
    claims: [
      { text: 'A valid claim about the story in the cache.', recordIds: [cache.items[0].id] },
      { text: 'A claim about a record that is not here.', recordIds: ['ghost'] },
    ],
  };
  const result = validateCache(cache, { now: NOW });
  assert.equal(result.cache.digest.claims.length, 1);
  assert.deepEqual(result.cache.digest.claims[0].recordIds, [cache.items[0].id]);
});

test('unknown source statuses are discarded', () => {
  const cache = validCache();
  cache.sources.push({ sourceId: 'ghost', status: 'haunted' });
  const result = validateCache(cache, { now: NOW });
  assert.equal(result.cache.sources.length, 1);
});

/* ---------- relay allowlist ---------- */

test('allows known upstreams', () => {
  assert.equal(matchUpstream('https://www.supercrosslive.com/rss').allowed, true);
  assert.equal(matchUpstream('https://news.google.com/rss/search?q=motocross').allowed, true);
  assert.equal(matchUpstream('https://www.youtube.com/@vitalmx/videos').allowed, true);
});

test('refuses everything else', () => {
  assert.equal(matchUpstream('http://www.supercrosslive.com/rss').allowed, false);
  assert.equal(matchUpstream('https://evil.example.com/rss').allowed, false);
  assert.equal(matchUpstream('https://127.0.0.1/rss').allowed, false);
  assert.equal(matchUpstream('https://user:pass@www.supercrosslive.com/rss').allowed, false);
  assert.equal(matchUpstream('https://www.supercrosslive.com:8443/rss').allowed, false);
  assert.equal(matchUpstream('https://www.supercrosslive.com/rss/../../etc/passwd').allowed, false);
});

test('a configured bridge origin is the only extra allowance', () => {
  const bridge = new URL('https://bridge.internal.example');
  assert.equal(matchUpstream('https://bridge.internal.example/twitter/user/x', bridge).allowed, true);
  assert.equal(matchUpstream('https://bridge.internal.example/twitter/user/x').allowed, false);
});

/* ---------- runner ---------- */

let passed = 0;
const failures = [];

for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n`);
  }
}

process.stdout.write(`\n${passed}/${tests.length} passing\n`);
if (failures.length > 0) {
  for (const failure of failures) {
    process.stdout.write(`\n${failure.name}\n${failure.error?.stack || failure.error}\n`);
  }
  process.exit(1);
}
