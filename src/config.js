/**
 * MotoBuzz's fixed configuration.
 *
 * Everything a person might reasonably want to change lives here: the feeds,
 * the YouTube channels, the rider and brand watchlist, the topic keywords, the
 * decay schedule, and the thresholds that turn accumulated chatter into a number.
 */

export const SITE = Object.freeze({
  name: 'MotoBuzz',
  tagline: 'What the motocross world is talking about right now.',
  timezone: 'America/New_York',
  timezoneLabel: 'Eastern Time',
});

export const WINDOW = Object.freeze({
  /** Window that sets the buzz score and the heat tables. */
  scoreHours: 24,
  /** How long the cache keeps a record at all. */
  retainHours: 72,
  /** Hourly buckets drawn behind the gauge. */
  bucketCount: 24,
  /** Window used for the momentum comparison. */
  momentumHours: 6,
  /** Hard ceiling on records in one cache, highest energy kept first. */
  maxItems: 380,
});

export const DECAY = Object.freeze({
  news: { halfLifeHours: 8, maxAgeHours: 48 },
  social: { halfLifeHours: 5, maxAgeHours: 72 },
});

export const KIND_META = Object.freeze({
  news: { label: 'News', weight: 1 },
  social: { label: 'Social', weight: 0.9 },
});

/**
 * Buzz score = 100 × (1 − e^(−energy / saturationEnergy)).
 *
 * The constant is held at 26. A post-removal review of eleven stored builds,
 * with the Instagram and Reddit records filtered out, put off-season 24-hour
 * energy at 6.3–13.4; at 26 those days read 21–43, Idling to Warming up, which
 * is where a quiet stretch belongs. Mapping that sample's median to 50 instead
 * (18) made a day with ordinary chatter read Running hot, and the sample has no
 * race weekend in it, so there was no evidence for the hotter scale. `npm run
 * calibrate` reprints the distribution. Re-run it with a race weekend included
 * before touching this number.
 */
export const BUZZ = Object.freeze({
  saturationEnergy: 26,
  bands: Object.freeze([
    { level: 'quiet', min: 0, label: 'Quiet', note: 'Almost nothing new is landing.' },
    { level: 'idle', min: 15, label: 'Idling', note: 'A slow stretch of the week.' },
    { level: 'warming', min: 35, label: 'Warming up', note: 'The paddock is starting to talk.' },
    { level: 'hot', min: 55, label: 'Running hot', note: 'Plenty of fresh chatter across sources.' },
    { level: 'redline', min: 75, label: 'Redline', note: 'Everything is talking at once.' },
  ]),
  risingRatio: 1.2,
  coolingRatio: 0.85,
});

export const TOPICS = Object.freeze([
  {
    id: 'signings',
    label: 'Signings & contracts',
    keywords: [
      'sign', 'signs', 'signed', 'signing', 're-sign', 'resign', 'contract', 'deal', 'extension',
      'joins', 'join', 'departs', 'parts ways', 'transfer', 'ink', 'inks', 'agreement', 'multi-year',
      'renewal', 'retirement', 'retires', 'announces', 'confirms', 'lands', 'moves to',
    ],
  },
  {
    id: 'injury',
    label: 'Injuries & comebacks',
    keywords: [
      'injur', 'injuries', 'injured', 'surgery', 'surgical', 'out for', 'sidelined', 'concussion',
      'collarbone', 'torn', 'acl', 'broken', 'fracture', 'fractured', 'medical', 'rehab',
      'comeback', 'return to racing', 'cleared to race', 'hospital', 'knocked out',
    ],
  },
  {
    id: 'results',
    label: 'Results & titles',
    keywords: [
      'win', 'wins', 'winner', 'victory', 'podium', 'sweep', 'sweeps', 'overall', 'results',
      'race report', 'champion', 'championship', 'title', 'points', 'standings', 'moto', 'holeshot',
      'fastest', 'qualifying', 'clinched', 'triple crown', 'main event', 'gate drop',
    ],
  },
  {
    id: 'schedule',
    label: 'Schedule & tracks',
    keywords: [
      'schedule', 'calendar', 'round', 'rounds', 'venue', 'track', 'circuit', 'layout', 'tickets',
      'date', 'dates', 'postponed', 'cancel', 'cancelled', 'relocated', 'new venue', 'announced for',
      'season opener', 'finale', 'playoff',
    ],
  },
  {
    id: 'tech',
    label: 'Bikes & tech',
    keywords: [
      'bike', 'bikes', 'model', 'launch', 'engine', 'suspension', 'chassis', 'first ride', 'tested',
      'test', 'prototype', 'electric', 'e-bike', 'two-stroke', 'four-stroke', 'displacement',
      'exhaust', 'ecu', 'mapping', 'tuning', 'build', 'race bike', 'works bike', 'parts',
    ],
  },
  {
    id: 'business',
    label: 'Teams & business',
    keywords: [
      'team', 'teams', 'factory', 'financial', 'layoff', 'layoffs', 'budget', 'sale', 'acquire',
      'acquisition', 'merger', 'bankrupt', 'bankruptcy', 'shut down', 'folds', 'sponsor',
      'sponsorship', 'partnership', 'owner', 'ownership', 'revenue', 'parent company', 'hires',
      'staff', 'restructure',
    ],
  },
  {
    id: 'safety',
    label: 'Rules & safety',
    keywords: [
      'rule', 'rules', 'penalty', 'penalised', 'penalized', 'fine', 'fined', 'banned', 'ban',
      'protest', 'appeal', 'safety', 'protocol', 'track safety', 'flag', 'officials', 'stewards',
      'doping', 'anti-doping', 'technical inspection', 'scrutineering',
    ],
  },
  {
    id: 'culture',
    label: 'Culture & media',
    keywords: [
      'documentary', 'podcast', 'interview', 'film', 'series', 'episode', 'behind the scenes',
      'vlog', 'youtube', 'amateur', 'grassroots', 'loretta', 'vintage', 'retro', 'fan', 'fans',
      'tribute', 'memorial', 'hall of fame', 'award', 'charity', 'auction', 'merch',
    ],
  },
]);

export const TOPIC_LABELS = Object.freeze(Object.fromEntries(TOPICS.map((topic) => [topic.id, topic.label])));

export const REGION_RULES = Object.freeze({
  us: [
    'supercross', 'smx', 'supermotocross', 'ama', 'pro motocross', 'motocross nationals',
    'anaheim', 'daytona', 'loretta', 'washougal', 'hangtown', 'thunder valley', 'redbud',
    'red bud', 'southwick', 'budds creek', 'ironman', 'unadilla', 'high point', 'millville',
    'fox raceway', 'pala', 'mx sports', 'world vet',
  ],
  world: [
    'mxgp', 'mx2', 'mx1', 'fim', 'motocross of nations', 'mxon', 'wsx', 'world supercross',
    'kegums', 'valkenswaard', 'lommel', 'matterley', 'arco di trento', 'maggiora', 'ernee',
    'loket', 'afyon', 'inteu', 'xanadu', 'gp of ', 'grand prix',
  ],
});

/**
 * The watchlist. Surnames are only used as aliases when they are distinctive in
 * a motocross headline; anything ambiguous stays a full-name match so a story
 * about a different Martin or Cooper cannot be counted for a rider. A rider
 * whose full name is common enough to belong to an unrelated namesake carries
 * `contextRequired`, which makes a motocross term mandatory before the match
 * counts.
 */
export const RIDERS = Object.freeze([
  { id: 'jett-lawrence', name: 'Jett Lawrence', aliases: ['Jett Lawrence', 'Jett'] },
  { id: 'hunter-lawrence', name: 'Hunter Lawrence', aliases: ['Hunter Lawrence'] },
  { id: 'eli-tomac', name: 'Eli Tomac', aliases: ['Eli Tomac', 'Tomac'] },
  { id: 'cooper-webb', name: 'Cooper Webb', aliases: ['Cooper Webb', 'Webb'] },
  { id: 'chase-sexton', name: 'Chase Sexton', aliases: ['Chase Sexton', 'Sexton'] },
  { id: 'ken-roczen', name: 'Ken Roczen', aliases: ['Ken Roczen', 'Roczen'] },
  { id: 'aaron-plessinger', name: 'Aaron Plessinger', aliases: ['Aaron Plessinger', 'Plessinger'] },
  { id: 'jason-anderson', name: 'Jason Anderson', aliases: ['Jason Anderson', 'El Hombre'], contextRequired: true },
  { id: 'malcolm-stewart', name: 'Malcolm Stewart', aliases: ['Malcolm Stewart', 'Mookie'] },
  { id: 'haiden-deegan', name: 'Haiden Deegan', aliases: ['Haiden Deegan', 'Deegan'] },
  { id: 'rj-hampshire', name: 'RJ Hampshire', aliases: ['RJ Hampshire', 'Hampshire'] },
  { id: 'jalek-swoll', name: 'Jalek Swoll', aliases: ['Jalek Swoll', 'Swoll'] },
  { id: 'jo-shimoda', name: 'Jo Shimoda', aliases: ['Jo Shimoda', 'Shimoda'] },
  { id: 'levi-kitchen', name: 'Levi Kitchen', aliases: ['Levi Kitchen'] },
  { id: 'chance-hymas', name: 'Chance Hymas', aliases: ['Chance Hymas', 'Hymas'] },
  { id: 'cole-davies', name: 'Cole Davies', aliases: ['Cole Davies'] },
  { id: 'julien-beaumer', name: 'Julien Beaumer', aliases: ['Julien Beaumer', 'Beaumer'] },
  { id: 'seth-hammaker', name: 'Seth Hammaker', aliases: ['Seth Hammaker', 'Hammaker'] },
  { id: 'nate-thrasher', name: 'Nate Thrasher', aliases: ['Nate Thrasher', 'Thrasher'] },
  { id: 'justin-cooper', name: 'Justin Cooper', aliases: ['Justin Cooper'], contextRequired: true },
  { id: 'dylan-ferrandis', name: 'Dylan Ferrandis', aliases: ['Dylan Ferrandis', 'Ferrandis'] },
  { id: 'max-anstie', name: 'Max Anstie', aliases: ['Max Anstie', 'Anstie'] },
  { id: 'justin-barcia', name: 'Justin Barcia', aliases: ['Justin Barcia', 'Barcia'] },
  { id: 'pierce-brown', name: 'Pierce Brown', aliases: ['Pierce Brown'], contextRequired: true },
  { id: 'ty-masterpool', name: 'Ty Masterpool', aliases: ['Ty Masterpool', 'Masterpool'] },
  { id: 'cameron-mcadoo', name: 'Cameron McAdoo', aliases: ['Cameron McAdoo', 'McAdoo'] },
  { id: 'austin-forkner', name: 'Austin Forkner', aliases: ['Austin Forkner', 'Forkner'] },
  { id: 'tom-vialle', name: 'Tom Vialle', aliases: ['Tom Vialle', 'Vialle'] },
  { id: 'garrett-marchbanks', name: 'Garrett Marchbanks', aliases: ['Garrett Marchbanks', 'Marchbanks'] },
  { id: 'dean-wilson', name: 'Dean Wilson', aliases: ['Dean Wilson'], contextRequired: true },
  { id: 'jeremy-martin', name: 'Jeremy Martin', aliases: ['Jeremy Martin'], contextRequired: true },
  { id: 'adam-cianciarulo', name: 'Adam Cianciarulo', aliases: ['Adam Cianciarulo', 'Cianciarulo'] },
  { id: 'jeffrey-herlings', name: 'Jeffrey Herlings', aliases: ['Jeffrey Herlings', 'Herlings'] },
  { id: 'tim-gajser', name: 'Tim Gajser', aliases: ['Tim Gajser', 'Gajser'] },
  { id: 'jorge-prado', name: 'Jorge Prado', aliases: ['Jorge Prado'], contextRequired: true },
  { id: 'romain-febvre', name: 'Romain Febvre', aliases: ['Romain Febvre', 'Febvre'] },
  { id: 'glenn-coldenhoff', name: 'Glenn Coldenhoff', aliases: ['Glenn Coldenhoff', 'Coldenhoff'] },
  { id: 'kay-de-wolf', name: 'Kay de Wolf', aliases: ['Kay de Wolf', 'de Wolf'] },
  { id: 'lucas-coenen', name: 'Lucas Coenen', aliases: ['Lucas Coenen'] },
  { id: 'sacha-coenen', name: 'Sacha Coenen', aliases: ['Sacha Coenen'] },
  { id: 'andrea-adamo', name: 'Andrea Adamo', aliases: ['Andrea Adamo'], contextRequired: true },
  { id: 'simon-laengenfelder', name: 'Simon Längenfelder', aliases: ['Simon Längenfelder', 'Laengenfelder', 'Langenfelder'] },
  { id: 'liam-everts', name: 'Liam Everts', aliases: ['Liam Everts'] },
  { id: 'mattia-guadagnini', name: 'Mattia Guadagnini', aliases: ['Mattia Guadagnini', 'Guadagnini'] },
  { id: 'maxime-renaux', name: 'Maxime Renaux', aliases: ['Maxime Renaux', 'Renaux'] },
  { id: 'calvin-vlaanderen', name: 'Calvin Vlaanderen', aliases: ['Calvin Vlaanderen', 'Vlaanderen'] },
  { id: 'jago-geerts', name: 'Jago Geerts', aliases: ['Jago Geerts', 'Geerts'] },
  { id: 'thibault-benistant', name: 'Thibault Benistant', aliases: ['Thibault Benistant', 'Benistant'] },
  { id: 'andrea-bonacorsi', name: 'Andrea Bonacorsi', aliases: ['Andrea Bonacorsi', 'Bonacorsi'] },
  { id: 'antonio-cairoli', name: 'Antonio Cairoli', aliases: ['Antonio Cairoli', 'Cairoli'] },
]);

export const BRANDS = Object.freeze([
  { id: 'ktm', name: 'KTM', aliases: ['KTM'], contextRequired: true },
  { id: 'honda', name: 'Honda', aliases: ['Honda', 'HRC'], contextRequired: true },
  { id: 'kawasaki', name: 'Kawasaki', aliases: ['Kawasaki'], contextRequired: true },
  { id: 'yamaha', name: 'Yamaha', aliases: ['Yamaha', 'Yam'], contextRequired: true },
  { id: 'suzuki', name: 'Suzuki', aliases: ['Suzuki'], contextRequired: true },
  { id: 'husqvarna', name: 'Husqvarna', aliases: ['Husqvarna', 'Husky'], contextRequired: true },
  { id: 'gasgas', name: 'GASGAS', aliases: ['GASGAS', 'Gas Gas'], contextRequired: true },
  { id: 'triumph', name: 'Triumph', aliases: ['Triumph'], contextRequired: true },
  { id: 'ducati', name: 'Ducati', aliases: ['Ducati'], contextRequired: true },
  { id: 'stark', name: 'Stark Future', aliases: ['Stark Future', 'Stark Varg'], contextRequired: true },
  { id: 'beta', name: 'Beta', aliases: ['Beta Motorcycles', 'Beta Racing'], contextRequired: true },
  { id: 'fantic', name: 'Fantic', aliases: ['Fantic'], contextRequired: true },
]);

export const TEAMS = Object.freeze([
  { id: 'red-bull-ktm', name: 'Red Bull KTM', aliases: ['Red Bull KTM'], contextRequired: true },
  { id: 'honda-hrc', name: 'Honda HRC', aliases: ['Honda HRC', 'HRC Honda', 'Team Honda'], contextRequired: true },
  { id: 'monster-kawasaki', name: 'Monster Energy Kawasaki', aliases: ['Monster Energy Kawasaki', 'Monster Kawasaki'], contextRequired: true },
  { id: 'star-racing-yamaha', name: 'Star Racing Yamaha', aliases: ['Star Racing', 'Monster Energy Yamaha Star Racing'], contextRequired: true },
  { id: 'rockstar-husqvarna', name: 'Rockstar Energy Husqvarna', aliases: ['Rockstar Energy Husqvarna', 'Rockstar Husqvarna'], contextRequired: true },
  { id: 'tld-gasgas', name: 'Troy Lee Designs GASGAS', aliases: ['Troy Lee Designs', 'TLD GASGAS', 'TLD Red Bull GASGAS'], contextRequired: true },
  { id: 'ecstar-suzuki', name: 'Progressive ECSTAR Suzuki', aliases: ['ECSTAR Suzuki', 'Progressive Suzuki', 'Suzuki Factory Racing'], contextRequired: true },
  { id: 'nestaan-husqvarna', name: 'Nestaan Husqvarna', aliases: ['Nestaan'], contextRequired: true },
  { id: 'kawasaki-racing-team', name: 'Kawasaki Racing Team', aliases: ['Kawasaki Racing Team', 'KRT'], contextRequired: true },
]);

export const SERIES = Object.freeze([
  { id: 'supercross', name: 'Monster Energy Supercross', aliases: ['Monster Energy Supercross', 'Supercross', 'SX'] },
  { id: 'pro-motocross', name: 'AMA Pro Motocross', aliases: ['Pro Motocross', 'AMA Motocross', 'Motocross Nationals'] },
  { id: 'smx', name: 'SuperMotocross', aliases: ['SuperMotocross', 'SMX', 'SMX World Championship', 'SMX Playoffs'] },
  { id: 'mxgp', name: 'MXGP', aliases: ['MXGP', 'FIM Motocross World Championship'] },
  { id: 'mxon', name: 'Motocross of Nations', aliases: ['Motocross of Nations', 'MXoN', 'MXON'] },
  { id: 'wsx', name: 'World Supercross', aliases: ['World Supercross', 'WSX'] },
  { id: 'loretta', name: "Loretta Lynn's", aliases: ["Loretta Lynn's", 'Lorettas', 'Loretta'] },
  { id: 'world-vet', name: 'World Vet Championship', aliases: ['World Vet'] },
]);

/**
 * Terms that place a story inside motocross rather than another field. They are
 * the series, governing bodies, venues, and vocabulary a race report uses.
 * Manufacturers and teams are deliberately absent: they are gated entities
 * themselves, because a car review saying "Honda" would otherwise make itself
 * a motocross story. A context-gated entity is only counted when one of these
 * terms appears in the title or summary, or the outlet is a known MX source.
 */
export const MOTOCROSS_CONTEXT = Object.freeze([
  ...new Set([
    'motocross',
    'supercross',
    'supermotocross',
    'smx',
    'mxgp',
    'mx2',
    'mx1',
    'mxon',
    'arenacross',
    'ausx',
    'wsx',
    'dirt bike',
    'dirtbike',
    'moto',
    'motos',
    'mx',
    'bike',
    'bikes',
    'outdoor',
    'outdoors',
    'holeshot',
    'gate drop',
    'main event',
    'podium',
    'race',
    'racing',
    'rider',
    'riders',
    'paddock',
    'motocross track',
    'supercross track',
    ...REGION_RULES.us,
    ...REGION_RULES.world,
    ...SERIES.flatMap((series) => series.aliases || [series.name]),
  ]),
]);

/**
 * The stricter context tier for gated brands and teams. A manufacturer can be
 * an MX brand and still make cars, bicycles, marine engines, or generators, so
 * generic words such as "bike", "racing", and "outdoor" are not enough here.
 * Keep only explicit MX series, venues, and race-specific vocabulary, or a
 * known MX outlet/source.
 */
export const MOTOCROSS_ENTITY_CONTEXT = Object.freeze([
  ...new Set([
    'motocross',
    'supercross',
    'supermotocross',
    'smx',
    'mxgp',
    'mx2',
    'mx1',
    'mxon',
    'arenacross',
    'ausx',
    'wsx',
    'dirt bike',
    'dirtbike',
    'motocross track',
    'supercross track',
    'holeshot',
    'gate drop',
    ...REGION_RULES.us,
    ...REGION_RULES.world.filter((term) => !['fim', 'gp of ', 'grand prix'].includes(term)),
    ...SERIES.flatMap((series) => series.aliases || [series.name]),
  ]),
]);

/**
 * Product and category terms that veto a gated brand or team even when a
 * headline contains a generic MX-sounding word. These are deliberately about
 * the product, not the manufacturer: a Civic review is still a car story even
 * if it says "motocross-inspired".
 */
export const NON_MOTOCROSS_PRODUCTS = Object.freeze([
  'car review',
  'sedan',
  'suv',
  'crossover',
  'hatchback',
  'coupe',
  'minivan',
  'pickup truck',
  'civic',
  'accord',
  'cr-v',
  'hr-v',
  'pilot',
  'passport',
  'odyssey',
  'ridgeline',
  'integra',
  'nsx',
  'type r',
  'africa twin',
  'gold wing',
  'goldwing',
  'super cub',
  'pcx',
  'grom',
  'monkey',
  'dax',
  'rebel',
  'cbr',
  'forza',
  'navi',
  'adventure bike',
  'adventure bikes',
  'e-bike',
  'ebike',
  'electric-assist',
  'mountain bike',
  'mountain bikes',
  'mtb',
  'bicycle',
  'bicycles',
  'road bike',
  'gravel bike',
  'outboard',
  'marine',
  'jet ski',
  'waverunner',
  'seadoo',
  'personal watercraft',
  'atv',
  'utv',
  'side-by-side',
  'side by side',
  'four-wheeler',
  'four wheeler',
  'quad bike',
  'generator',
  'lawn mower',
  'mower',
  'snowblower',
  'hondajet',
  'aircraft',
  'piano',
  'audio equipment',
]);

export const WATCHLIST = Object.freeze([
  ...RIDERS.map((entry) => ({ ...entry, kind: 'rider' })),
  ...BRANDS.map((entry) => ({ ...entry, kind: 'brand' })),
  ...TEAMS.map((entry) => ({ ...entry, kind: 'team' })),
  ...SERIES.map((entry) => ({ ...entry, kind: 'series' })),
]);

export const ENTITY_BY_ID = Object.freeze(Object.fromEntries(WATCHLIST.map((entry) => [entry.id, entry])));

export const ENTITY_PAGE_SIZE = 12;

/** Direct feeds that serve public RSS to a runner. */
export const FEEDS = Object.freeze([
  {
    id: 'supercrosslive',
    label: 'Supercross Live',
    provider: 'Monster Energy AMA Supercross',
    homepage: 'https://www.supercrosslive.com/',
    url: 'https://www.supercrosslive.com/rss',
  },
  {
    id: 'supermotocross',
    label: 'SuperMotocross',
    provider: 'SMX World Championship',
    homepage: 'https://www.supermotocross.com/',
    url: 'https://www.supermotocross.com/feed/',
  },
  {
    id: 'pulpmx',
    label: 'PulpMX',
    provider: 'PulpMX',
    homepage: 'https://www.pulpmx.com/',
    url: 'https://www.pulpmx.com/feed',
  },
  {
    id: 'motoonline',
    label: 'MotoOnline',
    provider: 'MotoOnline (AU)',
    homepage: 'https://www.motoonline.com.au/',
    url: 'https://www.motoonline.com.au/feed/',
  },
  {
    id: 'mxgp',
    label: 'MXGP',
    provider: 'MXGP World Championship',
    homepage: 'https://www.mxgp.com/',
    url: 'https://www.mxgp.com/rss.xml',
  },
  {
    id: 'mxvice',
    label: 'MX Vice',
    provider: 'MX Vice',
    homepage: 'https://mxvice.com/',
    url: 'https://mxvice.com/feed/',
  },
  {
    id: 'vurbmoto',
    label: 'Vurbmoto',
    provider: 'Vurbmoto',
    homepage: 'https://vurbmoto.com/',
    url: 'https://vurbmoto.com/feed/',
  },
]);

const FEED_DOMAINS = FEEDS.map((feed) => {
  try {
    return new URL(feed.homepage).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}).filter(Boolean);

/**
 * Outlets whose own domain is enough to place a story in motocross. These are
 * used only for context-gated riders, so an interview titled "Five Questions:
 * Jorge Prado" on MotoOnline is kept even though the headline has no keyword.
 * Matching is by hostname, not the publisher's display text, because a display
 * name is easy to spoof and tends to change.
 */
export const MOTOCROSS_DOMAINS = Object.freeze([
  ...new Set([
    ...FEED_DOMAINS,
    'motoonline.com',
    'racerxonline.com',
    'transworldmotocross.com',
    'twmx.com',
    'cyclenews.com',
    'gatedrop.com',
    'mxnews-online.com',
    'mx1onboard.com',
    'motocrossactionmag.com',
    'dirtbikemagazine.com',
    'vitalmx.com',
    'racer.com',
    'bikeridermagazine.co.nz',
    'dirthub.co.uk',
    'fullnoise.com.au',
    'fim-live.com',
    'fim-europe.com',
  ]),
]);

/** Configured sources whose records are unambiguously motocross. */
export const MOTOCROSS_SOURCE_IDS = Object.freeze([
  ...FEEDS.map((feed) => feed.id),
  'yt-supercrosslive',
  'yt-supermotocross',
  'yt-vitalmx',
  'yt-motocrossaction',
  'yt-dirtbikemag',
  'yt-pulpmx',
  'yt-gypsytales',
  'yt-racerx',
  'yt-whiskeythrottle',
]);

/**
 * A rider-name query answers only a bounded number of terms, so the watchlist is
 * asked for in small groups rather than one hand-picked shortlist: a long OR list
 * silently stops covering its tail. Adding a rider to RIDERS is therefore all it
 * takes for the news pass to look for them — no query has to be edited by hand.
 */
export const RIDER_QUERY_GROUP_SIZE = 8;

function riderNameQueries() {
  const groupCount = Math.ceil(RIDERS.length / RIDER_QUERY_GROUP_SIZE);
  // Dealt out round-robin rather than sliced in order. The watchlist is ordered by
  // how well covered a rider is, so a straight slice leaves the quiet tail in
  // groups that return nothing build after build. One rider per group at a time
  // keeps every group mixed and worth asking.
  const groups = Array.from({ length: groupCount }, () => []);
  RIDERS.forEach((rider, index) => groups[index % groupCount].push(rider));
  return groups.map((group, index) => ({
    id: `gnews-riders-${index + 1}`,
    label: `Rider names ${index + 1}/${groups.length}`,
    query: group.map((rider) => `"${rider.name}"`).join(' OR '),
    when: '2d',
  }));
}

/** Google News topic queries stand in for the outlets that block runners. */
export const NEWS_QUERIES = Object.freeze([
  { id: 'gnews-motocross', label: 'Motocross', query: 'motocross', when: '3d' },
  { id: 'gnews-supercross', label: 'Supercross', query: 'supercross', when: '3d' },
  { id: 'gnews-mxgp', label: 'MXGP', query: 'MXGP', when: '3d' },
  { id: 'gnews-smx', label: 'SuperMotocross', query: 'SuperMotocross motocross', when: '3d' },
  // Named riders catch the story whose headline never says "motocross",
  // which is most of them once the race reports are written.
  ...riderNameQueries(),
  { id: 'gnews-pro-motocross', label: 'Pro Motocross', query: '"Pro Motocross" OR "motocross national"', when: '3d' },
]);

export const GOOGLE_NEWS_ENDPOINT = 'https://news.google.com/rss/search';

/**
 * Search-index spam that is technically a motocross headline and not a story:
 * scraped live-stream pages with no reporting behind them. Dropped before they
 * can count as chatter.
 */
export const NEWS_TITLE_DENYLIST = Object.freeze([
  /\blive ?stream(s|ing)?\b/i,
  /\bwatch live\b/i,
  /\blive updates?\b/i,
  /\b(free|full) (live )?stream\b/i,
  /『[^』]*』/,
  /\bstreaming live\b/i,
  /\btoday live\b/i,
  /\blive score(card)?\b/i,
]);

// The channel id is what YouTube's public Atom feed needs; it was resolved from
// each handle on 2026-11-13 and is stable. The feed is read first because it is
// documented, dated, and carries view counts; the channel page is the fallback.
export const YOUTUBE_CHANNELS = Object.freeze([
  { id: 'yt-supercrosslive', handle: 'SupercrossLIVE', channelId: 'UCcAjWBbd4aO4AhoovRKNbag', label: 'Monster Energy Supercross' },
  { id: 'yt-supermotocross', handle: 'SuperMotocross', channelId: 'UCkaNo2FUEWips2z4BkOHl6Q', label: 'SuperMotocross' },
  { id: 'yt-vitalmx', handle: 'vitalmx', channelId: 'UCcX5xwMOCt92bi0dmspMFQw', label: 'Vital MX' },
  { id: 'yt-motocrossaction', handle: 'motocrossaction', channelId: 'UCdsTZGGXC9xtLjGeuLJTBlg', label: 'Motocross Action' },
  { id: 'yt-dirtbikemag', handle: 'DirtBikeMagazine', channelId: 'UCeKccRs9icuvfnQ2Z6Yf6gQ', label: 'Dirt Bike Magazine' },
  // The OEM channels post a handful of times a season, so they were replaced
  // by outlets that publish every week. A wrong handle is a 404, and a wrong
  // channel id makes the feed answer 404, so a typo cannot linger unnoticed.
  { id: 'yt-pulpmx', handle: 'pulpmx', channelId: 'UCpMfM2f4b6ehg1H_olAx02Q', label: 'PulpMX' },
  { id: 'yt-gypsytales', handle: 'gypsytales', channelId: 'UCsBGR5UR7UCyLvNbHSxisFQ', label: 'Gypsy Tales' },
  { id: 'yt-racerx', handle: 'RacerXIllustrated', channelId: 'UCzLDrufzDTIQX_F20r0EiMA', label: 'Racer X' },
  { id: 'yt-whiskeythrottle', handle: 'whiskeythrottle', channelId: 'UCeYlMNQb9nichyHaBZEWtFg', label: 'Whiskey Throttle' },
]);

export const YOUTUBE_BASE = 'https://www.youtube.com';
export const YOUTUBE_FEED_BASE = 'https://www.youtube.com/feeds/videos.xml';

/**
 * Optional operator-run RSS bridge (a self-hosted RSSHub, for example) for X,
 * which still refuses anonymous reads. Nothing is fetched from it unless
 * MOTOBUZZ_BRIDGE_URL is set for the build.
 */
export const BRIDGE_HANDLES = Object.freeze([
  { id: 'x-supercross', network: 'twitter', handle: 'SupercrossLIVE', label: 'X · Supercross Live' },
  { id: 'x-mxgp', network: 'twitter', handle: 'MXGP', label: 'X · MXGP' },
]);

export const FETCH = Object.freeze({
  timeoutMs: 12_000,
  maxBytes: 4 * 1024 * 1024,
  /**
   * Google News answers a burst of index queries with throttling, and a throttled
   * query comes back as an empty feed rather than an error. The twelve queries
   * therefore run one at a time with this pause between them.
   */
  googleNewsSpacingMs: 1_500,
  /** Pause before the one retry a Google query gets when it answered with nothing. */
  googleNewsRetryMs: 4_000,
});

export const INGEST = Object.freeze({
  itemsPerFeed: 30,
  itemsPerChannel: 12,
  itemsPerBridge: 12,
  maxTitleLength: 240,
  maxSummaryLength: 320,
  bridgeTimeoutMs: 20_000,
  /** Bytes kept from a page that failed to parse, for after-the-fact diagnosis. */
  diagnosticBytes: 4096,
});

/** Gitignored, build-local: one excerpt per source that failed to parse. */
export const DIAGNOSTICS_PATH = 'data/diagnostics';

/** Below this share of configured sources answering, the page says so. */
export const COVERAGE = Object.freeze({ minLiveShare: 0.7 });

/** The static snapshot built by the hourly GitHub Actions workflow. */
export const CACHE_URL = new URL('../data/buzz-cache.json', import.meta.url).href;
export const CACHE_SCHEMA_VERSION = 1;
export const CACHE_STALE_HOURS = 2;
export const AUTO_REFRESH_MS = 10 * 60 * 1000;
export const CLOCK_TICK_MS = 30 * 1000;
export const FEED_PAGE_SIZE = 30;
