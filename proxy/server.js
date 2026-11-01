/**
 * The local static server and allowlisted relay.
 *
 * Production has no server: GitHub Actions runs this same module as a relay on
 * the runner while it builds the hourly cache, and the deployed page only reads
 * the same-origin JSON that build produced. Locally the module also serves the
 * app so the cache can be built and browsed without any other tooling.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDefaultResultOrder } from 'node:dns';
import { matchUpstream } from './allowlist.js';

// A broken IPv6 route on a runner should not take a whole build down.
setDefaultResultOrder('ipv4first');

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// An empty or zero PORT in a host environment must not mean "listen on a random port".
const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const DEADLINE_MS = 12_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const RELAY_ACCEPTED_TYPES = [
  'application/rss+xml',
  'application/atom+xml',
  'application/xml',
  'text/xml',
  'application/json',
  'text/html',
  'text/plain',
];

/** Origin of the optional operator-configured social bridge, if one is set. */
const BRIDGE = (() => {
  const raw = process.env.MOTOBUZZ_BRIDGE_URL;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
})();

function securityHeaders(res) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

function sendText(res, status, message) {
  res.statusCode = status;
  securityHeaders(res);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(`${message}\n`);
}

async function readCapped(response) {
  const chunks = [];
  let total = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_BYTES) {
      throw new Error(`Upstream exceeded ${MAX_BYTES} bytes.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function relay(target, res) {
  let current = target;
  const deadline = AbortSignal.timeout(DEADLINE_MS);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const check = matchUpstream(current, BRIDGE);
    if (!check.allowed) {
      sendText(res, 403, `Relay refused: ${check.reason}`);
      return;
    }

    const upstream = await fetch(current, {
      redirect: 'manual',
      signal: deadline,
      headers: {
        'user-agent': 'MotoBuzz/1.0 (+https://github.com/) relay',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location');
      if (!location) {
        sendText(res, 502, 'Upstream redirected without a location.');
        return;
      }
      current = new URL(location, current).href;
      continue;
    }

    const type = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type && !RELAY_ACCEPTED_TYPES.includes(type)) {
      sendText(res, 502, `Relay refused content type ${type}.`);
      return;
    }

    const body = await readCapped(upstream);
    res.statusCode = upstream.status;
    securityHeaders(res);
    res.setHeader('Content-Type', type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
    return;
  }

  sendText(res, 508, 'Too many upstream redirects.');
}

async function serveStatic(pathname, res, head) {
  const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const target = normalize(join(ROOT, relative));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    sendText(res, 403, 'Forbidden.');
    return;
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    sendText(res, 404, 'Not found.');
    return;
  }

  if (info.isDirectory()) {
    await serveStatic(join(relative, 'index.html'), res, head);
    return;
  }

  const ext = extname(target).toLowerCase();
  res.statusCode = 200;
  securityHeaders(res);
  res.setHeader('Content-Type', CONTENT_TYPES[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', info.size);
  // The page versions the cache URL per ten-minute bucket, matching Pages' cache lifetime.
  res.setHeader('Cache-Control', relative.startsWith('/data/') ? 'no-cache' : 'public, max-age=300');
  if (head) {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const head = req.method === 'HEAD';

  if (req.method !== 'GET' && !head) {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, 'Only GET and HEAD are supported.');
    return;
  }

  try {
    if (url.pathname === '/healthz') {
      sendText(res, 200, 'ok');
      return;
    }

    if (url.pathname === '/api/proxy') {
      const target = url.searchParams.get('url');
      if (!target) {
        sendText(res, 400, 'Provide ?url=<allowlisted HTTPS URL>.');
        return;
      }
      await relay(target, res);
      return;
    }

    await serveStatic(url.pathname, res, head);
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? 'Upstream deadline exceeded.' : 'Upstream request failed.';
    if (!res.headersSent) sendText(res, 504, message);
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const bridge = BRIDGE ? ` (bridge: ${BRIDGE.origin})` : '';
  console.log(`MotoBuzz relay and static server on http://${HOST}:${PORT}${bridge}`);
});

export { server };
