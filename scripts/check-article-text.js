#!/usr/bin/env node
/**
 * Read-only article-text survey.
 *
 * Answers one question: if the build wanted to read article bodies, which
 * outlets would actually serve them? It fetches a sample of the records in a
 * cache with the same user agent the build uses, follows Google News redirects,
 * extracts paragraph text, and reports what came back.
 *
 * It writes nothing and changes nothing. It is deliberately polite: one request
 * per URL, a pause between requests, a size cap and no retries.
 *
 *   node scripts/check-article-text.js data/live-cache.json
 *   node scripts/check-article-text.js --max 30 --per-publisher 3
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { FEEDS } from '../src/config.js';
import { parseFeed } from '../src/adapters/feed.js';

const USER_AGENT = 'MotoBuzz/1.0 (+https://github.com/) cache builder';
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 20_000;
const PAUSE_MS = 700;

// Phrases that mean the body we got is a shell rather than the report.
const PAYWALL_SIGNALS = [
  /subscribe to continue/i,
  /already a subscriber/i,
  /this (article|story) is (only )?for subscribers/i,
  /sign in to (continue|read)/i,
  /enable javascript (to|and) (view|read)/i,
  /before you continue/i,
  /manage (your )?(privacy )?consent/i,
];

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function textOnly(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readArticle(html) {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');

  const paragraphs = [...cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => textOnly(match[1]))
    .filter((text) => text.split(' ').length >= 5);

  const words = paragraphs.join(' ').split(/\s+/).filter(Boolean);
  const signals = PAYWALL_SIGNALS.filter((pattern) => pattern.test(cleaned)).map((pattern) => pattern.source);
  return {
    bodyWords: words.length,
    paragraphs: paragraphs.length,
    paywall: signals.length > 0,
    paywallSignals: signals,
    opening: words.slice(0, 24).join(' '),
  };
}

/** Follow a Google News redirect (and any other) while capping the read. */
async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const finalUrl = response.url || url;
    if (!response.ok) {
      return { ok: false, status: response.status, finalUrl, words: 0, paragraphs: 0, paywall: false, signals: [] };
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) {
      return { ok: false, status: response.status, finalUrl, words: 0, paragraphs: 0, paywall: false, signals: ['oversized'], oversized: true };
    }
    const html = (await response.text()).slice(0, MAX_BYTES);
    const article = readArticle(html);
    return {
      ok: true,
      status: response.status,
      finalUrl,
      ...article,
      words: article.bodyWords,
      signals: article.paywallSignals,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      words: 0,
      paragraphs: 0,
      paywall: false,
      signals: [error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'fetch failed'],
    };
  } finally {
    clearTimeout(timer);
  }
}

function verdict(result) {
  if (!result.ok) return `HTTP ${result.status || 'error'}`;
  try {
    if (new URL(result.finalUrl).hostname.endsWith('news.google.com')) return 'google shell';
  } catch {
    // Fall through to the text checks.
  }
  if (result.paywall) return 'paywall/consent';
  if (result.bodyWords < 120 || result.paragraphs < 2) return 'thin';
  return 'readable';
}

/** The direct feeds are the only article links the build itself could follow. */
async function directArticles(perFeed) {
  const articles = [];
  for (const feed of FEEDS) {
    try {
      const response = await fetch(feed.url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const parsed = parseFeed(await response.text());
      if (!parsed.ok || parsed.isEmpty) continue;
      for (const item of parsed.items.slice(0, perFeed)) {
        if (item.link) articles.push({ publisher: `${feed.label} (direct)`, url: item.link });
      }
    } catch {
      // A feed that cannot be read is itself a result, but it is not an article.
    }
    await sleep(PAUSE_MS);
  }
  return articles;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function main() {
  const cachePath = process.argv.find((entry) => entry.endsWith('.json')) || 'data/live-cache.json';
  const cache = JSON.parse(await readFile(resolve(cachePath), 'utf8'));
  const max = arg('--max', 24);
  const perPublisher = arg('--per-publisher', 2);
  const perFeed = arg('--per-feed', 2);

  const seen = new Set();
  const selected = [];
  const counts = new Map();
  for (const item of cache.items || []) {
    if (!item.url || !/^https:/.test(item.url)) continue;
    const publisher = item.publisher || 'Unknown';
    if ((counts.get(publisher) || 0) >= perPublisher) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    counts.set(publisher, (counts.get(publisher) || 0) + 1);
    selected.push(item);
    if (selected.length >= max) break;
  }

  const direct = await directArticles(perFeed);
  for (const article of direct) {
    if (seen.has(article.url)) continue;
    seen.add(article.url);
    selected.push(article);
  }

  process.stdout.write(`Article text survey — ${new Date().toISOString().slice(0, 10)} · ${cachePath}\n`);
  process.stdout.write(
    `Fetching ${selected.length} article(s) (${direct.length} from direct feeds) as "${USER_AGENT}"\n\n`,
  );
  process.stdout.write('publisher'.padEnd(34) + 'verdict'.padEnd(18) + 'words'.padStart(6) + '  final host\n');

  const byPublisher = new Map();
  for (const item of selected) {
    const result = await fetchPage(item.url);
    const verdictText = verdict(result);
    let host = '';
    try {
      host = new URL(result.finalUrl).hostname;
    } catch {
      host = '';
    }
    process.stdout.write(
      `${String(item.publisher || 'Unknown').slice(0, 33).padEnd(34)}${verdictText.padEnd(18)}${String(
        result.words,
      ).padStart(6)}  ${host}\n`,
    );

    if (!byPublisher.has(item.publisher)) byPublisher.set(item.publisher, []);
    byPublisher.get(item.publisher).push({ verdict: verdictText, words: result.words, host });
    await sleep(PAUSE_MS);
  }

  process.stdout.write('\nSummary by publisher\n');
  process.stdout.write('publisher'.padEnd(34) + 'tested'.padStart(7) + 'readable'.padStart(10) + 'median'.padStart(9) + '  notes\n');
  for (const [publisher, results] of [...byPublisher.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const readable = results.filter((result) => result.verdict === 'readable').length;
    const notes = [...new Set(results.filter((result) => result.verdict !== 'readable').map((result) => result.verdict))];
    const hosts = [...new Set(results.map((result) => result.host).filter(Boolean))];
    process.stdout.write(
      `${publisher.slice(0, 33).padEnd(34)}${String(results.length).padStart(7)}${String(readable).padStart(10)}${String(
        median(results.map((result) => result.words)),
      ).padStart(9)}  ${(notes.join(', ') || hosts.join(', ')).slice(0, 80)}\n`,
    );
  }
}

main().catch((error) => {
  process.stdout.write(`Survey failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
