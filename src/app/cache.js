/**
 * The browser's only network call: one same-origin JSON snapshot.
 *
 * The URL is versioned per ten-minute bucket, matching the asset cache that
 * GitHub Pages applies, so a reload cannot show a snapshot older than the last
 * deploy without re-downloading it.
 */
import { AUTO_REFRESH_MS, CACHE_URL } from '../config.js';
import { validateCache } from '../engine/validate.js';

export const CACHE_SOURCE = CACHE_URL;

export function cacheRequestUrl(now = Date.now()) {
  const url = new URL(CACHE_URL);
  url.searchParams.set('v', String(Math.floor(now / AUTO_REFRESH_MS)));
  return url.href;
}

export async function loadCache({ signal, now = Date.now() } = {}) {
  const response = await fetch(cacheRequestUrl(now), {
    cache: 'no-store',
    signal,
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Snapshot request failed (HTTP ${response.status}).`);
  }

  let raw;
  try {
    raw = await response.json();
  } catch {
    throw new Error('Snapshot was not valid JSON.');
  }

  const result = validateCache(raw, { now });
  if (!result.ok || !result.cache) {
    throw new Error(result.reasons.join(' ') || 'Snapshot was rejected by the validator.');
  }

  return { cache: result.cache, notes: result.reasons };
}
