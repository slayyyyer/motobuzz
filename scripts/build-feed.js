#!/usr/bin/env node
/**
 * Write dist/feed.xml from the cache the build just wrote.
 *
 * Run after the cache exists and after dist/ has been assembled. It reads
 * data/buzz-cache.json only; nothing is fetched.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import { buildAtomFeed } from '../src/engine/feed.js';

const cachePath = resolve(process.argv[2] || 'data/buzz-cache.json');
const outPath = resolve(process.argv[3] || 'dist/feed.xml');

async function main() {
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  const xml = buildAtomFeed(cache, { selfUrl: 'feed.xml', siteUrl: './' });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, xml, 'utf8');
  process.stdout.write(`wrote ${outPath} (${(cache.items || []).length} records in the cache)\n`);
}

main().catch((error) => {
  process.stdout.write(`Feed build failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
