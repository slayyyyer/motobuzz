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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { CACHE_SCHEMA_VERSION, FETCH, INGEST, INSTAGRAM_CAPTURE, REDDIT_CAPTURE, SITE, WINDOW } from '../src/config.js';
import { sleep } from '../src/adapters/http.js';
import { isJunkTitle, loadNewsSource, newsSourceDefs } from '../src/adapters/news.js';
import { loadRedditSource, redditSourceDefs } from '../src/adapters/reddit.js';
import { loadYoutubeSource, youtubeSourceDefs } from '../src/adapters/youtube.js';
import { instagramSourceDefs, loadInstagramSource } from '../src/adapters/instagram.js';
import { parseInstagramCapture } from '../src/adapters/instagram-capture.js';
import { parseRedditCapture } from '../src/adapters/reddit-capture.js';
import { bridgeBase, bridgeSourceDefs, loadBridgeSource } from '../src/adapters/bridge.js';
import { classify } from '../src/engine/classify.js';
import { buildSnapshot, isEligible, stableId, urlKey } from '../src/engine/score.js';
import { validateCache } from '../src/engine/validate.js';
import { enrichLabels } from '../src/engine/enrich.js';
import { titleKey } from '../src/lib/text.js';

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

/**
 * Read one committed local capture, if there is one. A missing or unreadable
 * file is not an error: the live routes simply run on their own.
 */
async function readCapture(configPath, parse) {
  const path = resolve(ROOT, configPath);
  if (!existsSync(path)) return null;
  try {
    return parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
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
      snapshot: outcome.snapshot ?? null,
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
      snapshot: null,
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
    replies: Number.isFinite(record.replies) ? record.replies : null,
    dateBasis: record.dateBasis === 'day' ? 'day' : 'exact',
    topics: labels.topics,
    entities: labels.entities,
    region: labels.region,
  };
}

/**
 * Keep the parsed rider pages next to the cache, one file per handle, so a post
 * on the site can be traced back to the page it came from. Gitignored: build
 * output, not source.
 */
async function saveSocialSnapshots(attempts) {
  const directory = resolve(ROOT, 'data/social');
  await mkdir(directory, { recursive: true });
  let saved = 0;
  for (const attempt of attempts) {
    if (!attempt.snapshot?.handle) continue;
    const payload = { sourceId: attempt.def.id, fetchedAt: attempt.fetchedAt, ...attempt.snapshot };
    await writeFile(join(directory, `${attempt.snapshot.handle}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    saved += 1;
  }
  return saved;
}

async function main() {
  log(`MotoBuzz cache build — ${new Date(now).toISOString()}${relay ? ` via ${relay}` : ' (direct)'}`);

  // The Instagram fallback needs to know which permalinks earlier runs already covered.
  const previous = await readPreviousCache();
  const seenPostCodes = new Set();
  for (const item of previous?.items ?? []) {
    const match = String(item.url || '').match(/instagram\.com\/p\/([A-Za-z0-9_-]{6,})/);
    if (match) seenPostCodes.add(match[1]);
  }

  const newsDefs = newsSourceDefs();
  const redditDefs = redditSourceDefs();
  const youtubeDefs = youtubeSourceDefs();
  const instagramDefs = instagramSourceDefs();
  const bridgeDefs = bridgeSourceDefs();
  const bridgeIsConfigured = Boolean(bridgeBase());

  // Captures made on a home connection stand in wherever the runner is refused.
  const instagramCapture = await readCapture(INSTAGRAM_CAPTURE.path, parseInstagramCapture);
  const redditCapture = await readCapture(REDDIT_CAPTURE.path, parseRedditCapture);
  for (const [label, capture, field] of [
    ['Instagram', instagramCapture, 'handles'],
    ['Reddit', redditCapture, 'subreddits'],
  ]) {
    if (!capture) continue;
    const count = Object.keys(capture[field]).length;
    const ageHours = capture.capturedAt ? Math.round((now - capture.capturedAt) / 3_600_000) : null;
    const age = ageHours === null ? '' : `, ${ageHours} h old`;
    log(`  local ${label} capture: ${count} source(s)${age}`);
  }

  // News and YouTube are independent, so they run together; Reddit is spaced out.
  const concurrent = await Promise.all([
    ...newsDefs.map((def) => runSource(def, loadNewsSource)),
    ...youtubeDefs.map((def) => runSource(def, loadYoutubeSource)),
  ]);

  const redditResults = [];
  for (const [index, def] of redditDefs.entries()) {
    if (index > 0) await sleep(FETCH.redditSpacingMs);
    redditResults.push(await runSource(def, loadRedditSource, { capture: redditCapture }));
  }

  const instagramResults = [];
  for (const def of instagramDefs) {
    instagramResults.push(await runSource(def, loadInstagramSource, { seenPostCodes, capture: instagramCapture }));
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

  const attempts = [...concurrent, ...redditResults, ...instagramResults, ...bridgeResults];

  // --- continuity -----------------------------------------------------------
  const previousSources = new Map(
    (previous?.sources || []).filter((source) => source?.sourceId).map((source) => [source.sourceId, source]),
  );

  const retainedBySource = new Map();
  const retained = [];
  if (previous) {
    for (const item of previous.items) {
      if (!isEligible(item, now)) continue;
      // A headline the denylist would reject today must not survive by being old.
      if (isJunkTitle(item.title)) continue;
      retainedBySource.set(item.sourceId, (retainedBySource.get(item.sourceId) || 0) + 1);
      retained.push(item);
    }
  }

  // --- collect --------------------------------------------------------------
  const ordered = [];
  for (const attempt of attempts) {
    for (const record of attempt.records) ordered.push(normalizeRecord(record));
  }
  // Retained records come last so a freshly fetched copy always wins the dedupe.
  for (const item of retained) ordered.push(normalizeRecord(item));

  const seenUrls = new Set();
  const seenTitles = new Set();
  const deduped = [];
  let duplicates = 0;

  for (const record of ordered) {
    if (!isEligible(record, now)) continue;
    const byUrl = urlKey(record.url);
    const byTitle = titleKey(record.title);
    if (seenUrls.has(byUrl) || (byTitle && seenTitles.has(byTitle))) {
      duplicates += 1;
      continue;
    }
    seenUrls.add(byUrl);
    if (byTitle) seenTitles.add(byTitle);
    deduped.push(record);
  }

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

  const sources = attempts.map((attempt) => {
    const prior = previousSources.get(attempt.def.id);
    const count = itemCounts.get(attempt.def.id) || 0;
    const failed = attempt.status === 'unavailable' || attempt.status === 'malformed';
    const carried = failed && (retainedBySource.get(attempt.def.id) || 0) > 0;
    // A source that answered but had nothing inside the retention window is empty, not live.
    const emptied = attempt.status === 'live' && count === 0;
    return {
      sourceId: attempt.def.id,
      label: attempt.def.label,
      provider: attempt.def.provider,
      homepage: attempt.def.homepage,
      kind: attempt.def.kind,
      status: carried ? 'cached' : emptied ? 'empty' : attempt.status,
      error: attempt.error,
      note: emptied ? 'Answered, but nothing landed inside the retention window.' : attempt.note,
      fetchedAt: attempt.fetchedAt,
      lastSuccessAt: attempt.status === 'live' ? attempt.fetchedAt : prior?.lastSuccessAt ?? null,
      recordCount: count,
    };
  });

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
      instagramCapture: instagramCapture
        ? { handles: Object.keys(instagramCapture.handles).length, capturedAt: instagramCapture.capturedAt }
        : null,
      redditCapture: redditCapture
        ? { subreddits: Object.keys(redditCapture.subreddits).length, capturedAt: redditCapture.capturedAt }
        : null,
      durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      sourcesAttempted: sources.length,
      sourcesLive: liveSources,
      sourcesWithRecords: recordedSources,
      enrichment: {
        configured: enrichment.configured,
        model: enrichment.model,
        requested: enrichment.requested,
        labelled: enrichment.labelled,
        error: enrichment.error,
      },
      duplicatesDropped: duplicates,
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
  const snapshotsSaved = await saveSocialSnapshots(attempts);

  // --- report ---------------------------------------------------------------
  reportSources();
  log(`  buzz ${snapshot.buzz.score}/100 (${snapshot.buzz.label}) · ${snapshot.buzz.activeItems} active records · momentum x${snapshot.buzz.momentum}`);
  log(`  ${snapshot.buzz.headline}`);
  log(`  ${items.length} records written, ${duplicates} duplicates dropped, ${retained.length} carried from the previous cache`);
  log(`  wrote ${outPath}`);
  if (enrichment.configured && enrichment.requested > 0) {
    const detail = enrichment.error ? ` (${enrichment.error})` : '';
    log(`  enrichment: ${enrichment.labelled}/${enrichment.requested} records labelled via ${enrichment.model}${detail}`);
  }
  if (snapshotsSaved > 0) log(`  saved ${snapshotsSaved} Instagram page snapshots under data/social/`);
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
