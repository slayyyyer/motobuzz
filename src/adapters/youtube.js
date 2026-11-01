/**
 * YouTube adapter.
 *
 * YouTube stopped serving per-channel Atom feeds, so this reads the public
 * channel page the same way a browser does and lifts the video entries out of
 * the page's own JSON. That markup can change without notice, so a channel that
 * does not match is reported as malformed instead of silently returning zero
 * records, and no other source depends on it succeeding.
 */
import { INGEST, YOUTUBE_BASE, YOUTUBE_CHANNELS } from '../config.js';
import { httpsUrl, parseCount, parseRelativeTime, truncate } from '../lib/text.js';
import { fetchText } from './http.js';

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
    provider: 'YouTube channel page',
    homepage: `${YOUTUBE_BASE}/@${entry.handle}`,
    url: `${YOUTUBE_BASE}/@${entry.handle}/videos`,
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

/**
 * @param {ReturnType<typeof youtubeSourceDefs>[number]} def
 * @param {{relay?: string|null, now: number, fetchedAt: number}} ctx
 */
export async function loadYoutubeSource(def, ctx) {
  const { relay = null, now = Date.now(), fetchedAt = now } = ctx;

  const response = await fetchText(def.url, {
    relay,
    accept: 'text/html,application/xhtml+xml',
  });

  if (!/<html[\s>]/i.test(response.body.slice(0, 4000))) {
    return { status: 'malformed', error: 'Channel page was not HTML.', records: [], note: null };
  }

  const videos = extractChannelVideos(response.body, now);
  if (videos.length === 0) {
    return {
      status: 'malformed',
      error: 'No video entries found in the channel page.',
      records: [],
      note: 'YouTube markup may have changed.',
    };
  }

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
      replies: null,
      channel: `@${def.handle}`,
    });
  }

  if (records.length === 0) {
    return {
      status: 'empty',
      error: null,
      records: [],
      note: undated > 0 ? 'Recent uploads had no relative timestamp.' : 'No recent uploads.',
    };
  }

  return { status: 'live', error: null, records, note: null };
}
