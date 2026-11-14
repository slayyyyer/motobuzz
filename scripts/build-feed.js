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

/**
 * Feed links have to be absolute. The deployed origin comes from
 * MOTOBUZZ_SITE_URL when it is set, otherwise from the Actions repository, and
 * falls back to the local server for a laptop run.
 */
function siteUrl() {
  const explicit = process.env.MOTOBUZZ_SITE_URL;
  if (explicit) return new URL(explicit).href.replace(/\/?$/, '/');

  const repo = process.env.GITHUB_REPOSITORY;
  if (repo && repo.includes('/')) {
    const [owner, name] = repo.split('/');
    return name.toLowerCase() === `${owner.toLowerCase()}.github.io`
      ? `https://${owner}.github.io/`
      : `https://${owner}.github.io/${name}/`;
  }

  return 'http://127.0.0.1:8080/';
}

async function main() {
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  const site = siteUrl();
  const xml = buildAtomFeed(cache, { selfUrl: new URL('feed.xml', site).href, siteUrl: site });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, xml, 'utf8');
  process.stdout.write(`wrote ${outPath} (${(cache.items || []).length} records in the cache)\n`);
}

main().catch((error) => {
  process.stdout.write(`Feed build failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
