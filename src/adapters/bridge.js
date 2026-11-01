/**
 * Optional social bridge.
 *
 * X refuses anonymous server-side reads. If the operator runs their own RSS
 * bridge (RSSHub and friends do this) and sets MOTOBUZZ_BRIDGE_URL for the build,
 * the X handles in config.js are read through it and labelled as bridged social
 * sources. Without a bridge those sources report `unconfigured` rather than
 * showing invented posts. Instagram has its own adapter and no longer needs this.
 */
import { BRIDGE_HANDLES, INGEST } from '../config.js';
import { httpsUrl, truncate } from '../lib/text.js';
import { fetchText } from './http.js';
import { parseFeed } from './feed.js';

const ROUTES = { instagram: 'instagram/user', twitter: 'twitter/user' };

export function bridgeBase() {
  const raw = process.env.MOTOBUZZ_BRIDGE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function bridgeSourceDefs() {
  const base = bridgeBase();
  return BRIDGE_HANDLES.map((entry) => {
    const route = ROUTES[entry.network];
    return {
      id: entry.id,
      label: entry.label,
      provider: 'Operator-run social bridge',
      homepage: base ? base.href : null,
      url: base && route ? `${base.href.replace(/\/$/, '')}/${route}/${entry.handle}` : null,
      kind: 'social',
      type: 'bridge',
      configured: Boolean(base),
    };
  });
}

/**
 * @param {ReturnType<typeof bridgeSourceDefs>[number]} def
 * @param {{relay?: string|null, now: number, fetchedAt: number}} ctx
 */
export async function loadBridgeSource(def, ctx) {
  if (!def.configured || !def.url) {
    return {
      status: 'unconfigured',
      error: null,
      records: [],
      note: 'Set MOTOBUZZ_BRIDGE_URL to read this profile through your own bridge.',
    };
  }

  const { relay = null, now = Date.now(), fetchedAt = now } = ctx;
  const response = await fetchText(def.url, { relay, timeoutMs: INGEST.bridgeTimeoutMs });
  const parsed = parseFeed(response.body);

  if (!parsed.ok) {
    return { status: 'malformed', error: parsed.error || 'Bridge response was not a feed.', records: [], note: null };
  }
  if (parsed.isEmpty) {
    return { status: 'empty', error: null, records: [], note: 'Bridge returned no posts.' };
  }

  const records = [];
  for (const item of parsed.items.slice(0, INGEST.itemsPerBridge)) {
    const url = httpsUrl(item.link);
    if (!url || !item.publishedAt) continue;
    records.push({
      sourceId: def.id,
      kind: 'social',
      publisher: def.label,
      publisherUrl: httpsUrl(item.sourceUrl) || httpsUrl(def.homepage) || null,
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
    return { status: 'empty', error: null, records: [], note: 'No dated posts came back from the bridge.' };
  }

  return { status: 'live', error: null, records, note: null };
}
