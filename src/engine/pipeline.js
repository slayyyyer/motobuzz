/**
 * The parts of the hourly build that decide what survives.
 *
 * They are separate from the command-line script so the test suite can exercise
 * them with fixtures: which old records may be carried forward, which records
 * are duplicates, and how a source's status is derived from what happened.
 */
import { isJunkTitle } from '../adapters/news.js';
import { MIXED_SOCIAL_SOURCE_IDS, NEWS_QUERIES } from '../config.js';
import { titleKey } from '../lib/text.js';
import {
  classify,
  hasMotocrossContext,
  hasMotocrossEntityContext,
  hasNonMotocrossProduct,
  isMotocrossStory,
} from './classify.js';
import { isEligible, urlKey } from './score.js';

/** Search-index records, which carry no promise of being about motocross. */
const INDEX_SOURCE_IDS = new Set(NEWS_QUERIES.map((entry) => entry.id));

/**
 * A social post counts only when the post itself is motocross. The channel is
 * never evidence: Vital MX and Gypsy Tales both publish mountain-bike, MMA and
 * MotoGP videos between motocross ones, and their source ids are already in
 * MOTOCROSS_SOURCE_IDS. A post that carries a non-motocross subject from
 * NON_MOTOCROSS_PRODUCTS is therefore dropped unless its own words place it in
 * motocross; that exception uses the strict tier, because "bike" and "racing"
 * appear in a bicycle review too.
 *
 * A single veto term is not enough for a mixed channel. "Kade Ruotolo Reveals
 * What It's REALLY Like Training With His Twin" names no other sport at all — who
 * the guest is carries it — so the product list can never catch it. Those
 * channels' posts are instead kept only when their own words place them in
 * motocross, or when they name something on the watchlist that needs no gate.
 *
 * The channel does not stand in for a gate either, so the entity pass below runs
 * with outletIsEvidence: false. A configured source id is an outlet to
 * classify(), and an outlet satisfies the strict tier a gated brand needs, which
 * let "KTM 390 Duke first ride" count on the word "KTM" alone. The product list
 * cannot take that job: every manufacturer adds a street model each year, and the
 * same list also vetoes news stories. The price is an MX upload whose title says
 * nothing but the brand, such as "What Went So WRONG With the 2023 KTM?!", which
 * now drops; tests/run.js records that as a cost rather than as correct.
 *
 * The product veto still runs first, because "bike" is an MX word and an e-bike
 * review would otherwise pass on the substring.
 *
 * News is not held to this: the adapters and the index gate decide what a news
 * record has to show, and a configured feed's own headline can be terse.
 *
 * @param {{kind?: string, title?: string, summary?: string|null, sourceId?: string}} record
 * @returns {boolean} true when the record is a social post about something else.
 */
export function isOffTopicSocial(record) {
  if (record?.kind !== 'social') return false;
  const text = `${record.title || ''} ${record.summary || ''}`;
  if (hasNonMotocrossProduct(text) && !hasMotocrossEntityContext(text)) return true;
  if (!MIXED_SOCIAL_SOURCE_IDS.includes(record.sourceId)) return false;
  return (
    !hasMotocrossContext(text) &&
    !hasMotocrossEntityContext(text) &&
    classify(record, { outletIsEvidence: false }).entities.length === 0
  );
}

/**
 * Old records may be carried forward only when their source is still configured.
 * A source dropped from config.js must not keep appearing through continuity.
 *
 * @param {{items?: object[]}|null} previous
 * @param {{configuredSourceIds: Set<string>, now: number}} options
 */
export function retainPrevious(previous, { configuredSourceIds, now }) {
  const retainedBySource = new Map();
  const retained = [];
  let unconfiguredRetained = 0;

  for (const item of previous?.items ?? []) {
    if (!isEligible(item, now)) continue;
    // A headline the denylist would reject today must not survive by being old.
    if (isJunkTitle(item.title)) continue;
    // A social post about another subject must not outlive the rule that drops it.
    if (isOffTopicSocial(item)) continue;
    // Neither must an index record that never showed motocross evidence, or the
    // story that prompted the ingest gate would sit in the cache for two days.
    if (INDEX_SOURCE_IDS.has(item.sourceId) && !isMotocrossStory(item)) continue;
    if (!configuredSourceIds.has(item.sourceId)) {
      unconfiguredRetained += 1;
      continue;
    }
    retainedBySource.set(item.sourceId, (retainedBySource.get(item.sourceId) || 0) + 1);
    retained.push(item);
  }

  return { retained, retainedBySource, unconfiguredRetained };
}

/**
 * One story, one record. Fresh records are ordered first, so a fresh copy wins.
 *
 * @param {object[]} ordered
 * @param {{now: number}} options
 */
export function dedupeRecords(ordered, { now }) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const deduped = [];
  let duplicates = 0;

  for (const record of ordered) {
    if (!isEligible(record, now)) continue;
    const byUrl = urlKey(record.url);
    const byTitle = titleKey(record.title);
    if (seenUrls.has(byUrl) || (byTitle && seenTitles.has(byTitle))) {
      duplicates += 1;
      continue;
    }
    seenUrls.add(byUrl);
    if (byTitle) seenTitles.add(byTitle);
    deduped.push(record);
  }

  return { deduped, duplicates };
}

/**
 * The page's source table. A failed source whose earlier records survive is
 * `cached`, not `live`; a source that answered with nothing inside the window is
 * `empty`, unless its records were all duplicates of another source's.
 *
 * @param {object[]} attempts
 * @param {{itemCounts: Map<string, number>, previousSources: Map<string, object>,
 *          retainedBySource: Map<string, number>}} context
 */
export function buildSourceRows(attempts, { itemCounts, previousSources, retainedBySource }) {
  return attempts.map((attempt) => {
    const prior = previousSources.get(attempt.def.id);
    const count = itemCounts.get(attempt.def.id) || 0;
    const failed = attempt.status === 'unavailable' || attempt.status === 'malformed';
    const carried = failed && (retainedBySource.get(attempt.def.id) || 0) > 0;
    // A source that answered but had nothing inside the retention window is empty, not live.
    const emptied = attempt.status === 'live' && count === 0;
    // A query whose records were all already counted from an earlier source still
    // answered: calling it empty would hide a group that did its job.
    const deduped = emptied && attempt.records.length > 0;
    return {
      sourceId: attempt.def.id,
      label: attempt.def.label,
      provider: attempt.def.provider,
      homepage: attempt.def.homepage,
      kind: attempt.def.kind,
      status: carried ? 'cached' : emptied && !deduped ? 'empty' : attempt.status,
      error: attempt.error,
      note: deduped
        ? 'Answered; its records were duplicates or outside the window.'
        : emptied
          ? 'Answered, but nothing landed inside the retention window.'
          : attempt.note,
      fetchedAt: attempt.fetchedAt,
      lastSuccessAt: attempt.status === 'live' ? attempt.fetchedAt : prior?.lastSuccessAt ?? null,
      recordCount: count,
    };
  });
}
