/**
 * The read side of a committed local capture.
 *
 * Some sources answer an ordinary home connection but refuse GitHub's runners:
 * Reddit throttles datacenter traffic and Instagram serves a login shell or a
 * 429. `npm run capture` runs the real adapters on the machine that is allowed
 * to read them, writes the result under snapshots/, and the build falls back to
 * that file when it cannot read the source itself.
 *
 * This module is only the shared plumbing: the file's shape, whether an entry is
 * still worth trusting, and how old it is. Each network maps posts into records
 * on its own. Nothing here trusts the file beyond its shape — a missing, empty
 * or malformed capture is null, and the live routes run exactly as they would
 * without one.
 */

/**
 * @param {unknown} raw Parsed JSON from a snapshot file.
 * @param {string} field The top-level map's name, e.g. 'handles' or 'subreddits'.
 * @returns {{capturedAt: number|null, entries: Record<string, object>}|null}
 */
export function readCaptureEntries(raw, field) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw[field];
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;

  const entries = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.posts)) continue;
    const capturedAt = Number(entry.capturedAt);
    if (!Number.isFinite(capturedAt)) continue;
    entries[String(key).toLowerCase()] = {
      ...entry,
      capturedAt,
      via: typeof entry.via === 'string' ? entry.via : null,
      posts: entry.posts,
    };
  }

  return {
    capturedAt: Number.isFinite(Number(raw.capturedAt)) ? Number(raw.capturedAt) : null,
    entries,
  };
}

/**
 * A capture older than its trust window is not used at all. A stamp slightly in
 * the future is tolerated — the script and the build can run minutes apart on
 * machines whose clocks disagree — but a wildly future-dated file is not.
 */
export function entryIsFresh(entry, now, maxAgeHours) {
  if (!entry || !Number.isFinite(entry.capturedAt)) return false;
  const age = now - entry.capturedAt;
  return age >= -60_000 && age <= maxAgeHours * 3_600_000;
}

/** "under an hour ago" / "7 h ago" / "3 d ago", for the status note. */
export function captureAgeLabel(capturedAt, now) {
  const hours = Math.max(0, Math.round((now - capturedAt) / 3_600_000));
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
