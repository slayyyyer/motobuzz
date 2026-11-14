/**
 * The published feed.
 *
 * `buzz-cache.json` is the page's contract; this turns the same records into an
 * Atom feed so the measurement can be read by something other than the page.
 * It is generated from a validated cache and never invents a field.
 */

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Feed links must be absolute; resolve a relative one against the site root. */
function absoluteUrl(value, base) {
  try {
    return new URL(String(value), base).href;
  } catch {
    return String(value ?? '');
  }
}

/**
 * @param {object} cache A cache that passed validateCache().
 * @param {{selfUrl?: string, siteUrl?: string, limit?: number}} [options]
 * @returns {string} Atom 1.0 XML.
 */
export function buildAtomFeed(cache, { selfUrl = 'feed.xml', siteUrl = 'https://motobuzz.invalid/', limit = 30 } = {}) {
  const site = absoluteUrl(siteUrl, 'https://motobuzz.invalid/');
  const self = absoluteUrl(selfUrl, site);
  const generatedAt = cache?.generatedAt ?? Date.now();
  const siteName = cache?.site?.name || 'MotoBuzz';
  const items = (cache?.items || []).slice(0, Math.max(1, limit));
  const updated = iso(generatedAt);
  const headline = cache?.buzz?.headline ? ` — ${cache.buzz.headline}` : '';

  const entries = items
    .map((item) => {
      const published = iso(item.publishedAt);
      return [
        '  <entry>',
        `    <title>${xml(item.title)}</title>`,
        `    <link rel="alternate" href="${xml(item.url)}"/>`,
        `    <id>urn:motobuzz:${xml(item.id || item.url)}</id>`,
        `    <published>${published}</published>`,
        `    <updated>${published}</updated>`,
        `    <author><name>${xml(item.publisher || siteName)}</name></author>`,
        `    <category term="${xml(item.kind)}"/>`,
        item.summary ? `    <summary>${xml(item.summary)}</summary>` : null,
        '  </entry>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${xml(siteName)}${xml(headline)}</title>`,
    `  <link rel="self" href="${xml(self)}"/>`,
    `  <link rel="alternate" href="${xml(site)}"/>`,
    `  <id>urn:motobuzz:feed</id>`,
    `  <updated>${updated}</updated>`,
    '  <author><name>MotoBuzz</name></author>',
    `  <subtitle>${xml('A measurement of published motocross chatter.')}</subtitle>`,
    entries,
    '</feed>',
    '',
  ].join('\n');
}
