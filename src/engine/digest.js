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
    'Return ONLY JSON: {"claims":[{"text":"<one sentence>","recordIds":["<record id>"]}]}',
    'Rules:',
    '- 2 to 4 claims, each at most 240 characters.',
    '- Every claim must be directly supported by the titles of the records it cites.',
    '- recordIds must be ids from the given records. Never invent an id, name or fact.',
    '- Do not state a date, time, number, quote, injury, signing, result or cause that is not in the cited titles.',
    '- Do not repeat a claim. No hype, no speculation, no advice.',
    '- If the titles support fewer than two claims, return {"claims":[]}.',
    'No prose, no code fences.',
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

/** Tolerate fenced JSON and either a bare array or a {claims:[...]} envelope. */
export function parseDigest(text) {
  const trimmed = String(text || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const claims = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.claims) ? parsed.claims : [];
  return claims.filter((claim) => claim && typeof claim === 'object');
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

    const ids = [...new Set((Array.isArray(claim.recordIds) ? claim.recordIds : []).filter((id) => known.has(id)))].slice(
      0,
      MAX_IDS_PER_CLAIM,
    );
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
    response_format: { type: 'json_object' },
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
 *   claimCount: number, error: string|null}>}
 */
export async function generateDigest(records, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const config = enrichmentConfig(env);
  const items = digestInput(records);
  const report = {
    configured: Boolean(config),
    model: config?.model ?? null,
    digest: null,
    claimCount: 0,
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
    const claims = applyDigest(parseDigest(result.text), items);
    if (claims.length === 0) {
      report.error = 'Model returned no citable claims.';
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
