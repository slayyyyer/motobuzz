/**
 * Every upstream the local relay will ever contact.
 *
 * The list is intentionally narrow: exact origin plus a path prefix. It covers
 * the feeds and pages that do not send CORS headers, so the browser never needs
 * to talk to them. The relay runs on the GitHub Actions runner and during local
 * cache builds; the deployed page only ever reads the same-origin cache.
 */
export const ALLOWED_UPSTREAMS = Object.freeze([
  { origin: 'https://www.supercrosslive.com', pathPrefixes: ['/rss', '/feed'], label: 'Monster Energy Supercross RSS' },
  { origin: 'https://www.supermotocross.com', pathPrefixes: ['/feed/'], label: 'SuperMotocross RSS' },
  { origin: 'https://www.mxgp.com', pathPrefixes: ['/rss.xml'], label: 'MXGP RSS' },
  { origin: 'https://news.google.com', pathPrefixes: ['/rss/search'], label: 'Google News index' },
  { origin: 'https://www.reddit.com', pathPrefixes: ['/r/'], label: 'Reddit public subreddit feeds' },
  { origin: 'https://www.youtube.com', pathPrefixes: ['/@'], label: 'Public YouTube channel pages' },
]);

const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i;
const ALLOWED_PROTOCOLS = new Set(['https:']);

/**
 * @param {string} candidate
 * @param {{origin: string} | null} [bridge] Optional operator-configured RSS
 *   bridge origin (for example a self-hosted RSSHub). Never a public default.
 * @returns {{allowed: boolean, reason?: string, url?: URL, rule?: object}}
 */
export function matchUpstream(candidate, bridge = null) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { allowed: false, reason: 'Not a valid URL.' };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { allowed: false, reason: 'Only HTTPS upstreams are allowed.' };
  }
  if (url.username || url.password) {
    return { allowed: false, reason: 'Credentials in upstream URLs are not allowed.' };
  }
  if (url.port && url.port !== '443') {
    return { allowed: false, reason: 'Non-default ports are not allowed.' };
  }
  if (!url.hostname.includes('.') || IP_LITERAL.test(url.hostname)) {
    return { allowed: false, reason: 'Upstream must be a public hostname.' };
  }
  if (url.pathname.includes('..')) {
    return { allowed: false, reason: 'Unsafe upstream path.' };
  }

  const rule = ALLOWED_UPSTREAMS.find(
    (entry) => entry.origin === url.origin && entry.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix)),
  );
  if (rule) return { allowed: true, url, rule };

  if (bridge && url.origin === bridge.origin) {
    return { allowed: true, url, rule: { origin: url.origin, label: 'Operator-configured social bridge' } };
  }

  return { allowed: false, reason: 'Upstream is not on the allowlist.' };
}

export function isAllowedUpstream(candidate, bridge = null) {
  return matchUpstream(candidate, bridge).allowed;
}
