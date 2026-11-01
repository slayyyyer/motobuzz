/**
 * The buzz math.
 *
 * One idea: every published record carries a small amount of energy, energy
 * fades with age, and the room's temperature is the total of whatever is still
 * warm. Nothing here is a claim about the sport; it is a measurement of how
 * loudly and how recently public sources are talking.
 */
import {
  BUZZ,
  DECAY,
  ENTITY_BY_ID,
  ENTITY_PAGE_SIZE,
  KIND_META,
  TOPIC_LABELS,
  WINDOW,
} from '../config.js';
import { clamp, round } from '../lib/text.js';

const HALF_LIFE_MS = {
  news: DECAY.news.halfLifeHours * 3_600_000,
  social: DECAY.social.halfLifeHours * 3_600_000,
};

const MAX_AGE_MS = {
  news: DECAY.news.maxAgeHours * 3_600_000,
  social: DECAY.social.maxAgeHours * 3_600_000,
};

/** FNV-1a over a short string: stable ids without a dependency. */
export function stableId(input) {
  let hash = 0x811c9dc5;
  const text = String(input);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

export function urlKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const keep = [...parsed.searchParams.keys()].filter((key) => /^(id|p|story|article)$/i.test(key));
    for (const key of [...parsed.searchParams.keys()]) {
      if (!keep.includes(key)) parsed.searchParams.delete(key);
    }
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`.toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

export function maxAgeMs(kind) {
  return MAX_AGE_MS[kind] ?? MAX_AGE_MS.news;
}

export function isEligible(item, now) {
  if (!item || !Number.isFinite(item.publishedAt)) return false;
  const age = now - item.publishedAt;
  return age <= maxAgeMs(item.kind) && age >= -3_600_000;
}

/** How much of this record's energy is left, 0..1. */
export function recencyFactor(item, now) {
  const halfLife = HALF_LIFE_MS[item.kind] ?? HALF_LIFE_MS.news;
  const ageHours = Math.max(0, now - item.publishedAt) / 3_600_000;
  return 2 ** (-ageHours / (halfLife / 3_600_000));
}

/**
 * Social posts carry an audience number; news stories carry none, so they stay
 * at 1. A logged scale keeps one viral post from swallowing the whole board.
 */
export function engagementFactor(item) {
  if (item.kind !== 'social') return 1;
  const score = Math.max(0, Number(item.engagement) || 0);
  const replies = Math.max(0, Number(item.replies) || 0);
  return 1 + Math.log10(1 + score) / 1.6 + Math.log10(1 + replies) / 3.2;
}

export function itemEnergy(item, now) {
  const kindWeight = KIND_META[item.kind]?.weight ?? 1;
  return kindWeight * engagementFactor(item) * recencyFactor(item, now);
}

function bandFor(score) {
  let chosen = BUZZ.bands[0];
  for (const band of BUZZ.bands) {
    if (score >= band.min) chosen = band;
  }
  return chosen;
}

function momentumLabelFor(ratio, recentEnergy) {
  if (recentEnergy <= 0) return 'cooling';
  if (ratio >= BUZZ.risingRatio) return 'rising';
  if (ratio <= BUZZ.coolingRatio) return 'cooling';
  return 'steady';
}

function buildBuckets(entries, now, count, spanHours) {
  const widthMs = spanHours * 3_600_000;
  const alignedNow = Math.floor(now / widthMs) * widthMs;
  const buckets = Array.from({ length: count }, (_, index) => ({
    start: alignedNow - (count - 1 - index) * widthMs,
    energy: 0,
    items: 0,
  }));

  for (const entry of entries) {
    const index = count - 1 - Math.floor((alignedNow - entry.publishedAt) / widthMs);
    if (index >= 0 && index < count) {
      buckets[index].energy += entry.rawEnergy;
      buckets[index].items += 1;
    }
  }

  return buckets.map((bucket) => ({
    start: bucket.start,
    energy: round(bucket.energy, 2),
    items: bucket.items,
  }));
}

function shareOf(value, total) {
  if (!total) return 0;
  return round(clamp(value / total, 0, 1), 3);
}

function represented(value) {
  return value >= 0.05 ? `${Math.round(value * 100)}%` : 'under 5%';
}

function composeHeadline({ score, momentum, momentumLabel, topEntity, topThread, activeItems, liveSources }) {
  if (activeItems === 0) {
    return {
      text:
        liveSources > 0
          ? 'No signal. Nothing dated inside the last two days came back from any live source.'
          : 'No sources answered, so there is nothing to measure right now.',
      basis: 'no eligible records',
    };
  }

  const name = topEntity?.name || null;
  const topicLabel = topThread ? TOPIC_LABELS[topThread.topic] || null : null;
  const pct = Math.round(Math.abs(momentum - 1) * 100);

  if (momentumLabel === 'rising' && name) {
    return {
      text: `${name} is carrying the room. Chatter in the last six hours is ${pct}% heavier than the six before it.`,
      basis: 'top entity and six-hour momentum',
    };
  }
  if (momentumLabel === 'cooling' && name) {
    return {
      text: `${name} still leads the board, but the room is settling: chatter is ${pct}% lighter than six hours ago.`,
      basis: 'top entity and six-hour momentum',
    };
  }
  if (name && topicLabel) {
    return {
      text: `${name} and ${topicLabel.toLowerCase()} hold the board. ${activeItems} records across ${
        topEntity.sources
      } sources, and the pace is flat.`,
      basis: 'top entity, top topic, flat momentum',
    };
  }
  if (name) {
    return {
      text: `${name} leads the board with ${activeItems} records and no strong single theme.`,
      basis: 'top entity only',
    };
  }
  if (topicLabel) {
    return {
      text: `${topicLabel} is where the room is: ${activeItems} records and no single name dominating.`,
      basis: 'top topic only',
    };
  }
  return {
    text: `A ${score} on the meter: ${activeItems} records, spread thin across the watchlist.`,
    basis: 'volume and spread only',
  };
}

/**
 * @param {object[]} items Normalized records with topics, entities, region.
 * @param {{now: number}} options
 */
export function buildSnapshot(items, { now = Date.now() } = {}) {
  const scored = [];
  for (const item of items) {
    if (!isEligible(item, now)) continue;
    const energy = itemEnergy(item, now);
    scored.push({
      ...item,
      weight: round(energy, 3),
      rawEnergy: round((KIND_META[item.kind]?.weight ?? 1) * engagementFactor(item), 3),
    });
  }

  const windowStart = now - WINDOW.scoreHours * 3_600_000;
  const active = scored.filter((item) => item.publishedAt >= windowStart);
  const totalEnergy = active.reduce((sum, item) => sum + item.weight, 0);

  const recentStart = now - WINDOW.momentumHours * 3_600_000;
  const priorStart = now - WINDOW.scoreHours * 3_600_000;
  const recentEnergy = active
    .filter((item) => item.publishedAt >= recentStart)
    .reduce((sum, item) => sum + item.rawEnergy, 0);
  const priorEnergy = active
    .filter((item) => item.publishedAt < recentStart && item.publishedAt >= priorStart)
    .reduce((sum, item) => sum + item.rawEnergy, 0);
  const priorScaled = priorEnergy / (WINDOW.scoreHours / WINDOW.momentumHours - 1);
  const momentum = round((recentEnergy + 0.5) / (priorScaled + 0.5), 2);
  const momentumLabel = momentumLabelFor(momentum, recentEnergy);

  const score = Math.round(100 * (1 - Math.exp(-totalEnergy / BUZZ.saturationEnergy)));
  const band = bandFor(score);

  const buckets = buildBuckets(scored, now, WINDOW.bucketCount, 1);

  const publishers = new Set(active.map((item) => item.publisher)).size;
  const counts = {
    news: active.filter((item) => item.kind === 'news').length,
    social: active.filter((item) => item.kind === 'social').length,
  };
  const newestItemAt = active.reduce((newest, item) => Math.max(newest, item.publishedAt), 0) || null;

  // --- entities -------------------------------------------------------------
  const entityBuckets = new Map();
  for (const item of active) {
    for (const id of item.entities || []) {
      if (!entityBuckets.has(id)) entityBuckets.set(id, []);
      entityBuckets.get(id).push(item);
    }
  }

  const entities = [...entityBuckets.entries()]
    .map(([id, mentions]) => {
      const definition = ENTITY_BY_ID[id];
      if (!definition) return null;
      const heat = mentions.reduce((sum, item) => sum + item.weight, 0);
      const entityRecent = mentions
        .filter((item) => item.publishedAt >= recentStart)
        .reduce((sum, item) => sum + item.rawEnergy, 0);
      const entityPrior = mentions
        .filter((item) => item.publishedAt < recentStart)
        .reduce((sum, item) => sum + item.rawEnergy, 0);
      const entityPriorScaled = entityPrior / (WINDOW.scoreHours / WINDOW.momentumHours - 1);
      const entityMomentum = round((entityRecent + 0.5) / (entityPriorScaled + 0.5), 2);
      const sources = new Set(mentions.map((item) => item.publisher)).size;
      const exemplar = mentions.reduce((best, item) => (item.weight > best.weight ? item : best), mentions[0]);
      const series = buildBuckets(mentions, now, 12, 2).map((bucket) => bucket.energy);

      return {
        id,
        kind: definition.kind,
        name: definition.name,
        heat: round(heat, 2),
        share: shareOf(heat, totalEnergy),
        mentions: mentions.length,
        sources,
        momentum: entityMomentum,
        trend: momentumLabelFor(entityMomentum, entityRecent),
        series,
        exemplar: {
          title: exemplar.title,
          url: exemplar.url,
          sourceId: exemplar.sourceId,
          publisher: exemplar.publisher,
          publishedAt: exemplar.publishedAt,
        },
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, ENTITY_PAGE_SIZE);

  // --- threads --------------------------------------------------------------
  const byTopic = new Map();
  for (const item of active) {
    const topic = (item.topics || [])[0];
    if (!topic) continue;
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(item);
  }

  const threads = [...byTopic.entries()]
    .map(([topic, entries]) => {
      const heat = entries.reduce((sum, item) => sum + item.weight, 0);
      const threadRecent = entries
        .filter((item) => item.publishedAt >= recentStart)
        .reduce((sum, item) => sum + item.rawEnergy, 0);
      const threadPrior = entries
        .filter((item) => item.publishedAt < recentStart)
        .reduce((sum, item) => sum + item.rawEnergy, 0);
      const threadPriorScaled = threadPrior / (WINDOW.scoreHours / WINDOW.momentumHours - 1);
      const threadMomentum = round((threadRecent + 0.5) / (threadPriorScaled + 0.5), 2);

      const entityTally = new Map();
      for (const item of entries) {
        for (const id of item.entities || []) {
          entityTally.set(id, (entityTally.get(id) || 0) + item.weight);
        }
      }
      const topEntityId = [...entityTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const topEntityDef = topEntityId ? ENTITY_BY_ID[topEntityId] : null;
      const exemplar = entries.reduce((best, item) => (item.weight > best.weight ? item : best), entries[0]);

      return {
        id: `topic:${topic}`,
        topic,
        label: TOPIC_LABELS[topic] || topic,
        heat: round(heat, 2),
        share: shareOf(heat, totalEnergy),
        itemCount: entries.length,
        sources: new Set(entries.map((item) => item.publisher)).size,
        momentum: threadMomentum,
        trend: momentumLabelFor(threadMomentum, threadRecent),
        entity: topEntityDef ? { id: topEntityDef.id, name: topEntityDef.name, kind: topEntityDef.kind } : null,
        exemplar: {
          title: exemplar.title,
          url: exemplar.url,
          sourceId: exemplar.sourceId,
          publisher: exemplar.publisher,
          publishedAt: exemplar.publishedAt,
        },
      };
    })
    .sort((a, b) => b.heat - a.heat)
    .slice(0, 5);

  // --- region ---------------------------------------------------------------
  const regionEnergy = { us: 0, world: 0, mixed: 0, unknown: 0 };
  for (const item of active) {
    const key = item.region && regionEnergy[item.region] !== undefined ? item.region : 'unknown';
    regionEnergy[key] += item.weight;
  }
  const region = Object.fromEntries(
    Object.entries(regionEnergy).map(([key, value]) => [key, shareOf(value, totalEnergy)]),
  );

  const liveSources = new Set(active.map((item) => item.sourceId)).size;
  const headline = composeHeadline({
    score,
    momentum,
    momentumLabel,
    topEntity: entities[0] || null,
    topThread: threads[0] || null,
    activeItems: active.length,
    liveSources,
  });

  return {
    buzz: {
      score,
      level: band.level,
      label: band.label,
      note: band.note,
      headline: headline.text,
      headlineBasis: headline.basis,
      energy: round(totalEnergy, 2),
      momentum,
      momentumLabel,
      activeItems: active.length,
      sourcesRepresented: liveSources,
      publishersRepresented: publishers,
      newestItemAt,
      counts,
      buckets,
    },
    threads,
    entities,
    region,
    items: scored.sort((a, b) => b.weight - a.weight),
    totals: {
      scoredRecords: scored.length,
      activeRecords: active.length,
      retainedRecords: items.length,
      representedShare: represented(shareOf(totalEnergy, totalEnergy)),
    },
  };
}
