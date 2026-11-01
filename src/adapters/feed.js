/**
 * A tolerant RSS 2.0 / Atom / RDF reader.
 *
 * It is deliberately small: it pulls the fields this project uses, keeps a
 * structural verdict (feed / empty / malformed) separate from the records, and
 * never throws on bad markup. A feed that returns an HTML error page is
 * malformed, not empty.
 */
import { decodeEntities, stripTags, truncate } from '../lib/text.js';

function pick(block, ...tags) {
  for (const tag of tags) {
    const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
    const match = block.match(pattern);
    if (match) {
      const value = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
      if (value) return value;
    }
  }
  return '';
}

function pickAttr(block, tag, attr) {
  const pattern = new RegExp(`<${tag}\\s[^>]*${attr}\\s*=\\s*"([^"]*)"[^>]*>`, 'i');
  return block.match(pattern)?.[1] || '';
}

function atomLink(block) {
  const alternate = block.match(/<link\b[^>]*rel\s*=\s*"alternate"[^>]*href\s*=\s*"([^"]+)"/i);
  if (alternate) return decodeEntities(alternate[1]);
  const byHref = block.match(/<link\b[^>]*href\s*=\s*"([^"]+)"/i);
  if (byHref) return decodeEntities(byHref[1]);
  return decodeEntities(pick(block, 'link'));
}

export function parseDate(raw) {
  if (!raw) return null;
  const value = decodeEntities(String(raw).trim());
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  // Some feeds use an RFC 822 offset style that Date.parse dislikes.
  const withZone = Date.parse(`${value} GMT`);
  return Number.isFinite(withZone) ? withZone : null;
}

/**
 * @param {string} body Raw response body.
 * @returns {{ok: boolean, isEmpty: boolean, error: string|null, kind: string, items: object[]}}
 */
export function parseFeed(body) {
  const text = String(body || '');
  if (!text.trim()) {
    return { ok: false, isEmpty: false, error: 'Empty response body.', kind: 'unknown', items: [] };
  }

  const head = text.slice(0, 4000);
  if (!/<(rss|feed|rdf:RDF)\b/i.test(head)) {
    const html = /<html[\s>]/i.test(head);
    return {
      ok: false,
      isEmpty: false,
      error: html ? 'Response was an HTML page, not a feed.' : 'Response was not XML.',
      kind: 'unknown',
      items: [],
    };
  }

  const isAtom = /<feed\b/i.test(head) && !/<rss\b/i.test(head);
  const kind = isAtom ? 'atom' : 'rss';
  const blockPattern = isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi;
  const blocks = text.match(blockPattern) || [];

  const items = [];
  for (const block of blocks) {
    const title = truncate(stripTags(pick(block, 'title')), 240);
    const link = isAtom
      ? atomLink(block)
      : decodeEntities(pick(block, 'link') || pickAttr(block, 'link', 'href'));
    const publishedRaw = pick(block, 'pubDate', 'published', 'dc:date', 'updated', 'date');
    const summary = truncate(stripTags(pick(block, 'description', 'summary', 'content:encoded', 'content')), 320);
    const guid = stripTags(pick(block, 'guid', 'id')) || link;
    const sourceName = stripTags(pick(block, 'source'));
    const sourceUrl = pickAttr(block, 'source', 'url');
    const authorName = stripTags(pick(block, 'dc:creator', 'author')) || '';
    const views = pickAttr(block, 'media:statistics', 'views');

    if (!title || !link) continue;

    items.push({
      title,
      link,
      summary: summary || null,
      publishedAt: parseDate(publishedRaw),
      guid: guid || null,
      sourceName: sourceName || null,
      sourceUrl: sourceUrl ? decodeEntities(sourceUrl) : null,
      author: authorName || null,
      views: views ? Number(views) : null,
    });
  }

  if (blocks.length === 0) {
    return { ok: true, isEmpty: true, error: null, kind, items: [] };
  }
  if (items.length === 0) {
    return { ok: false, isEmpty: false, error: 'Feed items were missing a title or link.', kind, items: [] };
  }

  return { ok: true, isEmpty: false, error: null, kind, items };
}
