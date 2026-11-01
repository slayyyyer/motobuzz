/**
 * Cache validation, run by the build after it writes and by the page before it
 * renders. An invalid envelope is rejected whole so a broken snapshot can never
 * replace a good one; individual bad records are dropped instead.
 */
import { CACHE_SCHEMA_VERSION } from '../config.js';
import { httpsUrl } from '../lib/text.js';

export const SOURCE_STATUSES = new Set(['live', 'empty', 'cached', 'malformed', 'unavailable', 'unconfigured']);
export const RECORD_KINDS = new Set(['news', 'social']);
const TEN_YEARS_MS = 10 * 365 * 24 * 3_600_000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function stringList(value, limit = 12) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 80).slice(0, limit);
}

export function validateRecord(raw, now) {
  if (!isPlainObject(raw)) return null;
  const url = httpsUrl(raw.url);
  if (!url) return null;
  if (typeof raw.title !== 'string' || raw.title.trim().length === 0 || raw.title.length > 300) return null;
  if (typeof raw.sourceId !== 'string' || raw.sourceId.length === 0 || raw.sourceId.length > 64) return null;
  if (!RECORD_KINDS.has(raw.kind)) return null;
  if (!finiteNumber(raw.publishedAt) || raw.publishedAt < now - TEN_YEARS_MS || raw.publishedAt > now + 3_600_000) {
    return null;
  }
  if (!finiteNumber(raw.weight) || raw.weight < 0 || raw.weight > 60) return null;

  return {
    id: typeof raw.id === 'string' && raw.id.length <= 64 ? raw.id : null,
    sourceId: raw.sourceId,
    kind: raw.kind,
    title: raw.title.trim(),
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 400) : null,
    url,
    publisher: typeof raw.publisher === 'string' && raw.publisher.length <= 120 ? raw.publisher : 'Unknown',
    publisherUrl: httpsUrl(raw.publisherUrl),
    channel: typeof raw.channel === 'string' && raw.channel.length <= 80 ? raw.channel : null,
    publishedAt: raw.publishedAt,
    fetchedAt: finiteNumber(raw.fetchedAt) ? raw.fetchedAt : null,
    engagement: finiteNumber(raw.engagement) ? raw.engagement : null,
    engagementLabel: typeof raw.engagementLabel === 'string' && raw.engagementLabel.length <= 20 ? raw.engagementLabel : null,
    replies: finiteNumber(raw.replies) ? raw.replies : null,
    dateBasis: raw.dateBasis === 'day' ? 'day' : 'exact',
    topics: stringList(raw.topics),
    entities: stringList(raw.entities),
    region: ['us', 'world', 'mixed'].includes(raw.region) ? raw.region : null,
    weight: raw.weight,
  };
}

export function validateSource(raw, now) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.sourceId !== 'string' || raw.sourceId.length === 0 || raw.sourceId.length > 64) return null;
  if (!SOURCE_STATUSES.has(raw.status)) return null;
  return {
    sourceId: raw.sourceId,
    label: typeof raw.label === 'string' ? raw.label : raw.sourceId,
    provider: typeof raw.provider === 'string' ? raw.provider : null,
    homepage: httpsUrl(raw.homepage),
    kind: RECORD_KINDS.has(raw.kind) ? raw.kind : 'news',
    status: raw.status,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 200) : null,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : null,
    fetchedAt: finiteNumber(raw.fetchedAt) ? raw.fetchedAt : null,
    lastSuccessAt: finiteNumber(raw.lastSuccessAt) ? raw.lastSuccessAt : null,
    recordCount: finiteNumber(raw.recordCount) ? raw.recordCount : 0,
  };
}

function validateBuckets(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((bucket) => isPlainObject(bucket) && finiteNumber(bucket.start) && finiteNumber(bucket.energy))
    .slice(0, 48)
    .map((bucket) => ({
      start: bucket.start,
      energy: Math.max(0, Math.min(400, bucket.energy)),
      items: finiteNumber(bucket.items) ? Math.max(0, Math.min(400, bucket.items)) : 0,
    }));
}

function validateBuzz(raw) {
  if (!isPlainObject(raw)) return null;
  if (!finiteNumber(raw.score) || raw.score < 0 || raw.score > 100) return null;
  if (typeof raw.label !== 'string' || typeof raw.headline !== 'string') return null;
  return {
    score: raw.score,
    level: typeof raw.level === 'string' ? raw.level : 'quiet',
    label: raw.label.slice(0, 40),
    note: typeof raw.note === 'string' ? raw.note.slice(0, 160) : '',
    headline: raw.headline.slice(0, 400),
    headlineBasis: typeof raw.headlineBasis === 'string' ? raw.headlineBasis.slice(0, 80) : '',
    energy: finiteNumber(raw.energy) ? raw.energy : 0,
    momentum: finiteNumber(raw.momentum) ? raw.momentum : 1,
    momentumLabel: ['rising', 'cooling', 'steady'].includes(raw.momentumLabel) ? raw.momentumLabel : 'steady',
    activeItems: finiteNumber(raw.activeItems) ? raw.activeItems : 0,
    sourcesRepresented: finiteNumber(raw.sourcesRepresented) ? raw.sourcesRepresented : 0,
    publishersRepresented: finiteNumber(raw.publishersRepresented) ? raw.publishersRepresented : 0,
    newestItemAt: finiteNumber(raw.newestItemAt) ? raw.newestItemAt : null,
    counts: {
      news: finiteNumber(raw.counts?.news) ? raw.counts.news : 0,
      social: finiteNumber(raw.counts?.social) ? raw.counts.social : 0,
    },
    buckets: validateBuckets(raw.buckets),
  };
}

function validateThreads(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (thread) =>
        isPlainObject(thread) &&
        typeof thread.id === 'string' &&
        typeof thread.label === 'string' &&
        finiteNumber(thread.heat),
    )
    .slice(0, 8)
    .map((thread) => ({
      id: thread.id.slice(0, 80),
      topic: typeof thread.topic === 'string' ? thread.topic.slice(0, 40) : 'other',
      label: thread.label.slice(0, 80),
      heat: thread.heat,
      share: finiteNumber(thread.share) ? thread.share : 0,
      itemCount: finiteNumber(thread.itemCount) ? thread.itemCount : 0,
      sources: finiteNumber(thread.sources) ? thread.sources : 0,
      momentum: finiteNumber(thread.momentum) ? thread.momentum : 1,
      trend: ['rising', 'cooling', 'steady'].includes(thread.trend) ? thread.trend : 'steady',
      entity: isPlainObject(thread.entity) && typeof thread.entity.name === 'string' ? thread.entity : null,
      exemplar: isPlainObject(thread.exemplar) && httpsUrl(thread.exemplar.url)
        ? {
            title: String(thread.exemplar.title || '').slice(0, 300),
            url: httpsUrl(thread.exemplar.url),
            publisher: String(thread.exemplar.publisher || ''),
            publishedAt: finiteNumber(thread.exemplar.publishedAt) ? thread.exemplar.publishedAt : null,
          }
        : null,
    }));
}

function validateEntities(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entity) =>
        isPlainObject(entity) &&
        typeof entity.id === 'string' &&
        typeof entity.name === 'string' &&
        finiteNumber(entity.heat),
    )
    .slice(0, 24)
    .map((entity) => ({
      id: entity.id.slice(0, 80),
      kind: ['rider', 'brand', 'team', 'series'].includes(entity.kind) ? entity.kind : 'rider',
      name: entity.name.slice(0, 80),
      heat: entity.heat,
      share: finiteNumber(entity.share) ? entity.share : 0,
      mentions: finiteNumber(entity.mentions) ? entity.mentions : 0,
      sources: finiteNumber(entity.sources) ? entity.sources : 0,
      momentum: finiteNumber(entity.momentum) ? entity.momentum : 1,
      trend: ['rising', 'cooling', 'steady'].includes(entity.trend) ? entity.trend : 'steady',
      series: Array.isArray(entity.series) ? entity.series.filter(finiteNumber).slice(0, 12) : [],
      exemplar: isPlainObject(entity.exemplar) && httpsUrl(entity.exemplar.url)
        ? {
            title: String(entity.exemplar.title || '').slice(0, 300),
            url: httpsUrl(entity.exemplar.url),
            publisher: String(entity.exemplar.publisher || ''),
            publishedAt: finiteNumber(entity.exemplar.publishedAt) ? entity.exemplar.publishedAt : null,
          }
        : null,
    }));
}

/**
 * @param {unknown} raw
 * @param {{now?: number, schemaVersion?: number}} [options]
 * @returns {{ok: boolean, reasons: string[], cache: object|null, droppedRecords: number}}
 */
export function validateCache(raw, options = {}) {
  const { now = Date.now(), schemaVersion = CACHE_SCHEMA_VERSION } = options;
  const reasons = [];

  if (!isPlainObject(raw)) {
    return { ok: false, reasons: ['Cache is not an object.'], cache: null, droppedRecords: 0 };
  }
  if (raw.schemaVersion !== schemaVersion) {
    return { ok: false, reasons: [`Unsupported schema version ${String(raw.schemaVersion)}.`], cache: null, droppedRecords: 0 };
  }
  if (!finiteNumber(raw.generatedAt) || raw.generatedAt < now - TEN_YEARS_MS || raw.generatedAt > now + 3_600_000) {
    return { ok: false, reasons: ['Cache generation time is unusable.'], cache: null, droppedRecords: 0 };
  }

  const buzz = validateBuzz(raw.buzz);
  if (!buzz) return { ok: false, reasons: ['Cache buzz block is invalid.'], cache: null, droppedRecords: 0 };
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    return { ok: false, reasons: ['Cache has no records.'], cache: null, droppedRecords: 0 };
  }

  const items = [];
  for (const entry of raw.items.slice(0, 1200)) {
    const record = validateRecord(entry, now);
    if (record) items.push(record);
  }
  const droppedRecords = raw.items.length - items.length;
  if (droppedRecords > 0) reasons.push(`${droppedRecords} record(s) dropped.`);
  if (items.length === 0) reasons.push('Every record was rejected.');

  const sources = Array.isArray(raw.sources) ? raw.sources.map((entry) => validateSource(entry, now)).filter(Boolean) : [];

  return {
    ok: items.length > 0,
    reasons,
    droppedRecords,
    cache: {
      schemaVersion: raw.schemaVersion,
      generatedAt: raw.generatedAt,
      site: isPlainObject(raw.site) ? raw.site : null,
      build: isPlainObject(raw.build) ? raw.build : null,
      buzz,
      threads: validateThreads(raw.threads),
      entities: validateEntities(raw.entities),
      region: isPlainObject(raw.region)
        ? {
            us: finiteNumber(raw.region.us) ? raw.region.us : 0,
            world: finiteNumber(raw.region.world) ? raw.region.world : 0,
            mixed: finiteNumber(raw.region.mixed) ? raw.region.mixed : 0,
            unknown: finiteNumber(raw.region.unknown) ? raw.region.unknown : 0,
          }
        : { us: 0, world: 0, mixed: 0, unknown: 0 },
      sources,
      items: items.sort((a, b) => b.weight - a.weight),
    },
  };
}
