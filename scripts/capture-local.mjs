#!/usr/bin/env node
/**
 * Capture the sources this machine can read and the runner cannot, and commit
 * the result.
 *
 * Reddit throttles datacenter traffic and Instagram answers GitHub's runners
 * with a login shell or a 429, so on most hourly builds those sources come back
 * unavailable or malformed. A home connection usually gets served normally.
 * This runs the same adapters the build runs, writes what it read under
 * snapshots/, and leaves the committing to you:
 *
 *   npm run capture              # both
 *   npm run capture:instagram    # just Instagram
 *   npm run capture:reddit       # just Reddit
 *
 *   git add snapshots/
 *   git commit -m "Capture social sources from a home connection"
 *   git push
 *
 * The push rebuilds the site, which now has real records for the sources its
 * runner cannot reach. Each capture is trusted for its configured window
 * (INSTAGRAM_CAPTURE.maxAgeHours, REDDIT_CAPTURE.maxAgeHours) and ignored after
 * that, so a stale read never passes as current.
 *
 * Set INSTAGRAM_SESSIONID in your environment first if you have a signed-in
 * cookie: the Instagram capture then reads the exact `web_profile_info` route.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FETCH, INSTAGRAM_CAPTURE, REDDIT_CAPTURE } from '../src/config.js';
import { instagramSourceDefs, loadInstagramSource } from '../src/adapters/instagram.js';
import { redditSourceDefs, loadRedditSource } from '../src/adapters/reddit.js';
import { sleep } from '../src/adapters/http.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const STATUS_WIDTH = 12;

const now = Date.now();

/** One record, in the shape the matching capture module reads back. */
function toPost(record) {
  return {
    url: record.url,
    title: record.title,
    summary: record.summary ?? null,
    publishedAt: record.publishedAt,
    dateBasis: record.dateBasis === 'day' ? 'day' : 'exact',
    likes: Number.isFinite(record.engagement) ? record.engagement : null,
    comments: Number.isFinite(record.replies) ? record.replies : null,
  };
}

/**
 * Each network names its own keys: Instagram captures are filed by handle,
 * Reddit captures by subreddit. Everything else is shared.
 */
const NETWORKS = {
  instagram: {
    path: INSTAGRAM_CAPTURE.path,
    field: 'handles',
    trustHours: INSTAGRAM_CAPTURE.maxAgeHours,
    spacingMs: 1_500,
    defs: instagramSourceDefs,
    load: loadInstagramSource,
    keyOf: (def) => def.handle,
    where: 'where Instagram served the page',
    sessionHint: 'Instagram may be refusing this connection too; a signed-in INSTAGRAM_SESSIONID is the next thing to try.',
  },
  reddit: {
    path: REDDIT_CAPTURE.path,
    field: 'subreddits',
    trustHours: REDDIT_CAPTURE.maxAgeHours,
    spacingMs: FETCH.redditSpacingMs,
    defs: redditSourceDefs,
    load: loadRedditSource,
    keyOf: (def) => def.sub,
    where: 'where Reddit answered',
    sessionHint: 'Reddit may be throttling this connection as well; try again in a few minutes.',
  },
};

function ageLabel(capturedAt) {
  const hours = Math.round((now - capturedAt) / 3_600_000);
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

async function readPrevious(name, net) {
  const path = resolve(ROOT, net.path);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return raw && typeof raw[net.field] === 'object' && raw[net.field] ? raw[net.field] : {};
  } catch {
    console.log(`  ${name}: existing ${net.path} could not be read; starting a new capture.`);
    return {};
  }
}

/** @returns {Promise<{live: number, captured: number, kept: number}>} */
async function runNetwork(name, net) {
  const previous = await readPrevious(name, net);
  const entries = { ...previous };
  const defs = net.defs();

  console.log(`  ${defs.length} ${name} source(s), ${Object.keys(previous).length > 0 ? 'merging into the committed capture' : 'starting a new capture'}`);
  console.log('');

  let live = 0;
  let captured = 0;

  for (const [index, def] of defs.entries()) {
    if (index > 0) await sleep(net.spacingMs);
    const key = net.keyOf(def).toLowerCase();
    const kept = entries[key];
    let line;

    try {
      const outcome = await net.load(def, { now, fetchedAt: now });
      if (outcome.status === 'live' && outcome.records.length > 0) {
        entries[key] = {
          capturedAt: now,
          via: outcome.snapshot?.via ?? null,
          username: outcome.snapshot?.username ?? null,
          followers: outcome.snapshot?.followers ?? null,
          posts: outcome.records.map(toPost),
        };
        live += 1;
        captured += outcome.records.length;
        line = `  ${'live'.padEnd(STATUS_WIDTH)}${String(outcome.records.length).padStart(2)}  ${net.keyOf(def)}`;
      } else {
        const detail = outcome.error || outcome.note || outcome.status;
        line =
          `  ${outcome.status.padEnd(STATUS_WIDTH)}${' 0'}  ${net.keyOf(def)}` +
          `  ${detail}${kept ? ` (keeping the read from ${ageLabel(kept.capturedAt)})` : ''}`;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      line =
        `  ${'failed'.padEnd(STATUS_WIDTH)}${' 0'}  ${net.keyOf(def)}  ${detail}` +
        `${kept ? ` (keeping the read from ${ageLabel(kept.capturedAt)})` : ''}`;
    }

    console.log(line);
  }

  const kept = Object.keys(entries).length;
  console.log('');

  if (kept === 0) {
    console.log(`  Nothing was captured, so ${net.path} was left alone.`);
    console.log(`  ${net.sessionHint}`);
    return { live, captured, kept };
  }

  const out = resolve(ROOT, net.path);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    `${JSON.stringify({ schemaVersion: 1, capturedAt: now, [net.field]: entries }, null, 2)}\n`,
    'utf8',
  );

  console.log(`  ${live}/${defs.length} ${name} source(s) read now, ${captured} post(s) this run`);
  console.log(`  ${kept} kept in ${net.path}, trusted for ${net.trustHours} h`);
  if (live === 0) console.log(`  No ${name} source answered this time. The file still holds the earlier reads.`);
  console.log('');

  return { live, captured, kept };
}

async function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const names = requested.length > 0 ? requested : Object.keys(NETWORKS);

  for (const name of names) {
    if (!NETWORKS[name]) {
      console.log(`Unknown network "${name}". Use one of: ${Object.keys(NETWORKS).join(', ')}.`);
      process.exit(2);
    }
  }

  console.log(`MotoBuzz local capture — ${new Date(now).toISOString()}`);
  console.log(`  ${names.join(' + ')}`);
  console.log('');

  const written = [];
  let totalLive = 0;

  for (const name of names) {
    const net = NETWORKS[name];
    const result = await runNetwork(name, net);
    if (result.kept > 0) written.push({ name, path: net.path, live: result.live, trustHours: net.trustHours });
    totalLive += result.live;
  }

  if (written.length === 0) {
    console.log('Nothing was captured from any source, so no snapshot was written.');
    process.exit(1);
  }

  console.log('  Commit it so the hourly build can use it:');
  console.log(`    git add ${written.map((entry) => entry.path).join(' ')}`);
  console.log('    git commit -m "Capture social sources from a home connection"');
  console.log('    git push');
  console.log('');
  console.log(
    `  Next capture: whenever you like; anything older than ${
      Math.min(...written.map((entry) => entry.trustHours))
    } h is ignored.`,
  );

  if (totalLive === 0) process.exit(1);
}

main().catch((error) => {
  console.log(`Capture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
