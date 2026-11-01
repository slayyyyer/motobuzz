/** Time and number formatting. Everything is shown in one declared time zone. */

const RELATIVE_STEPS = [
  { limit: 60_000, divisor: 1000, unit: 'second' },
  { limit: 3_600_000, divisor: 60_000, unit: 'minute' },
  { limit: 86_400_000, divisor: 3_600_000, unit: 'hour' },
  { limit: 7 * 86_400_000, divisor: 86_400_000, unit: 'day' },
  { limit: 30 * 86_400_000, divisor: 7 * 86_400_000, unit: 'week' },
];

const formatterCache = new Map();

function formatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
  }
  return formatterCache.get(timeZone);
}

export function relativeTime(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return 'unknown time';
  const delta = Math.max(0, now - timestamp);
  if (delta < 45_000) return 'just now';

  for (const step of RELATIVE_STEPS) {
    if (delta < step.limit) {
      const value = Math.max(1, Math.round(delta / step.divisor));
      return `${value} ${step.unit}${value === 1 ? '' : 's'} ago`;
    }
  }
  const months = Math.round(delta / (30 * 86_400_000));
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

export function clockTime(timestamp, timeZone) {
  if (!Number.isFinite(timestamp)) return 'unknown';
  try {
    return formatter(timeZone).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function percent(value) {
  const clamped = Math.max(0, Math.min(1, Number(value) || 0));
  return `${Math.round(clamped * 100)}%`;
}

export function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  if (number < 1000) return String(Math.round(number));
  if (number < 1_000_000) return `${(number / 1000).toFixed(number < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
