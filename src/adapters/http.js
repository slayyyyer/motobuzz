/**
 * One HTTP path for every adapter.
 *
 * When a relay is configured the request goes through the local allowlisted
 * relay, which keeps the build's upstream list identical to the one a person
 * can audit. Without a relay the adapter fetches directly on the runner, where
 * CORS never applies.
 */
import { FETCH } from '../config.js';

export class UpstreamError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'UpstreamError';
    Object.assign(this, detail);
  }
}

/** Only http(s) bodies are read, and only up to the configured ceiling. */
async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw new UpstreamError('Upstream response is larger than the ceiling.');
  }
  if (!response.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new UpstreamError('Upstream response is larger than the ceiling.');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {string} url Absolute HTTPS upstream.
 * @param {{relay?: string|null, timeoutMs?: number, maxBytes?: number,
 *          accept?: string, headers?: Record<string,string>}} [options]
 * @returns {Promise<{status: number, contentType: string, body: string, url: string}>}
 */
export async function fetchText(url, options = {}) {
  const {
    relay = null,
    timeoutMs = FETCH.timeoutMs,
    maxBytes = FETCH.maxBytes,
    accept = 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, text/html;q=0.8, */*;q=0.5',
    headers = {},
  } = options;

  const target = relay ? `${relay.replace(/\/$/, '')}/api/proxy?url=${encodeURIComponent(url)}` : url;

  let response;
  try {
    response = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': 'MotoBuzz/1.0 (+https://github.com/) cache builder',
        accept,
        'accept-language': 'en-US,en;q=0.9',
        ...headers,
      },
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new UpstreamError('Request timed out.');
    }
    throw new UpstreamError('Request failed.');
  }

  if (response.status === 403 && !relay) {
    throw new UpstreamError('Upstream refused the request (403).', { status: 403 });
  }
  if (response.status === 404) {
    throw new UpstreamError('Upstream returned 404.', { status: 404 });
  }
  if (response.status === 429) {
    throw new UpstreamError('Upstream rate limited the request (429).', { status: 429 });
  }
  if (!response.ok) {
    throw new UpstreamError(`Upstream returned HTTP ${response.status}.`, { status: response.status });
  }

  const body = await readCapped(response, maxBytes);
  return {
    status: response.status,
    contentType: (response.headers.get('content-type') || '').toLowerCase(),
    body,
    url,
  };
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
