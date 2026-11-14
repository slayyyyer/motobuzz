#!/usr/bin/env node
/**
 * Context audit for every gated entity: riders, brands, and teams marked
 * `contextRequired`.
 *
 * Two failures are reported:
 *   - a non-motocross story (for example a Honda car review) that still counts
 *     the gated brand or team
 *   - a motocross story that names the brand or team but drops it
 *
 * The outlet check uses each record's configured source id or the hostname
 * behind its publisher URL, never the display name.
 *
 *   npm run riders:audit
 *   npm run riders:audit -- --days 90
 *   npm run riders:audit -- --local-only
 *
 * Exits 1 when either failure is found or a requested query cannot complete.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { WATCHLIST } from '../src/config.js';
import { inspectRecord } from '../src/engine/audit.js';
import { parseFeed } from '../src/adapters/feed.js';
import { normalizeForMatch } from '../src/lib/text.js';

const USER_AGENT = 'MotoBuzz/1.0 (+https://github.com/) context audit';
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

function outletLabel(record) {
  if (record.publisher) return record.publisher;
  if (record.sourceId) return record.sourceId;
  return 'unknown outlet';
}

function kindSummary(targets) {
  const counts = new Map();
  for (const target of targets) counts.set(target.kind, (counts.get(target.kind) || 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => `${count} ${kind}${count === 1 ? '' : 's'}`)
    .join(' · ');
}

async function main() {
  const days = numberArg('--days', 180, 1, 730);
  const delayMs = numberArg('--delay', 1_500, 200, 10_000);
  const localOnly = process.argv.includes('--local-only');
  const targets = WATCHLIST.filter((entry) => entry.contextRequired);

  const stats = new Map(
    targets.map((target) => [
      target.id,
      { checked: 0, kept: 0, dropped: 0, nonMx: 0, nearMiss: 0 },
    ]),
  );
  const falsePositives = [];
  const nearMisses = [];
  const failures = [];
  const seen = new Set();

  function check(record, target, origin) {
    const outcome = inspectRecord(record, target);
    if (!outcome) return;
    const key = `${target.id}|${normalizeForMatch(record.title)}`;
    if (seen.has(key)) return;
    seen.add(key);

    const counts = stats.get(target.id);
    counts.checked += 1;
    if (outcome.status === 'kept') {
      counts.kept += 1;
      return;
    }
    if (outcome.status === 'non-mx-counted') {
      counts.nonMx += 1;
      falsePositives.push({
        targetId: target.id,
        target: target.name,
        kind: target.kind,
        title: record.title,
        outlet: outletLabel(record),
        url: record.url || record.publisherUrl || '',
        origin,
      });
      return;
    }

    counts.dropped += 1;
    if (outcome.status === 'near-miss') {
      counts.nearMiss += 1;
      nearMisses.push({
        targetId: target.id,
        target: target.name,
        kind: target.kind,
        title: record.title,
        outlet: outletLabel(record),
        url: record.url || record.publisherUrl || '',
        origin,
      });
    }
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
      for (const target of targets) check(item, target, `local:${file}`);
    }
  }

  if (!localOnly) {
    for (const [index, target] of targets.entries()) {
      if (index > 0) await sleep(delayMs);
      const query = `"${target.name}" when:${days}d`;
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      let parsed;
      try {
        const response = await fetch(url, {
          headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml' },
          signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });
        if (!response.ok) {
          failures.push(`${target.name} (${target.kind}): HTTP ${response.status}`);
          continue;
        }
        parsed = parseFeed(await response.text());
      } catch (error) {
        failures.push(
          `${target.name} (${target.kind}): ${error?.name === 'AbortError' ? 'timeout' : 'request failed'}`,
        );
        continue;
      }
      if (!parsed.ok) {
        failures.push(`${target.name} (${target.kind}): ${parsed.error}`);
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
          target,
          'google-news',
        );
      }
    }
  }

  process.stdout.write(
    `Context audit — ${new Date().toISOString().slice(0, 10)} · ${localOnly ? 'local caches only' : `last ${days} days`}\n`,
  );
  process.stdout.write(
    `Gated entities: ${targets.length} (${kindSummary(targets)}) · local cache files: ${cacheFiles}\n\n`,
  );

  for (const target of targets) {
    const counts = stats.get(target.id);
    process.stdout.write(
      `${target.name.padEnd(26)} [${target.kind}] checked ${String(counts.checked).padStart(3)} · kept ${String(
        counts.kept,
      ).padStart(3)} · dropped ${String(counts.dropped).padStart(3)} · non-MX counted ${String(counts.nonMx).padStart(
        2,
      )} · MX near misses ${counts.nearMiss}\n`,
    );
  }

  if (falsePositives.length > 0) {
    process.stdout.write('\nNon-MX mentions that still counted (must be zero):\n');
    for (const entry of falsePositives) {
      process.stdout.write(`  - ${entry.target} [${entry.kind}] | ${entry.outlet} | ${entry.title}\n`);
      if (entry.url) process.stdout.write(`    ${entry.url}\n`);
      process.stdout.write(`    ${entry.origin}\n`);
    }
  } else {
    process.stdout.write('\nNo non-MX mentions counted.\n');
  }

  if (nearMisses.length > 0) {
    process.stdout.write('\nMX mentions that were dropped (near misses):\n');
    for (const entry of nearMisses) {
      process.stdout.write(`  - ${entry.target} [${entry.kind}] | ${entry.outlet} | ${entry.title}\n`);
      if (entry.url) process.stdout.write(`    ${entry.url}\n`);
      process.stdout.write(`    ${entry.origin}\n`);
    }
  } else {
    process.stdout.write('No motocross near misses.\n');
  }

  if (failures.length > 0) {
    process.stdout.write('\nQueries that could not be completed:\n');
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  }

  process.exitCode = falsePositives.length > 0 || nearMisses.length > 0 || failures.length > 0 ? 1 : 0;
}

main().catch((error) => {
  process.stdout.write(`Audit failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
