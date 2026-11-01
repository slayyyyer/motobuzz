#!/usr/bin/env node
/**
 * Capture the Instagram watchlist from this machine and commit the result.
 *
 * GitHub's runners get a login shell or a 429 from Instagram, so the hourly build
 * cannot read the profiles. A home connection usually can. This runs the same
 * adapter the build runs, writes what it read to snapshots/instagram.json, and
 * leaves the committing to you:
 *
 *   npm run instagram:capture
 *   git add snapshots/instagram.json
 *   git commit -m "Capture Instagram from a home connection"
 *   git push
 *
 * The push rebuilds the site, which now has exact times and counts for the
 * profiles its runner cannot read. A capture is trusted for
 * INSTAGRAM_CAPTURE.maxAgeHours and ignored after that, so stale numbers never
 * pass as current.
 *
 * Set INSTAGRAM_SESSIONID in your environment first if you have a signed-in
 * cookie: the capture then reads the exact `web_profile_info` endpoint.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { INSTAGRAM_CAPTURE, INGEST } from '../src/config.js';
import { instagramSourceDefs, loadInstagramSource } from '../src/adapters/instagram.js';
import { sleep } from '../src/adapters/http.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, INSTAGRAM_CAPTURE.path);
const STATUS_WIDTH = 12;

const now = Date.now();

/** Keep only what the build needs, in the shape instagram-capture.js reads. */
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

function ageLabel(capturedAt) {
  const hours = Math.round((now - capturedAt) / 3_600_000);
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

async function readPrevious() {
  if (!existsSync(OUT)) return { handles: {} };
  try {
    const raw = JSON.parse(await readFile(OUT, 'utf8'));
    return raw && typeof raw.handles === 'object' && raw.handles ? raw : { handles: {} };
  } catch {
    return { handles: {} };
  }
}

async function main() {
  const previous = await readPrevious();
  const handles = { ...previous.handles };
  const defs = instagramSourceDefs();

  console.log(`MotoBuzz Instagram capture — ${new Date(now).toISOString()}`);
  console.log(`  ${defs.length} profile(s), ${existsSync(OUT) ? 'merging into the committed capture' : 'starting a new capture'}`);
  console.log('');

  let live = 0;
  let captured = 0;

  for (const [index, def] of defs.entries()) {
    if (index > 0) await sleep(1_500);
    const key = def.handle.toLowerCase();
    let line;

    try {
      const outcome = await loadInstagramSource(def, { now, fetchedAt: now });
      if (outcome.status === 'live' && outcome.records.length > 0) {
        handles[key] = {
          capturedAt: now,
          via: outcome.snapshot?.via ?? null,
          username: outcome.snapshot?.username ?? null,
          followers: outcome.snapshot?.followers ?? null,
          posts: outcome.records.map(toPost),
        };
        live += 1;
        captured += outcome.records.length;
        line = `  ${'live'.padEnd(STATUS_WIDTH)}${String(outcome.records.length).padStart(2)}  ${def.handle}`;
      } else {
        const kept = handles[key];
        const detail = outcome.error || outcome.note || outcome.status;
        line =
          `  ${outcome.status.padEnd(STATUS_WIDTH)}${' 0'}  ${def.handle}` +
          `  ${detail}${kept ? ` (keeping the read from ${ageLabel(kept.capturedAt)})` : ''}`;
      }
    } catch (error) {
      const kept = handles[key];
      const detail = error instanceof Error ? error.message : String(error);
      line =
        `  ${'failed'.padEnd(STATUS_WIDTH)}${' 0'}  ${def.handle}  ${detail}` +
        `${kept ? ` (keeping the read from ${ageLabel(kept.capturedAt)})` : ''}`;
    }

    console.log(line);
  }

  const keptHandles = Object.keys(handles).length;
  console.log('');

  if (keptHandles === 0) {
    console.log('Nothing was captured, so snapshots/instagram.json was left alone.');
    console.log('Instagram may be refusing this connection too; a signed-in INSTAGRAM_SESSIONID is the next thing to try.');
    process.exit(1);
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify({ schemaVersion: 1, capturedAt: now, handles }, null, 2)}\n`, 'utf8');

  console.log(`  ${live}/${defs.length} profiles read now, ${captured} post(s) this run`);
  console.log(`  ${keptHandles} handle(s) in ${INSTAGRAM_CAPTURE.path}, trusted for ${INSTAGRAM_CAPTURE.maxAgeHours} h`);
  console.log('');
  console.log('  Commit it so the hourly build can use it:');
  console.log(`    git add ${INSTAGRAM_CAPTURE.path}`);
  console.log('    git commit -m "Capture Instagram from a home connection"');
  console.log('    git push');
  console.log('');
  if (live === 0) {
    console.log('  No profile answered this time. The file still holds the earlier reads.');
    process.exit(1);
  }
  if (INGEST.instagramSpacingMs && live > 0) {
    console.log(`  Next capture: whenever you like; anything over ${INSTAGRAM_CAPTURE.maxAgeHours} h is ignored.`);
  }
}

main().catch((error) => {
  console.log(`Capture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
