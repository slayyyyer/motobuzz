/**
 * Optional LLM labelling.
 *
 * The keyword classifier in classify.js already labels about 85% of records.
 * This pass exists for the remainder: short captions such as "Week 1" that
 * carry real chatter but no keywords.
 *
 * Hard rules, because a model in a measurement pipeline is dangerous:
 * - It only ever adds topic and entity ids that already exist in config.js.
 *   Anything else the model returns is discarded.
 * - It never sets a date, an engagement number, a URL or a headline. Those stay
 *   the measurement's own business.
 * - Any failure (no key, timeout, 4xx, malformed JSON) leaves the keyword labels
 *   exactly as they were. The build never depends on it.
 * - It runs once per build, over at most MAX_RECORDS records.
 */
import { ENTITY_BY_ID, TOPICS } from '../config.js';

const DEFAULT_BASE = 'https://api.z.ai/api/paas/v4';
const DEFAULT_MODEL = 'glm-4.6';
const MAX_RECORDS = 40;
const MAX_TOPICS = 3;
const MAX_ENTITIES = 4;
const TIMEOUT_MS = 25_000;

const TOPIC_IDS = TOPICS.map((topic) => topic.id);
const ENTITY_IDS = Object.keys(ENTITY_BY_ID);
const TOPIC_SET = new Set(TOPIC_IDS);
const ENTITY_SET = new Set(ENTITY_IDS);

/** A record the keyword pass could not place at all. */
export function isUnlabelled(record) {
  return (record?.topics?.length ?? 0) === 0 && (record?.entities?.length ?? 0) === 0;
}

/**
 * Read the operator's settings. Returns null when enrichment is off or the base
 * URL is not somewhere a key should be sent: HTTPS anywhere, HTTP only on the
 * loopback interface for local testing.
 */
export function enrichmentConfig(env = process.env) {
  const key = typeof env.LLM_API_KEY === 'string' ? env.LLM_API_KEY.trim() : '';
  if (!key) return null;

  let base;
  try {
    base = new URL(String(env.LLM_API_BASE || DEFAULT_BASE).trim());
  } catch {
    return null;
  }
  const loopback = base.hostname === '127.0.0.1' || base.hostname === 'localhost' || base.hostname === '::1';
  if (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:')) return null;

  return {
    key,
    base: base.href.replace(/\/$/, ''),
    model: String(env.LLM_MODEL || DEFAULT_MODEL).trim(),
  };
}

function systemPrompt() {
  return [
    'You label short motocross headlines and social captions.',
    'Return ONLY JSON: {"results":[{"id":"<id>","topics":["<topic id>"],"entities":["<entity id>"]}]}',
    `topics must be chosen from: ${TOPIC_IDS.join(', ')}`,
    `entities must be chosen from: ${ENTITY_IDS.join(', ')}`,
    'Use only those exact ids. Omit a field when unsure. Never invent ids, names or facts. No prose, no code fences.',
  ].join('\n');
}

/** Tolerate fenced JSON and either a bare array or a {results:[...]} envelope. */
export function parseEnrichment(text) {
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
  const results = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
  return results.filter((result) => result && typeof result.id === 'string');
}

/** Apply only ids that exist in config.js; report how many records gained a label. */
export function applyEnrichment(records, results) {
  const byId = new Map(records.map((record) => [record.id, record]));
  let labelled = 0;

  for (const result of results) {
    const record = byId.get(result.id);
    if (!record || !isUnlabelled(record)) continue;

    const topics = (Array.isArray(result.topics) ? result.topics : [])
      .filter((id) => typeof id === 'string' && TOPIC_SET.has(id))
      .slice(0, MAX_TOPICS);
    const entities = (Array.isArray(result.entities) ? result.entities : [])
      .filter((id) => typeof id === 'string' && ENTITY_SET.has(id))
      .slice(0, MAX_ENTITIES);

    if (topics.length === 0 && entities.length === 0) continue;
    record.topics = [...new Set(topics)];
    record.entities = [...new Set(entities)];
    labelled += 1;
  }

  return labelled;
}

/**
 * @param {object[]} records Records already labelled by classify.js.
 * @param {{env?: object, fetchImpl?: Function}} [options]
 * @returns {Promise<{configured: boolean, requested: number, labelled: number,
 *   model: string|null, error: string|null}>}
 */
export async function enrichLabels(records, { env = process.env, fetchImpl = fetch } = {}) {
  const config = enrichmentConfig(env);
  const targets = (records || []).filter(isUnlabelled).slice(0, MAX_RECORDS);
  const report = {
    configured: Boolean(config),
    requested: targets.length,
    labelled: 0,
    model: config?.model ?? null,
    error: null,
  };
  if (!config || targets.length === 0) return report;

  const items = targets.map((record) => ({ id: record.id, text: record.title }));

  try {
    const response = await fetchImpl(`${config.base}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: JSON.stringify({ items }) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      report.error = `Provider returned HTTP ${response.status}.`;
      return report;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    report.labelled = applyEnrichment(targets, parseEnrichment(text));
    return report;
  } catch (error) {
    report.error = error?.name === 'TimeoutError' ? 'Request timed out.' : 'Request failed.';
    return report;
  }
}
