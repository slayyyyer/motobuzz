/**
 * Small text helpers shared by the build (Node) and the page (browser).
 * Nothing here is allowed to reach for a runtime dependency.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  ouml: 'ö',
  uuml: 'ü',
  auml: 'ä',
  oslash: 'ø',
  aring: 'å',
  eacute_: 'é',
};

export function decodeEntities(input) {
  if (!input) return '';
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name) => {
      const key = name.toLowerCase();
      return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
    });
}

function safeFromCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

export function stripTags(input) {
  if (!input) return '';
  return decodeEntities(String(input).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeForMatch(input) {
  if (!input) return '';
  return String(input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A stable identity for a headline, used to drop the same story seen twice. */
export function titleKey(input) {
  return normalizeForMatch(input).replace(/\s+/g, ' ').slice(0, 160);
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/** Only HTTPS links survive; anything else is dropped rather than rewritten. */
export function httpsUrl(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function truncate(input, max = 180) {
  const text = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Parse `NN views`, `1.2K views`, `3M views` into a number. */
export function parseCount(text) {
  if (!text) return null;
  const source = String(text);
  const match = source
    .replace(/,/g, '')
    .match(/(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const word = source.toLowerCase().match(/\b(thousand|million|billion)\b/)?.[1];
  const scale =
    { k: 1e3, m: 1e6, b: 1e9 }[(match[2] || '').toLowerCase()] ||
    { thousand: 1e3, million: 1e6, billion: 1e9 }[word] ||
    1;
  return Math.round(value * scale);
}

const RELATIVE_UNITS = {
  second: 1 / 3600,
  minute: 1 / 60,
  hour: 1,
  day: 24,
  week: 24 * 7,
  month: 24 * 30,
  year: 24 * 365,
};

/** YouTube's compact form: 12s, 5m, 3h, 2d, 1w, 4mo, 2y. */
const SHORT_UNITS = {
  s: 1 / 3600,
  m: 1 / 60,
  h: 1,
  d: 24,
  w: 24 * 7,
  mo: 24 * 30,
  y: 24 * 365,
};

/** `2 days ago` / `Streamed 3 hours ago` → milliseconds before `now`. */
export function parseRelativeTime(text, now) {
  if (!text) return null;
  const match = String(text)
    .toLowerCase()
    .match(/(\d+)\s*(mo|seconds?|minutes?|hours?|days?|weeks?|months?|years?|[smhdwy])\s*ago/);
  if (!match) return null;
  const unit = match[2];
  const perUnit = SHORT_UNITS[unit] ?? RELATIVE_UNITS[unit.replace(/s$/, '')];
  if (!Number.isFinite(perUnit)) return null;
  const hours = Number(match[1]) * perUnit;
  if (!Number.isFinite(hours)) return null;
  return now - hours * 3_600_000;
}
