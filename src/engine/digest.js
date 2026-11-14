/**
 * Optional titles-only digest.
 *
 * The score and the headline are measurements. This is the one place a model
 * writes prose, and it is deliberately fenced:
 *
 * - It sees only records the build already trusts: id, title, publisher,
 *   topics and entities, plus the story grouping described below. No article
 *   bodies, no summary fields.
 * - Records that cover the same event are grouped before the call, and the
 *   groups are ranked by combined weight, so the digest leads with the story
 *   the snapshot actually weighted highest rather than an arbitrary headline.
 * - It must answer with one claim per story, citing record ids from that
 *   story. Any claim citing an unknown id, no id, or ids from more than one
 *   story is trimmed; a claim with no citation is discarded.
 * - It never touches the score, the heat tables, the headline or a record.
 * - One request per build, no retry. Without a key, or after any failure, the
 *   digest is null and the rest of the page is unchanged.
 */
import { enrichmentConfig } from './enrich.js';

const MAX_RECORDS = 48;
const CLUSTER_POOL = 60;
const MAX_CLAIMS = 4;
const MIN_CLAIM_CHARS = 15;
const MAX_CLAIM_CHARS = 240;
const MAX_IDS_PER_CLAIM = 6;
const TIMEOUT_MS = 60_000;

// Words that say nothing about which event a headline covers.
const STOPWORDS = new Set(
  'a an and are as at be been being but by for from has have he her his how in into is it its not of on or over she that the their them they this to was we were what when where which who why will with you your after before about more new now out up off'.split(
    ' ',
  ),
);
const GENERIC_WORDS = new Set(
  'video pre press day report reports recap highlights watch results result news update updates gallery photos interview entry list confirmed more'.split(
    ' ',
  ),
);
// Shared words that are too common to prove two headlines are the same story.
const WEAK_WORDS = new Set(
  '2025 2026 2027 2028 supercross motocross season championship race racing world ama mxgp smx'.split(' '),
);

function titleTokens(title) {
  const words = String(title || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word) && !GENERIC_WORDS.has(word));
  return new Set(
    words.map((word) => (word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)),
  );
}

/**
 * Union records whose titles describe the same event.
 *
 * Two guards keep this from swallowing unrelated stories: similar titles must
 * share a distinctive word, and a shared entity alone is not enough unless the
 * titles also overlap. The Paris/Tallinn entry lists are the regression case:
 * they share only "2026" and "supercross", so they stay apart.
 */
function rankStories(records) {
  const pool = (records || []).slice(0, CLUSTER_POOL).map((record, index) => ({
    record,
    index,
    tokens: titleTokens(record.title),
  }));
  const parent = pool.map((_, index) => index);

  function find(index) {
    let root = index;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]];
      root = parent[root];
    }
    return root;
  }

  function union(a, b) {
    parent[find(a)] = find(b);
  }

  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const a = pool[i];
      const b = pool[j];
      const shared = [...a.tokens].filter((token) => b.tokens.has(token));
      if (shared.length === 0) continue;

      const jaccard = shared.length / (a.tokens.size + b.tokens.size - shared.length || 1);
      const sharedEntity = (a.record.entities || []).some((entity) => (b.record.entities || []).includes(entity));
      const distinctive = shared.some((token) => !WEAK_WORDS.has(token));
      if ((jaccard >= 0.4 && distinctive) || (sharedEntity && jaccard >= 0.3)) union(i, j);
    }
  }

  const groups = new Map();
  for (const entry of pool) {
    const root = find(entry.index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(entry);
  }

  return [...groups.values()]
    .map((entries) => {
      const sorted = entries.sort((a, b) => a.index - b.index).map((entry) => entry.record);
      const weight = sorted.reduce((sum, record) => sum + (Number(record.weight) || 0), 0);
      const publishers = new Set(sorted.map((record) => record.publisher)).size;
      // A story carried by several outlets is bigger than a single item of
      // similar weight; the bonus is small and only affects digest ordering.
      const score = weight + 0.05 * (sorted.length - 1) + 0.01 * (publishers - 1);
      return { records: sorted, score, first: entries[0].index };
    })
    .sort((a, b) => b.score - a.score || a.first - b.first);
}

/**
 * The model's input: records grouped by story, stories ordered by importance.
 * Every input record carries its story number and that story's coverage.
 */
export function planDigest(records) {
  const groups = rankStories(records);
  const items = [];
  const storyOf = new Map();
  const storyOrder = new Map();
  let story = 0;

  for (const group of groups) {
    if (items.length >= MAX_RECORDS) break;
    const included = [];
    for (const record of group.records) {
      if (items.length + included.length >= MAX_RECORDS) break;
      included.push(record);
    }
    if (included.length === 0) continue;

    story += 1;
    storyOrder.set(story, story - 1);
    for (const record of included) {
      items.push({
        id: record.id,
        title: record.title,
        publisher: record.publisher,
        topics: record.topics || [],
        entities: record.entities || [],
        story,
        coverage: included.length,
      });
      if (record.id) storyOf.set(record.id, story);
    }
  }

  return { items, storyOf, storyOrder, stories: story };
}

/** Backwards-compatible view of the input for callers that only want records. */
export function digestInput(records) {
  return planDigest(records).items;
}

function systemPrompt() {
  return [
    'You write a short, factual digest of motocross news from a fixed list of records.',
    'The records are already grouped into stories. All records with the same "story" number cover the same event,',
    '"coverage" is how many records that story has, and the stories are ordered by importance: story 1 is the biggest.',
    'Return 2 to 4 lines, each exactly in this form:',
    '<one-sentence claim> || <record id>,<record id>',
    'Rules:',
    '- One claim per story, in story order, leading with story 1. Do not write two claims about the same story.',
    '- Cite every record id in that story (at most 6; if a story has more than 6, cite its 6 highest-ranked records).',
    '- Do not mix records from different stories in one claim.',
    '- Every claim must be directly supported by the titles of the records it cites. Restating the shared event in plain words is a valid claim.',
    '- The ids must come from the given records. Never invent an id, name, number or fact.',
    '- Do not state a date, time, quote, injury, signing, result or cause that is not in the cited titles.',
    '- No hype, no speculation, no advice.',
    '- Return nothing at all only if no story is clear enough to paraphrase.',
    'No JSON, no bullets, no numbering, no preamble, no code fences.',
  ].join('\n');
}

/**
 * Tolerate fenced JSON, a bare array, a {claims:[...]} envelope, a short prose
 * lead-in, and the cited-line format. Returns the claims plus why parsing
 * failed, so the build report can distinguish "not JSON" from "all claims
 * rejected".
 */
export function parseDigestDetailed(text) {
  const trimmed = String(text || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  const attempts = [trimmed];
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1));

  for (const attempt of attempts) {
    let parsed;
    try {
      parsed = JSON.parse(attempt);
    } catch {
      continue;
    }
    if (typeof parsed === 'string') continue;
    const claims = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.claims) ? parsed.claims : [];
    if (claims.length > 0) {
      return {
        claims: claims.filter((claim) => claim && typeof claim === 'object'),
        reason: null,
      };
    }
  }

  // The provider may ignore JSON mode. Accept the line format as well.
  const claims = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.includes('||'))
    .map((line) => {
      const [claimText, cited] = line.split('||');
      const recordIds = cited
        .split(/[,\s]+/)
        .map((id) => id.replace(/[\[\]"'`]/g, '').trim())
        .filter(Boolean);
      return { text: claimText.trim(), recordIds };
    });

  return {
    claims,
    reason: claims.length === 0 ? 'Response was neither JSON nor cited lines.' : null,
  };
}

export function parseDigest(text) {
  return parseDigestDetailed(text).claims;
}

/**
 * Keep only claims that make sense, cite records that exist, and cover one
 * story each. With a story map, the claim is trimmed to its dominant story,
 * one claim per story survives, and claims are ordered by story importance.
 *
 * @param {object[]} rawClaims
 * @param {object[]} records Records from the same build.
 * @param {Map<string, number>} [storyOf]
 * @param {Map<number, number>} [storyOrder]
 */
export function applyDigest(rawClaims, records, storyOf = null, storyOrder = null) {
  const known = new Set((records || []).map((record) => record.id).filter(Boolean));
  const claims = [];
  const usedStories = new Set();

  for (const claim of rawClaims || []) {
    const text = typeof claim?.text === 'string' ? claim.text.trim().replace(/\s+/g, ' ') : '';
    if (text.length < MIN_CLAIM_CHARS || text.length > MAX_CLAIM_CHARS) continue;

    const cited = claim.recordIds ?? claim.record_ids ?? [];
    let ids = [
      ...new Set(
        (Array.isArray(cited) ? cited : [cited])
          .filter((id) => typeof id === 'string')
          .map((id) => id.trim())
          .filter((id) => known.has(id)),
      ),
    ];
    if (ids.length === 0) continue;

    if (storyOf?.size) {
      const counts = new Map();
      for (const id of ids) {
        const story = storyOf.get(id);
        if (story != null) counts.set(story, (counts.get(story) || 0) + 1);
      }
      const dominant = [...counts.entries()].sort(
        (a, b) => b[1] - a[1] || (storyOrder?.get(a[0]) ?? 0) - (storyOrder?.get(b[0]) ?? 0),
      )[0];
      if (!dominant || usedStories.has(dominant[0])) continue;
      usedStories.add(dominant[0]);
      ids = ids.filter((id) => storyOf.get(id) === dominant[0]).slice(0, MAX_IDS_PER_CLAIM);
    } else {
      ids = ids.slice(0, MAX_IDS_PER_CLAIM);
    }

    if (claims.some((existing) => existing.text.toLowerCase() === text.toLowerCase())) continue;
    claims.push({ text, recordIds: ids, story: storyOf?.get(ids[0]) });
  }

  if (storyOrder?.size) {
    claims.sort((a, b) => (storyOrder.get(a.story) ?? 0) - (storyOrder.get(b.story) ?? 0));
  }

  return claims.slice(0, MAX_CLAIMS).map((claim) => ({ text: claim.text, recordIds: claim.recordIds }));
}

async function postDigest({ config, items, fetchImpl, signal }) {
  const body = {
    model: config.model,
    temperature: 0,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: JSON.stringify({ records: items }) },
    ],
  };
  if (/z\.ai/i.test(config.base)) body.thinking = { type: 'disabled' };

  const response = await fetchImpl(`${config.base}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.key}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) return { ok: false, error: `Provider returned HTTP ${response.status}.` };

  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: 'Provider returned malformed JSON.' };
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: 'Provider returned no message content.' };
  }
  return { ok: true, text: content };
}

/**
 * One optional request per build. Never throws.
 *
 * @param {object[]} records Scored records, highest weight first.
 * @param {{env?: object, fetchImpl?: Function, now?: number}} [options]
 * @returns {Promise<{configured: boolean, model: string|null, digest: object|null,
 *   claimCount: number, returned: number, stories: number, error: string|null}>}
 */
export async function generateDigest(records, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const config = enrichmentConfig(env);
  const plan = planDigest(records);
  const report = {
    configured: Boolean(config),
    model: config?.model ?? null,
    digest: null,
    claimCount: 0,
    returned: 0,
    stories: plan.stories,
    error: null,
  };
  if (!config || plan.items.length === 0) return report;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const result = await postDigest({ config, items: plan.items, fetchImpl, signal: controller.signal });
    if (!result.ok) {
      report.error = result.error;
      return report;
    }
    const parsed = parseDigestDetailed(result.text);
    report.returned = parsed.claims.length;
    const claims = applyDigest(parsed.claims, plan.items, plan.storyOf, plan.storyOrder);
    if (claims.length === 0) {
      report.error =
        parsed.reason ??
        (parsed.claims.length === 0
          ? 'Model returned no claims.'
          : `All ${parsed.claims.length} returned claim(s) lacked a valid citation.`);
      return report;
    }
    report.digest = { model: config.model, generatedAt: now, claims };
    report.claimCount = claims.length;
    return report;
  } catch (error) {
    report.error =
      error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Request timed out.' : 'Request failed.';
    return report;
  } finally {
    clearTimeout(timer);
  }
}
