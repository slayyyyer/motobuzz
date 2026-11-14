/**
 * Deterministic classification: which topics a record touches, which riders,
 * brands and teams it names, and whether it reads as American or world
 * championship chatter.
 *
 * No model is involved. Every rule is a word or phrase in config.js, so the same
 * headline always produces the same labels, and the page can explain itself.
 */
import { MOTOCROSS_CONTEXT, MOTOCROSS_DOMAINS, MOTOCROSS_SOURCE_IDS, REGION_RULES, TOPICS, WATCHLIST } from '../config.js';
import { normalizeForMatch } from '../lib/text.js';

const PHRASE_GAP = '[\\s\\W_]+';

function compileAlias(alias) {
  const words = normalizeForMatch(alias).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  const body = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(PHRASE_GAP);
  return new RegExp(`(?:^|[^a-z0-9])${body}(?:$|[^a-z0-9])`, 'i');
}

/** Compiled once per process: watchlist aliases, topic keywords, region words. */
export function buildMatchers() {
  const entities = WATCHLIST.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    patterns: (entry.aliases || [entry.name]).map(compileAlias).filter(Boolean),
    contextRequired: Boolean(entry.contextRequired),
  })).filter((entry) => entry.patterns.length > 0);

  const topics = TOPICS.map((topic) => ({
    id: topic.id,
    label: topic.label,
    keywords: topic.keywords.map((keyword) => normalizeForMatch(keyword)).filter(Boolean),
  }));

  const region = {
    us: REGION_RULES.us.map((word) => normalizeForMatch(word)).filter(Boolean),
    world: REGION_RULES.world.map((word) => normalizeForMatch(word)).filter(Boolean),
  };

  const context = MOTOCROSS_CONTEXT.map(compileAlias).filter(Boolean);

  return { entities, topics, region, context };
}

const MATCHERS = buildMatchers();

/** True when the text contains a term that places it inside motocross. */
export function hasMotocrossContext(text) {
  const normalized = normalizeForMatch(text || '');
  return MATCHERS.context.some((pattern) => pattern.test(normalized));
}

const DOMAIN_SET = new Set(MOTOCROSS_DOMAINS);
const SOURCE_ID_SET = new Set(MOTOCROSS_SOURCE_IDS);

function hostOf(value) {
  if (!value) return '';
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

/**
 * True when the record comes from a known motocross outlet, identified by its
 * configured source id or the real hostname behind its publisher URL. Display
 * names are deliberately not used.
 */
export function isMotocrossOutlet(source) {
  if (typeof source === 'string') return SOURCE_ID_SET.has(source);
  if (!source || typeof source !== 'object') return false;
  if (source.sourceId && SOURCE_ID_SET.has(source.sourceId)) return true;
  const host = hostOf(source.publisherUrl) || hostOf(source.url);
  if (!host) return false;
  return [...DOMAIN_SET].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function keywordHits(text, keyword) {
  if (keyword.includes(' ')) return text.includes(keyword) ? 1 : 0;
  // Single words match as whole tokens so 'sign' does not fire inside 'design'.
  const pattern = new RegExp(`(?:^|[^a-z0-9])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`);
  return pattern.test(text) ? 1 : 0;
}

/**
 * @param {{title: string, summary?: string|null, publisher?: string|null,
 *   publisherUrl?: string|null, sourceId?: string|null, url?: string|null}} record
 * @returns {{topics: string[], entities: string[], region: 'us'|'world'|'mixed'|null}}
 */
export function classify(record) {
  const titleText = normalizeForMatch(record?.title || '');
  const fullText = normalizeForMatch(`${record?.title || ''} ${record?.summary || ''}`);

  const entityIds = [];
  // Computed once: a common-name rider needs a motocross term somewhere in the
  // story, or a publisher whose name already places it in motocross.
  const motocrossContext = hasMotocrossContext(fullText) || isMotocrossOutlet(record);
  for (const entity of MATCHERS.entities) {
    // Titles carry the weight; a name buried in a long summary is a weak mention.
    const hit = entity.patterns.some((pattern) => pattern.test(titleText) || pattern.test(fullText));
    if (hit && (!entity.contextRequired || motocrossContext)) entityIds.push(entity.id);
  }

  const scored = [];
  for (const topic of MATCHERS.topics) {
    let score = 0;
    for (const keyword of topic.keywords) {
      score += keywordHits(titleText, keyword) * 2 + keywordHits(fullText, keyword);
    }
    if (score > 0) scored.push({ id: topic.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const topics = scored.slice(0, 3).map((entry) => entry.id);

  let us = 0;
  let world = 0;
  for (const word of MATCHERS.region.us) us += keywordHits(fullText, word);
  for (const word of MATCHERS.region.world) world += keywordHits(fullText, word);

  let region = null;
  if (us > 0 && world > 0) region = us > world * 1.5 ? 'us' : world > us * 1.5 ? 'world' : 'mixed';
  else if (us > 0) region = 'us';
  else if (world > 0) region = 'world';

  return { topics, entities: entityIds, region };
}

export { MATCHERS };
