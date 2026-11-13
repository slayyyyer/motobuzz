/**
 * YouTube adapter.
 *
 * Each channel has a public Atom feed at /feeds/videos.xml?channel_id=UC…, which
 * is documented, carries exact publish times and view counts, and needs no key.
 * It is read first. The channel page is the fallback, because the feed has had
 * outages and only returns the newest fifteen uploads.
 *
 * The page is scraped out of its own embedded JSON, so its markup can change
 * without notice. A channel that does not match either route is reported as
 * malformed, with an excerpt of the bytes for later diagnosis, instead of
 * silently returning zero records.
 */
import { INGEST, YOUTUBE_BASE, YOUTUBE_CHANNELS, YOUTUBE_FEED_BASE } from '../config.js';
import { httpsUrl, parseCount, parseRelativeTime, truncate } from '../lib/text.js';
import { fetchText } from './http.js';
import { parseFeed } from './feed.js';

const VIDEO_ID = /"contentId":"([\w-]{11})"/g;
const TITLE_PATTERNS = [
  /"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/,
  /"title":\{"simpleText":"((?:[^"\\]|\\.)*)"/,
  /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/,
];
const LABEL_TEXT = /"accessibilityLabel":"((?:[^"\\]|\\.){1,60})"/g;
const PART_TEXT = /"text":\{"content":"((?:[^"\\]|\\.){1,60})"/g;

function jsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

export function youtubeSourceDefs() {
  return YOUTUBE_CHANNELS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    provider: 'YouTube channel feed',
    homepage: `${YOUTUBE_BASE}/@${entry.handle}`,
    url: `${YOUTUBE_BASE}/@${entry.handle}/videos`,
    feedUrl: entry.channelId ? `${YOUTUBE_FEED_BASE}?channel_id=${entry.channelId}` : null,
    handle: entry.handle,
    kind: 'social',
    type: 'youtube',
  }));
}

/**
 * Pull video entries out of a channel page. Exported so the test suite can run
 * it against a saved fixture without touching the network.
 */
export function extractChannelVideos(html, now) {
  const source = String(html || '');
  const seen = new Set();
  const videos = [];

  VIDEO_ID.lastIndex = 0;
  let match;
  while ((match = VIDEO_ID.exec(source))) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);

    // The entry's metadata follows its contentId, separated by a large palette blob.
    const window = source.slice(match.index, match.index + 12_000);

    let title = null;
    for (const pattern of TITLE_PATTERNS) {
      const found = window.match(pattern);
      if (found) {
        title = jsonString(found[1]);
        break;
      }
    }
    if (!title) continue;

    // YouTube's own labels are the most reliable: '25 thousand views', '2 days ago'.
    const labels = [...window.matchAll(LABEL_TEXT)].map((entry) => jsonString(entry[1]));
    const parts = [...window.matchAll(PART_TEXT)].map((entry) => jsonString(entry[1]));
    const viewsText = labels.find((value) => /views?$/i.test(value.trim()));
    const timeText =
      labels.find((value) => /\bago$/i.test(value.trim())) ||
      parts.find((value) => /\bago$/i.test(value.trim()));

    videos.push({
      id,
      title,
      views: viewsText ? parseCount(viewsText) : null,
      publishedAt: timeText ? parseRelativeTime(timeText, now) : null,
      relativeTime: timeText || null,
    });
  }

  return videos;
}

function videoIdFromLink(link) {
  try {
    const parsed = new URL(link);
    return parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop() || null;
  } catch {
    return null;
  }
}

/** Turn a parsed channel feed into the same video shape the page extractor emits. */
export function videosFromFeed(parsed) {
  const videos = [];
  for (const item of parsed?.items || []) {
    const id = videoIdFromLink(item.link) || String(item.guid || '').replace(/^yt:video:/, '') || null;
    if (!id) continue;
    videos.push({
      id,
      title: item.title,
      views: Number.isFinite(item.views) ? item.views : null,
      publishedAt: item.publishedAt,
      relativeTime: null,
    });
  }
  return videos;
}

function toRecords(def, videos, { fetchedAt }) {
  const records = [];
  let undated = 0;
  for (const video of videos.slice(0, INGEST.itemsPerChannel)) {
    const url = httpsUrl(`${YOUTUBE_BASE}/watch?v=${video.id}`);
    if (!url) continue;
    if (!video.publishedAt) {
      undated += 1;
      continue;
    }
    records.push({
      sourceId: def.id,
      kind: 'social',
      publisher: def.label,
      publisherUrl: def.homepage,
      title: truncate(video.title, INGEST.maxTitleLength),
      summary: null,
      url,
      publishedAt: video.publishedAt,
      fetchedAt,
      engagement: video.views,
      engagementLabel: video.views === null ? null : 'views',
      channel: `@${def.handle}`,
    });
  }
  return { records, undated };
}

function excerpt(body) {
  return { bytes: body.length, excerpt: body.slice(0, INGEST.diagnosticBytes) };
}

/**
 * @param {ReturnType<typeof youtubeSourceDefs>[number]} def
 * @param {{relay?: string|null, now: number, fetchedAt: number}} ctx
 */
export async function loadYoutubeSource(def, ctx) {
  const { relay = null, now = Date.now(), fetchedAt = now } = ctx;

  // --- the documented route -------------------------------------------------
  let feedProblem = null;
  if (def.feedUrl) {
    try {
      const response = await fetchText(def.feedUrl, { relay, accept: 'application/atom+xml, application/xml, text/xml' });
      const parsed = parseFeed(response.body);
      if (!parsed.ok) {
        feedProblem = parsed.error || 'Channel feed could not be parsed.';
      } else if (!parsed.isEmpty) {
        const { records, undated } = toRecords(def, videosFromFeed(parsed), { fetchedAt });
        if (records.length > 0) return { status: 'live', error: null, records, note: null };
        if (undated > 0) {
          feedProblem = 'Channel feed entries had no publish time.';
        }
      }
    } catch (error) {
      feedProblem = error instanceof Error ? error.message : String(error);
    }
  }

  // --- the page fallback ----------------------------------------------------
  const response = await fetchText(def.url, {
    relay,
    accept: 'text/html,application/xhtml+xml',
  });

  if (!/<html[\s>]/i.test(response.body.slice(0, 4000))) {
    return {
      status: 'malformed',
      error: feedProblem ? `Channel feed failed (${feedProblem}); page was not HTML.` : 'Channel page was not HTML.',
      records: [],
      note: null,
      diagnostic: { stage: 'channel page', ...excerpt(response.body) },
    };
  }

  const videos = extractChannelVideos(response.body, now);
  if (videos.length === 0) {
    return {
      status: 'malformed',
      error: feedProblem ? `Channel feed failed (${feedProblem}); no videos in the channel page.` : 'No video entries found in the channel page.',
      records: [],
      note: 'YouTube markup may have changed.',
      diagnostic: { stage: 'channel page', ...excerpt(response.body) },
    };
  }

  const { records, undated } = toRecords(def, videos, { fetchedAt });

  if (records.length === 0) {
    return {
      status: 'empty',
      error: null,
      records: [],
      note: undated > 0 ? 'Recent uploads had no relative timestamp.' : 'No recent uploads.',
    };
  }

  return {
    status: 'live',
    error: null,
    records,
    note: feedProblem ? `Read from the channel page: ${feedProblem}` : 'Read from the channel page.',
  };
}
