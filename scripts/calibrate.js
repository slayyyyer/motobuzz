#!/usr/bin/env node
/**
 * Read-only calibration report.
 *
 * Recomputes the score for every stored cache using only sources that are still
 * configured, then prints the energy distribution, which band each reading
 * lands in, and the saturation constant that would put the median at 50. It
 * fetches nothing and writes nothing; it exists so BUZZ.saturationEnergy can be
 * re-derived from evidence instead of taste.
 *
 *   npm run calibrate            # every JSON cache in data/
 *   node scripts/calibrate.js path/to/cache.json
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { BUZZ } from '../src/config.js';
import { newsSourceDefs } from '../src/adapters/news.js';
import { youtubeSourceDefs } from '../src/adapters/youtube.js';
import { bridgeSourceDefs } from '../src/adapters/bridge.js';
import { buildSnapshot } from '../src/engine/score.js';

const configured = new Set(
  [...newsSourceDefs(), ...youtubeSourceDefs(), ...bridgeSourceDefs()].map((def) => def.id),
);

function cacheFiles(argv) {
  if (argv.length > 0) return argv.map((entry) => resolve(entry));
  return readdir('data')
    .then((names) => names.filter((name) => name.endsWith('.json')).map((name) => resolve('data', name)))
    .catch(() => []);
}

async function main() {
  const files = await cacheFiles(process.argv.slice(2));
  const rows = [];

  for (const file of files) {
    let cache;
    try {
      cache = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(cache.items) || !Number.isFinite(cache.generatedAt)) continue;

    const kept = cache.items.filter((item) => configured.has(item.sourceId));
    const snapshot = buildSnapshot(kept, { now: cache.generatedAt });
    rows.push({
      at: new Date(cache.generatedAt).toISOString().slice(0, 13),
      file: file.split(/[\\/]/).pop(),
      energy: snapshot.buzz.energy,
      score: snapshot.buzz.score,
      label: snapshot.buzz.label,
      active: snapshot.buzz.activeItems,
      news: snapshot.buzz.counts.news,
      social: snapshot.buzz.counts.social,
      dropped: cache.items.length - kept.length,
    });
  }

  if (rows.length === 0) {
    process.stdout.write('No caches found. Build one first, or pass a path.\n');
    return;
  }

  rows.sort((a, b) => a.at.localeCompare(b.at));
  process.stdout.write('when          energy score label          active news social dropped  file\n');
  for (const row of rows) {
    process.stdout.write(
      `${row.at}  ${String(row.energy).padStart(6)} ${String(row.score).padStart(5)} ${row.label.padEnd(14)} ${String(
        row.active,
      ).padStart(6)} ${String(row.news).padStart(4)} ${String(row.social).padStart(6)} ${String(row.dropped).padStart(7)}  ${
        row.file
      }\n`,
    );
  }

  const energies = rows.map((row) => row.energy).sort((a, b) => a - b);
  const median = energies[Math.floor(energies.length / 2)];
  const mean = energies.reduce((sum, value) => sum + value, 0) / energies.length;
  const suggested = median / Math.LN2;
  const medianScore = Math.round(100 * (1 - Math.exp(-median / BUZZ.saturationEnergy)));
  const band = [...BUZZ.bands].reverse().find((entry) => medianScore >= entry.min);

  process.stdout.write(
    `\nn ${energies.length} · min ${energies[0]} · median ${median} · mean ${mean.toFixed(2)} · max ${energies.at(-1)}\n`,
  );
  process.stdout.write(
    `current saturationEnergy ${BUZZ.saturationEnergy} puts the median at ${medianScore}/100 (${band ? band.label : 'unknown'})\n`,
  );
  process.stdout.write(
    `saturationEnergy ${suggested.toFixed(1)} would put this sample's median at 50, which is not a target:\n`,
  );
  process.stdout.write('matching an off-season sample to the middle of the scale pushes ordinary days into the hot bands.\n');
  process.stdout.write('Re-run with a race weekend included before changing the constant.\n');
}

main().catch((error) => {
  process.stdout.write(`Calibration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
