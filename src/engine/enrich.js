/**
 * Optional LLM labelling.
 *
 * The keyword classifier in classify.js already labels about 85% of records.
 * This pass exists for the remainder: short captions such as "Week 1" that
 * carry real chatter but no keywords.
 *
 * Settings mirror murmur's news model on purpose — same provider, same free
 * flash model, same "thinking off" flag, same single retry on 429/5xx — so both
 * projects behave the same way against the same account.
 *
 * Hard rules, because a model in a measurement pipeline is dangerous:
 * - It only ever adds topic and entity ids that already exist in config.js.
 *   Anything else the model returns is discarded.
 * - It never sets a date, an engagement number, a URL or a headline. Those stay
 *   the measurement's own business.
 * - Any failure (no key, timeout, 4xx after retry, malformed JSON) leaves the
 *   keyword labels exactly as they were. The build never depends on it.
 */
import { ENTITY_BY_ID, TOPICS } from '../config.js';

const DEFAULT_BASE = 'https://api.z.ai/api/paas/v4';
const DEFAULT_MODEL = 'glm-4.5-flash';
const MAX_RECORDS = 40;
const BATCH_SIZE = 20;
const MAX_TOPICS = 3;
const MAX_ENTITIES = 4;
const TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 1_500;

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
  const key = String(env.LLM_API_KEY || env.ZAI_API_KEY || env.NEWS_MODEL_API_KEY || '').trim();
  if (!key) return null;

  let base;
  try {
    base = new URL(String(env.LLM_API_BASE || env.NEWS_MODEL_BASE_URL || DEFAULT_BASE).trim());
  } catch {
    return null;
  }
  const loopback = base.hostname === '127.0.0.1' || base.hostname === 'localhost' || base.hostname === '::1';
  if (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:')) return null;

  return {
    key,
    base: base.href.replace(/\/$/, ''),
    model: String(env.LLM_MODEL || env.NEWS_MODEL_NAME || DEFAULT_MODEL).trim(),
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

function requestBody(config, items) {
  const body = {
    model: config.model,
    temperature: 0,
    stream: false,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: JSON.stringify({ items }) },
    ],
  };
  // Z.ai's reasoning models spend tokens thinking unless it is switched off.
  if (/z\.ai/i.test(config.base)) body.thinking = { type: 'disabled' };
  return body;
}

async function postCompletion({ config, items, fetchImpl, signal }) {
  const response = await fetchImpl(`${config.base}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.key}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(requestBody(config, items)),
    signal,
  });

  if (!response.ok) {
    return {
      ok: false,
      retryable: response.status === 429 || response.status >= 500,
      error: `Provider returned HTTP ${response.status}.`,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, retryable: false, error: 'Provider returned malformed JSON.' };
  }

  const content = data?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : '';
  if (!text) return { ok: false, retryable: false, error: 'Provider returned no message content.' };

  return { ok: true, text };
}

/**
 * @param {object[]} records Records already labelled by classify.js.
 * @param {{env?: object, fetchImpl?: Function, retryDelayMs?: number}} [options]
 * @returns {Promise<{configured: boolean, requested: number, labelled: number,
 *   model: string|null, error: string|null}>}
 */
export async function enrichLabels(
  records,
  { env = process.env, fetchImpl = fetch, retryDelayMs = RETRY_DELAY_MS } = {},
) {
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

  const all = targets.map((record) => ({ id: record.id, text: record.title }));
  const batches = [];
  for (let index = 0; index < all.length; index += BATCH_SIZE) batches.push(all.slice(index, index + BATCH_SIZE));

  const errors = [];
  for (const batch of batches) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let result = await postCompletion({ config, items: batch, fetchImpl, signal: controller.signal });
      if (!result.ok && result.retryable) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        result = await postCompletion({ config, items: batch, fetchImpl, signal: controller.signal });
      }
      if (!result.ok) {
        errors.push(result.error);
        continue;
      }
      report.labelled += applyEnrichment(targets, parseEnrichment(result.text));
    } catch (error) {
      errors.push(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Request timed out.' : 'Request failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  report.error = errors[0] ?? null;
  return report;
}
