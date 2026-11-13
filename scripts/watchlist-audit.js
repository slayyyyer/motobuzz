#!/usr/bin/env node
/**
 * Read-only watchlist audit.
 *
 * Reads a built cache and reports two things a person should look at:
 *   - riders on the watchlist with no mentions in the records that survive;
 *   - capitalized names in headlines that are not on the watchlist, ranked by
 *     how many records mention them.
 *
 * The candidate list is a prompt for review, not an automatic edit: the name
 * extractor cannot tell a rider from a venue, a sponsor, or a headline's first
 * words.
 *
 *   npm run watchlist:audit
 *   node scripts/watchlist-audit.js data/buzz-cache.json
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { RIDERS, WATCHLIST } from '../src/config.js';
import { normalizeForMatch } from '../src/lib/text.js';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'but', 'for', 'from', 'with', 'after', 'before', 'this', 'that', 'these', 'those',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february',
  'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'round', 'main', 'event', 'race', 'report', 'results', 'video', 'watch', 'official', 'breaking',
  'monster', 'energy', 'supercross', 'motocross', 'championship', 'world', 'ama', 'fim', 'mxgp',
]);

const NAME = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2})\b/g;

const watched = new Set(
  WATCHLIST.flatMap((entry) => [entry.name, ...(entry.aliases || [])]).map((name) => normalizeForMatch(name)),
);

async function main() {
  const path = resolve(process.argv[2] || 'data/buzz-cache.json');
  const cache = JSON.parse(await readFile(path, 'utf8'));
  const items = Array.isArray(cache.items) ? cache.items : [];

  const mentions = new Map();
  for (const item of items) {
    for (const id of item.entities || []) mentions.set(id, (mentions.get(id) || 0) + 1);
  }

  const quiet = RIDERS.filter((rider) => (mentions.get(rider.id) || 0) === 0);

  const candidates = new Map();
  for (const item of items) {
    const title = String(item.title || '');
    for (const match of title.matchAll(NAME)) {
      const name = match[1].trim();
      const normalized = normalizeForMatch(name);
      if (watched.has(normalized)) continue;
      const words = normalized.split(' ').filter(Boolean);
      if (words.some((word) => STOP_WORDS.has(word))) continue;
      candidates.set(name, (candidates.get(name) || 0) + 1);
    }
  }

  const ranked = [...candidates.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]);

  process.stdout.write(`Audit of ${path} · ${items.length} records\n\n`);
  process.stdout.write(`Riders with no mention (${quiet.length} of ${RIDERS.length}):\n`);
  process.stdout.write(
    quiet.length ? `${quiet.map((rider) => rider.name).join(', ')}\n\n` : 'none\n\n',
  );
  process.stdout.write('Names in headlines that are not watched (count > 1, review by hand):\n');
  process.stdout.write(
    ranked.length ? `${ranked.slice(0, 25).map(([name, count]) => `  ${String(count).padStart(3)}  ${name}`).join('\n')}\n` : 'none\n',
  );
}

main().catch((error) => {
  process.stdout.write(`Audit failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
