#!/usr/bin/env node
/**
 * Builds the hourly buzz cache.
 *
 * GitHub Actions runs this once an hour, then publishes the app and
 * data/buzz-cache.json together as one Pages artifact. The browser never talks
 * to a feed, a relay, or an API: it reads only that same-origin snapshot.
 *
 * Behaviour worth knowing:
 * - A source that fails keeps its still-valid earlier records, labelled cached.
 * - Records are deduped by URL and by normalized headline, so syndicated copies
 *   of one story do not count twice.
 * - If every source fails, the build exits non-zero and the previous successful
 *   Pages deployment stays online.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  CACHE_SCHEMA_VERSION,
  DIAGNOSTICS_PATH,
  ENTITY_BY_ID,
  FETCH,
  INGEST,
  SITE,
  WINDOW,
} from '../src/config.js';
import { sleep } from '../src/adapters/http.js';
import { loadNewsSource, newsSourceDefs } from '../src/adapters/news.js';
import { loadYoutubeSource, youtubeSourceDefs } from '../src/adapters/youtube.js';
import { bridgeBase, bridgeSourceDefs, loadBridgeSource } from '../src/adapters/bridge.js';
import { classify } from '../src/engine/classify.js';
import { saveDiagnostics } from '../src/engine/diagnostics.js';
import { buildSourceRows, dedupeRecords, retainPrevious } from '../src/engine/pipeline.js';
import { buildSnapshot, stableId } from '../src/engine/score.js';
import { validateCache } from '../src/engine/validate.js';
import { enrichLabels } from '../src/engine/enrich.js';

const CONTEXT_KINDS = new Set(['brand', 'team', 'series']);

/**
 * True when a record reads as a story about a watched rider. A name on its own is
 * not enough: "Pierce Brown 2026 Stats per Game" names a college football player,
 * and an obituary can carry a rider's name too.
 */
function isRiderStory(record) {
  const ids = record.entities || [];
  if (!ids.some((id) => ENTITY_BY_ID[id]?.kind === 'rider')) return false;
  if ((record.topics || []).length > 0) return true;
  if (record.region) return true;
  return ids.some((id) => CONTEXT_KINDS.has(ENTITY_BY_ID[id]?.kind));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEFAULT_OUT = resolve(ROOT, 'data/buzz-cache.json');

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

const relay = argValue('--relay') || process.env.MOTOBUZZ_RELAY || null;
const outPath = resolve(argValue('--out') || DEFAULT_OUT);
const previousPath = argValue('--previous') || outPath;
const now = Date.now();
const fetchedAt = now;
const startedAt = process.hrtime.bigint();

function log(message) {
  process.stdout.write(`${message}\n`);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readPreviousCache() {
  if (previousPath && existsSync(previousPath)) {
    try {
      const raw = JSON.parse(await readFile(previousPath, 'utf8'));
      if (raw?.schemaVersion === CACHE_SCHEMA_VERSION && Array.isArray(raw.items)) return raw;
    } catch {
      // A corrupt previous cache only costs continuity, never the build.
    }
  }
  const remote = process.env.PREVIOUS_CACHE_URL;
  if (remote) {
    try {
      const response = await fetch(remote, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) {
        const raw = await response.json();
        if (raw?.schemaVersion === CACHE_SCHEMA_VERSION && Array.isArray(raw.items)) return raw;
      }
    } catch {
      // Ignored: the build works without continuity.
    }
  }
  return null;
}

async function runSource(def, loader, extra = {}) {
  const started = Date.now();
  try {
    const outcome = await loader(def, { relay, now, fetchedAt, ...extra });
    return {
      def,
      status: outcome.status,
      error: outcome.error ?? null,
      note: outcome.note ?? null,
      records: outcome.records || [],
      diagnostic: outcome.diagnostic ?? null,
      fetchedAt,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return {
      def,
      status: 'unavailable',
      error: errorText(error),
      note: null,
      records: [],
      diagnostic: null,
      fetchedAt,
      elapsedMs: Date.now() - started,
    };
  }
}

function normalizeRecord(record) {
  const labels = classify(record);
  return {
    id: stableId(`${record.sourceId}|${record.url}`),
    sourceId: record.sourceId,
    kind: record.kind,
    title: record.title,
    summary: record.summary || null,
    url: record.url,
    publisher: record.publisher,
    publisherUrl: record.publisherUrl || null,
    channel: record.channel || null,
    publishedAt: record.publishedAt,
    fetchedAt: record.fetchedAt || fetchedAt,
    engagement: Number.isFinite(record.engagement) ? record.engagement : null,
    engagementLabel: record.engagementLabel || null,
    topics: labels.topics,
    entities: labels.entities,
    region: labels.region,
  };
}

async function main() {
  log(`MotoBuzz cache build — ${new Date(now).toISOString()}${relay ? ` via ${relay}` : ' (direct)'}`);

  const previous = await readPreviousCache();

  const newsDefs = newsSourceDefs();
  const youtubeDefs = youtubeSourceDefs();
  const bridgeDefs = bridgeSourceDefs();
  const bridgeIsConfigured = Boolean(bridgeBase());

  // Google News throttles a burst of queries and answers an empty feed instead of
  // an error, which would blank a group silently. Its queries therefore run one at
  // a time with a pause. Direct feeds and YouTube hit different hosts and stay
  // concurrent.
  const feedDefs = newsDefs.filter((def) => def.type !== 'google');
  const googleDefs = newsDefs.filter((def) => def.type === 'google');

  const concurrent = await Promise.all([
    ...feedDefs.map((def) => runSource(def, loadNewsSource)),
    ...youtubeDefs.map((def) => runSource(def, loadYoutubeSource)),
  ]);

  const googleResults = [];
  for (const [index, def] of googleDefs.entries()) {
    if (index > 0) await sleep(FETCH.googleNewsSpacingMs);
    let result = await runSource(def, loadNewsSource);
    // A throttled query can come back as an empty feed rather than an error, so a
    // group that found nothing gets one more try after a longer pause instead of
    // staying blank for the whole hour.
    if (result.records.length === 0) {
      await sleep(FETCH.googleNewsRetryMs);
      const retried = await runSource(def, loadNewsSource);
      if (retried.records.length > 0 || retried.status === 'unavailable') result = retried;
    }
    googleResults.push(result);
  }

  const bridgeResults = [];
  for (const def of bridgeDefs) {
    if (!bridgeIsConfigured) {
      bridgeResults.push({
        def,
        status: 'unconfigured',
        error: null,
        note: 'Set MOTOBUZZ_BRIDGE_URL to read this profile through your own bridge.',
        records: [],
        fetchedAt,
        elapsedMs: 0,
      });
      continue;
    }
    bridgeResults.push(await runSource(def, loadBridgeSource));
  }

  const attempts = [...concurrent, ...googleResults, ...bridgeResults];

  // --- continuity -----------------------------------------------------------
  const previousSources = new Map(
    (previous?.sources || []).filter((source) => source?.sourceId).map((source) => [source.sourceId, source]),
  );

  // Continuity must not resurrect a source that config.js no longer names: its
  // old records would otherwise keep counting until they aged out.
  const configuredSourceIds = new Set(attempts.map((attempt) => attempt.def.id));
  const { retained, retainedBySource, unconfiguredRetained } = retainPrevious(previous, {
    configuredSourceIds,
    now,
  });

  // --- collect --------------------------------------------------------------
  const ordered = [];
  let offTarget = 0;
  for (const attempt of attempts) {
    const riderQuery = attempt.def.id.startsWith('gnews-riders-');
    for (const record of attempt.records) {
      const normalized = normalizeRecord(record);
      // A rider-name query is loose at Google's end: it can answer with a story
      // that names nobody on the watchlist, or one that carries a rider's name in
      // another sport. Neither is rider coverage, so it is dropped rather than
      // shown as if a rider had been found.
      if (riderQuery && !isRiderStory(normalized)) {
        offTarget += 1;
        continue;
      }
      ordered.push(normalized);
    }
  }
  // Retained records come last so a freshly fetched copy always wins the dedupe.
  for (const item of retained) ordered.push(normalizeRecord(item));

  const { deduped, duplicates } = dedupeRecords(ordered, { now });

  // Trim to the ceiling before scoring, ranked by raw audience weight.
  const ranked = deduped
    .map((record) => ({ record, score: (record.engagement || 0) + (record.kind === 'social' ? 1 : 0) }))
    .sort((a, b) => b.record.publishedAt - a.record.publishedAt)
    .map((entry) => entry.record);

  const kept = ranked.slice(0, WINDOW.maxItems);
  const pruned = ranked.length - kept.length;

  // Optional and fail-open: it can only add topic and entity ids from config.js.
  const enrichment = await enrichLabels(kept);

  const snapshot = buildSnapshot(kept, { now });

  const items = snapshot.items;
  const itemCounts = new Map();
  for (const item of items) {
    itemCounts.set(item.sourceId, (itemCounts.get(item.sourceId) || 0) + 1);
  }

  const sources = buildSourceRows(attempts, { itemCounts, previousSources, retainedBySource });

  const liveSources = sources.filter((source) => source.status === 'live').length;
  const recordedSources = sources.filter((source) => source.recordCount > 0).length;

  const cache = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    generatedAt: now,
    site: {
      name: SITE.name,
      tagline: SITE.tagline,
      timezone: SITE.timezone,
      timezoneLabel: SITE.timezoneLabel,
      scoreHours: WINDOW.scoreHours,
      retainHours: WINDOW.retainHours,
    },
    build: {
      relay: Boolean(relay),
      bridge: bridgeIsConfigured,
      durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      sourcesAttempted: sources.length,
      sourcesLive: liveSources,
      sourcesWithRecords: recordedSources,
      liveShare: sources.length ? Number((liveSources / sources.length).toFixed(3)) : 0,
      enrichment: {
        configured: enrichment.configured,
        model: enrichment.model,
        requested: enrichment.requested,
        labelled: enrichment.labelled,
        error: enrichment.error,
      },
      duplicatesDropped: duplicates,
      riderQueryOffTarget: offTarget,
      recordsPruned: pruned,
      recordsRetained: retained.length,
      recordsKept: items.length,
      itemsPerFeed: INGEST.itemsPerFeed,
    },
    buzz: snapshot.buzz,
    threads: snapshot.threads,
    entities: snapshot.entities,
    region: snapshot.region,
    sources,
    items,
  };

  const statusWidth = 12;
  const reportSources = () => {
    log('');
    for (const source of sources) {
      const state = source.status.padEnd(statusWidth);
      const count = String(source.recordCount).padStart(3);
      const note = source.error || source.note || '';
      log(`  ${state}${count}  ${source.sourceId.padEnd(22)}${note ? `  ${note}` : ''}`);
    }
    log('');
  };

  const check = validateCache(cache, { now });
  if (!check.ok) {
    reportSources();
    log(`Cache failed its own validation: ${check.reasons.join(' ')}`);
    process.exit(1);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  const diagnostics = await saveDiagnostics(attempts, { root: ROOT, directory: DIAGNOSTICS_PATH });

  // --- report ---------------------------------------------------------------
  reportSources();
  log(`  buzz ${snapshot.buzz.score}/100 (${snapshot.buzz.label}) · ${snapshot.buzz.activeItems} active records · momentum x${snapshot.buzz.momentum}`);
  log(`  ${snapshot.buzz.headline}`);
  log(`  ${items.length} records written, ${duplicates} duplicates dropped, ${retained.length} carried from the previous cache`);
  if (offTarget > 0) {
    log(
      `  ${offTarget} rider-query record${offTarget === 1 ? '' : 's'} named no watched rider or no motocross context, dropped`,
    );
  }
  if (unconfiguredRetained > 0) {
    log(
      `  ${unconfiguredRetained} retained record${unconfiguredRetained === 1 ? '' : 's'} dropped: the source is no longer configured`,
    );
  }
  if (diagnostics.length > 0) {
    log(`  saved ${diagnostics.length} parse diagnostic${diagnostics.length === 1 ? '' : 's'} under ${DIAGNOSTICS_PATH}/`);
  }
  log(`  wrote ${outPath}`);
  if (enrichment.configured && enrichment.requested > 0) {
    const detail = enrichment.error ? ` (${enrichment.error})` : '';
    log(`  enrichment: ${enrichment.labelled}/${enrichment.requested} records labelled via ${enrichment.model}${detail}`);
  }
  log('');

  if (recordedSources === 0) {
    log('Every source failed. Keeping the previous deployment online.');
    process.exit(1);
  }
}

main().catch((error) => {
  log(`Build failed: ${errorText(error)}`);
  process.exit(1);
});
