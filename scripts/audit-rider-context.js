#!/usr/bin/env node
/**
 * Rider-context audit.
 *
 * Every rider marked `contextRequired` is checked against recent headlines. A
 * near miss is a story that names the rider, comes from a real motocross outlet
 * (or contains a motocross term), and yet is classified without that rider.
 * That is the failure mode that would silently remove legitimate coverage.
 *
 * The outlet check uses the record's configured source id or the hostname
 * behind its publisher URL, never the display name.
 *
 *   npm run riders:audit
 *   npm run riders:audit -- --days 90
 *   npm run riders:audit -- --local-only
 *
 * Exits 1 when it finds a near miss or cannot complete a requested query.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { RIDERS } from '../src/config.js';
import { classify, hasMotocrossContext, isMotocrossOutlet } from '../src/engine/classify.js';
import { parseFeed } from '../src/adapters/feed.js';
import { normalizeForMatch } from '../src/lib/text.js';

const USER_AGENT = 'MotoBuzz/1.0 (+https://github.com/) rider audit';
const QUERY_TIMEOUT_MS = 20_000;

function numberArg(name, fallback, min, max) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aliasesFor(rider) {
  return (rider.aliases || [rider.name]).map((alias) => normalizeForMatch(alias)).filter(Boolean);
}

function hasName(title, aliases) {
  const normalized = normalizeForMatch(title || '');
  return aliases.some((alias) => normalized.includes(alias));
}

function outletLabel(record) {
  if (record.publisher) return record.publisher;
  if (record.sourceId) return record.sourceId;
  return 'unknown outlet';
}

async function main() {
  const days = numberArg('--days', 180, 1, 730);
  const delayMs = numberArg('--delay', 900, 200, 10_000);
  const localOnly = process.argv.includes('--local-only');
  const riders = RIDERS.filter((rider) => rider.contextRequired);
  const aliases = new Map(riders.map((rider) => [rider.id, aliasesFor(rider)]));

  const checked = new Map(riders.map((rider) => [rider.id, 0]));
  const kept = new Map(riders.map((rider) => [rider.id, 0]));
  const dropped = new Map(riders.map((rider) => [rider.id, 0]));
  const nearMisses = [];
  const failures = [];
  const seen = new Set();

  function check(record, rider, origin) {
    if (!hasName(record.title, aliases.get(rider.id))) return;
    const key = `${rider.id}|${normalizeForMatch(record.title)}`;
    if (seen.has(key)) return;
    seen.add(key);
    checked.set(rider.id, checked.get(rider.id) + 1);

    const labels = classify(record);
    if (labels.entities.includes(rider.id)) {
      kept.set(rider.id, kept.get(rider.id) + 1);
      return;
    }

    dropped.set(rider.id, dropped.get(rider.id) + 1);
    const context = hasMotocrossContext(`${record.title || ''} ${record.summary || ''}`);
    if (!context && !isMotocrossOutlet(record)) return;

    nearMisses.push({
      rider: rider.name,
      title: record.title,
      outlet: outletLabel(record),
      url: record.url || record.publisherUrl || '',
      origin,
      reason: context ? 'motocross wording' : 'motocross outlet',
    });
  }

  let cacheFiles = 0;
  for (const file of (await readdir('data')).filter((entry) => entry.endsWith('.json'))) {
    let cache;
    try {
      cache = JSON.parse(await readFile(join('data', file), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(cache.items)) continue;
    cacheFiles += 1;
    for (const item of cache.items) {
      for (const rider of riders) check(item, rider, `local:${file}`);
    }
  }

  if (!localOnly) {
    for (const [index, rider] of riders.entries()) {
      if (index > 0) await sleep(delayMs);
      const query = `"${rider.name}" when:${days}d`;
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      let parsed;
      try {
        const response = await fetch(url, {
          headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml' },
          signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });
        if (!response.ok) {
          failures.push(`${rider.name}: HTTP ${response.status}`);
          continue;
        }
        parsed = parseFeed(await response.text());
      } catch (error) {
        failures.push(`${rider.name}: ${error?.name === 'AbortError' ? 'timeout' : 'request failed'}`);
        continue;
      }
      if (!parsed.ok) {
        failures.push(`${rider.name}: ${parsed.error}`);
        continue;
      }
      for (const item of parsed.items) {
        check(
          {
            title: item.title,
            summary: item.summary,
            publisher: item.sourceName,
            publisherUrl: item.sourceUrl,
            url: item.link,
          },
          rider,
          'google-news',
        );
      }
    }
  }

  process.stdout.write(
    `Rider context audit — ${new Date().toISOString().slice(0, 10)} · ${localOnly ? 'local caches only' : `last ${days} days`}\n`,
  );
  process.stdout.write(`Gated riders: ${riders.length} · local cache files: ${cacheFiles}\n\n`);

  for (const rider of riders) {
    process.stdout.write(
      `${rider.name.padEnd(18)} checked ${String(checked.get(rider.id)).padStart(3)} · kept ${String(
        kept.get(rider.id),
      ).padStart(3)} · dropped ${String(dropped.get(rider.id)).padStart(3)} · MX near misses ${
        nearMisses.filter((entry) => entry.rider === rider.name).length
      }\n`,
    );
  }

  if (nearMisses.length > 0) {
    process.stdout.write('\nNear misses (legitimate motocross coverage classified without the rider):\n');
    for (const entry of nearMisses) {
      process.stdout.write(`  - ${entry.rider} | ${entry.outlet} | ${entry.title}\n`);
      if (entry.url) process.stdout.write(`    ${entry.url}\n`);
      process.stdout.write(`    matched context: ${entry.reason} (${entry.origin})\n`);
    }
  } else {
    process.stdout.write('\nNo motocross near misses.\n');
  }

  if (failures.length > 0) {
    process.stdout.write('\nQueries that could not be completed:\n');
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  }

  process.exitCode = nearMisses.length > 0 || failures.length > 0 ? 1 : 0;
}

main().catch((error) => {
  process.stdout.write(`Audit failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
