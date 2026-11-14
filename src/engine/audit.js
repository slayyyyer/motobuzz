/**
 * Pure checks for the repeatable context audit.
 *
 * The audit has two failure directions. A gated brand or team can be counted
 * on a story with no motocross context (a Honda car review), or it can be
 * dropped from a story that clearly is motocross. Keeping the decision here,
 * separate from the network runner, lets both cases be tested directly.
 */
import {
  classify,
  hasMotocrossContext,
  hasMotocrossEntityContext,
  isMotocrossOutlet,
  matchedNonMotocrossProducts,
} from './classify.js';
import { normalizeForMatch } from '../lib/text.js';

/** Normalized aliases for a watchlist entry. */
export function aliasesFor(target) {
  return (target?.aliases || [target?.name]).map((alias) => normalizeForMatch(alias)).filter(Boolean);
}

/** True when a headline names the gated entity. */
export function matchesName(title, target) {
  const normalized = normalizeForMatch(title || '');
  return aliasesFor(target).some((alias) => normalized.includes(alias));
}

/**
 * Classify one candidate for one gated entity.
 *
 * Returns null when the headline does not name the entity. Otherwise it returns
 * one of:
 *   kept            — entity present, motocross context present
 *   non-mx-counted  — entity present, no motocross context (false positive)
 *   near-miss       — entity absent, motocross context present (dropped story)
 *   negative-veto   — entity absent, MX context present, but a product term vetoed it
 *   dropped         — entity absent, no motocross context (correctly ignored)
 *
 * `labels` and `hasContext` can be supplied by tests to exercise the reporting
 * logic without depending on a particular classifier result.
 */
export function inspectRecord(record, target, { labels, hasContext } = {}) {
  if (!matchesName(record?.title, target)) return null;

  const storyText = `${record?.title || ''} ${record?.summary || ''}`;
  const outlet = isMotocrossOutlet(record);
  const gatedUnit = target.kind === 'brand' || target.kind === 'team';
  const positiveContext = gatedUnit
    ? hasMotocrossEntityContext(storyText) || outlet
    : hasMotocrossContext(storyText) || outlet;
  const negativeTerms = gatedUnit ? matchedNonMotocrossProducts(storyText) : [];
  const context = hasContext ?? (positiveContext && negativeTerms.length === 0);
  const classified = labels ?? classify(record);
  const counted = Array.isArray(classified?.entities) && classified.entities.includes(target.id);

  if (counted) {
    return { status: context ? 'kept' : 'non-mx-counted', counted: true, context, negativeTerms };
  }
  if (positiveContext && negativeTerms.length > 0) {
    return { status: 'negative-veto', counted: false, context, negativeTerms };
  }
  return { status: context ? 'near-miss' : 'dropped', counted: false, context, negativeTerms };
}
