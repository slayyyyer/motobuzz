/**
 * Optional titles-only digest.
 *
 * The score and the headline are measurements. This is the one place a model
 * writes prose, and it is deliberately fenced:
 *
 * - It sees only the records the build already trusts: id, title, publisher,
 *   topics and entities. No article bodies, no summary fields.
 * - It must answer with claims that each cite record ids from that list. Any
 *   claim citing an id that is not in the cache is discarded, and a claim with
 *   no citation is discarded.
 * - It never touches the score, the heat tables, the headline or a record.
 * - One request per build, no retry. Without a key, or after any failure, the
 *   digest is null and the rest of the page is unchanged.
 *
 * The same provider settings as the labelling pass are reused, so an operator
 * only has one key to set.
 */
import { enrichmentConfig } from './enrich.js';

const MAX_RECORDS = 24;
const MAX_CLAIMS = 4;
const MIN_CLAIM_CHARS = 15;
const MAX_CLAIM_CHARS = 240;
const MAX_IDS_PER_CLAIM = 6;
const TIMEOUT_MS = 60_000;

function systemPrompt() {
  return [
    'You write a short, factual digest of motocross news from a fixed list of records.',
    'Return at most 4 lines, each exactly in this form:',
    '<one-sentence claim> || <record id>,<record id>',
    'Rules:',
    '- 1 to 4 lines, each at most 240 characters before the separator.',
    '- Use the literal separator || between the claim and its record ids.',
    '- Every claim must be directly supported by the titles of the records it cites. Restating one record title in plain words is a valid claim.',
    '- The ids must come from the given records. Never invent an id, name or fact.',
    '- Do not state a date, time, number, quote, injury, signing, result or cause that is not in the cited titles.',
    '- Do not repeat a claim. No hype, no speculation, no advice.',
    '- Return nothing at all only if no title is clear enough to paraphrase.',
    'No JSON, no bullets, no numbering, no preamble, no code fences.',
  ].join('\n');
}

/** Flatten the cache records into the only fields the model may see. */
export function digestInput(records) {
  return (records || []).slice(0, MAX_RECORDS).map((record) => ({
    id: record.id,
    title: record.title,
    publisher: record.publisher,
    topics: record.topics || [],
    entities: record.entities || [],
  }));
}

/**
 * Tolerate fenced JSON, a bare array, a {claims:[...]} envelope, and a short
 * prose lead-in before the JSON. Returns the claims plus why parsing failed,
 * so the build report can distinguish "not JSON" from "all claims rejected".
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
      const [text, cited] = line.split('||');
      const recordIds = cited
        .split(/[,\s]+/)
        .map((id) => id.replace(/[\[\]"'`]/g, '').trim())
        .filter(Boolean);
      return { text: text.trim(), recordIds };
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
 * Keep only claims that make sense and cite records that exist.
 *
 * @param {object[]} rawClaims
 * @param {object[]} records Records from the same build.
 */
export function applyDigest(rawClaims, records) {
  const known = new Set((records || []).map((record) => record.id).filter(Boolean));
  const claims = [];

  for (const claim of rawClaims || []) {
    const text = typeof claim?.text === 'string' ? claim.text.trim().replace(/\s+/g, ' ') : '';
    if (text.length < MIN_CLAIM_CHARS || text.length > MAX_CLAIM_CHARS) continue;

    const cited = claim.recordIds ?? claim.record_ids ?? [];
    const ids = [
      ...new Set(
        (Array.isArray(cited) ? cited : [cited])
          .filter((id) => typeof id === 'string')
          .map((id) => id.trim())
          .filter((id) => known.has(id)),
      ),
    ].slice(0, MAX_IDS_PER_CLAIM);
    if (ids.length === 0) continue;
    if (claims.some((existing) => existing.text.toLowerCase() === text.toLowerCase())) continue;

    claims.push({ text, recordIds: ids });
    if (claims.length === MAX_CLAIMS) break;
  }

  return claims;
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
 *   claimCount: number, returned: number, error: string|null}>}
 */
export async function generateDigest(records, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const config = enrichmentConfig(env);
  const items = digestInput(records);
  const report = {
    configured: Boolean(config),
    model: config?.model ?? null,
    digest: null,
    claimCount: 0,
    returned: 0,
    error: null,
  };
  if (!config || items.length === 0) return report;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const result = await postDigest({ config, items, fetchImpl, signal: controller.signal });
    if (!result.ok) {
      report.error = result.error;
      return report;
    }
    const parsed = parseDigestDetailed(result.text);
    report.returned = parsed.claims.length;
    const claims = applyDigest(parsed.claims, items);
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
