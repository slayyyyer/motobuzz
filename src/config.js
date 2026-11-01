/**
 * MotoBuzz's fixed configuration.
 *
 * Everything a person might reasonably want to change lives here: the feeds,
 * the subreddits, the rider and brand watchlist, the topic keywords, the decay
 * schedule, and the thresholds that turn accumulated chatter into a number.
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

/** Buzz score = 100 × (1 − e^(−energy / saturationEnergy)). */
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
 * about a different Martin or Cooper cannot be counted for a rider.
 */
export const RIDERS = Object.freeze([
  { id: 'jett-lawrence', name: 'Jett Lawrence', aliases: ['Jett Lawrence', 'Jett'] },
  { id: 'hunter-lawrence', name: 'Hunter Lawrence', aliases: ['Hunter Lawrence'] },
  { id: 'eli-tomac', name: 'Eli Tomac', aliases: ['Eli Tomac', 'Tomac'] },
  { id: 'cooper-webb', name: 'Cooper Webb', aliases: ['Cooper Webb', 'Webb'] },
  { id: 'chase-sexton', name: 'Chase Sexton', aliases: ['Chase Sexton', 'Sexton'] },
  { id: 'ken-roczen', name: 'Ken Roczen', aliases: ['Ken Roczen', 'Roczen'] },
  { id: 'aaron-plessinger', name: 'Aaron Plessinger', aliases: ['Aaron Plessinger', 'Plessinger'] },
  { id: 'jason-anderson', name: 'Jason Anderson', aliases: ['Jason Anderson', 'El Hombre'] },
  { id: 'malcolm-stewart', name: 'Malcolm Stewart', aliases: ['Malcolm Stewart', 'Mookie'] },
  { id: 'haiden-deegan', name: 'Haiden Deegan', aliases: ['Haiden Deegan', 'Deegan'] },
  { id: 'rj-hampshire', name: 'RJ Hampshire', aliases: ['RJ Hampshire', 'Hampshire'] },
  { id: 'jo-shimoda', name: 'Jo Shimoda', aliases: ['Jo Shimoda', 'Shimoda'] },
  { id: 'levi-kitchen', name: 'Levi Kitchen', aliases: ['Levi Kitchen'] },
  { id: 'chance-hymas', name: 'Chance Hymas', aliases: ['Chance Hymas', 'Hymas'] },
  { id: 'cole-davies', name: 'Cole Davies', aliases: ['Cole Davies'] },
  { id: 'julien-beaumer', name: 'Julien Beaumer', aliases: ['Julien Beaumer', 'Beaumer'] },
  { id: 'seth-hammaker', name: 'Seth Hammaker', aliases: ['Seth Hammaker', 'Hammaker'] },
  { id: 'nate-thrasher', name: 'Nate Thrasher', aliases: ['Nate Thrasher', 'Thrasher'] },
  { id: 'justin-cooper', name: 'Justin Cooper', aliases: ['Justin Cooper'] },
  { id: 'dylan-ferrandis', name: 'Dylan Ferrandis', aliases: ['Dylan Ferrandis', 'Ferrandis'] },
  { id: 'max-anstie', name: 'Max Anstie', aliases: ['Max Anstie', 'Anstie'] },
  { id: 'justin-barcia', name: 'Justin Barcia', aliases: ['Justin Barcia', 'Barcia'] },
  { id: 'pierce-brown', name: 'Pierce Brown', aliases: ['Pierce Brown'] },
  { id: 'ty-masterpool', name: 'Ty Masterpool', aliases: ['Ty Masterpool', 'Masterpool'] },
  { id: 'cameron-mcadoo', name: 'Cameron McAdoo', aliases: ['Cameron McAdoo', 'McAdoo'] },
  { id: 'austin-forkner', name: 'Austin Forkner', aliases: ['Austin Forkner', 'Forkner'] },
  { id: 'tom-vialle', name: 'Tom Vialle', aliases: ['Tom Vialle', 'Vialle'] },
  { id: 'garrett-marchbanks', name: 'Garrett Marchbanks', aliases: ['Garrett Marchbanks', 'Marchbanks'] },
  { id: 'dean-wilson', name: 'Dean Wilson', aliases: ['Dean Wilson'] },
  { id: 'jeremy-martin', name: 'Jeremy Martin', aliases: ['Jeremy Martin'] },
  { id: 'adam-cianciarulo', name: 'Adam Cianciarulo', aliases: ['Adam Cianciarulo', 'Cianciarulo'] },
  { id: 'jeffrey-herlings', name: 'Jeffrey Herlings', aliases: ['Jeffrey Herlings', 'Herlings'] },
  { id: 'tim-gajser', name: 'Tim Gajser', aliases: ['Tim Gajser', 'Gajser'] },
  { id: 'jorge-prado', name: 'Jorge Prado', aliases: ['Jorge Prado'] },
  { id: 'romain-febvre', name: 'Romain Febvre', aliases: ['Romain Febvre', 'Febvre'] },
  { id: 'glenn-coldenhoff', name: 'Glenn Coldenhoff', aliases: ['Glenn Coldenhoff', 'Coldenhoff'] },
  { id: 'kay-de-wolf', name: 'Kay de Wolf', aliases: ['Kay de Wolf', 'de Wolf'] },
  { id: 'lucas-coenen', name: 'Lucas Coenen', aliases: ['Lucas Coenen'] },
  { id: 'sacha-coenen', name: 'Sacha Coenen', aliases: ['Sacha Coenen'] },
  { id: 'andrea-adamo', name: 'Andrea Adamo', aliases: ['Andrea Adamo'] },
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
  { id: 'ktm', name: 'KTM', aliases: ['KTM'] },
  { id: 'honda', name: 'Honda', aliases: ['Honda', 'HRC'] },
  { id: 'kawasaki', name: 'Kawasaki', aliases: ['Kawasaki'] },
  { id: 'yamaha', name: 'Yamaha', aliases: ['Yamaha', 'Yam'] },
  { id: 'suzuki', name: 'Suzuki', aliases: ['Suzuki'] },
  { id: 'husqvarna', name: 'Husqvarna', aliases: ['Husqvarna', 'Husky'] },
  { id: 'gasgas', name: 'GASGAS', aliases: ['GASGAS', 'Gas Gas'] },
  { id: 'triumph', name: 'Triumph', aliases: ['Triumph'] },
  { id: 'ducati', name: 'Ducati', aliases: ['Ducati'] },
  { id: 'stark', name: 'Stark Future', aliases: ['Stark Future', 'Stark Varg'] },
  { id: 'beta', name: 'Beta', aliases: ['Beta Motorcycles', 'Beta Racing'] },
  { id: 'fantic', name: 'Fantic', aliases: ['Fantic'] },
]);

export const TEAMS = Object.freeze([
  { id: 'red-bull-ktm', name: 'Red Bull KTM', aliases: ['Red Bull KTM'] },
  { id: 'honda-hrc', name: 'Honda HRC', aliases: ['Honda HRC', 'HRC Honda', 'Team Honda'] },
  { id: 'monster-kawasaki', name: 'Monster Energy Kawasaki', aliases: ['Monster Energy Kawasaki', 'Monster Kawasaki'] },
  { id: 'star-racing-yamaha', name: 'Star Racing Yamaha', aliases: ['Star Racing', 'Monster Energy Yamaha Star Racing'] },
  { id: 'rockstar-husqvarna', name: 'Rockstar Energy Husqvarna', aliases: ['Rockstar Energy Husqvarna', 'Rockstar Husqvarna'] },
  { id: 'tld-gasgas', name: 'Troy Lee Designs GASGAS', aliases: ['Troy Lee Designs', 'TLD GASGAS', 'TLD Red Bull GASGAS'] },
  { id: 'ecstar-suzuki', name: 'Progressive ECSTAR Suzuki', aliases: ['ECSTAR Suzuki', 'Progressive Suzuki', 'Suzuki Factory Racing'] },
  { id: 'nestaan-husqvarna', name: 'Nestaan Husqvarna', aliases: ['Nestaan'] },
  { id: 'kawasaki-racing-team', name: 'Kawasaki Racing Team', aliases: ['Kawasaki Racing Team', 'KRT'] },
]);

export const SERIES = Object.freeze([
  { id: 'supercross', name: 'Monster Energy Supercross', aliases: ['Monster Energy Supercross', 'Supercross', 'SX'] },
  { id: 'pro-motocross', name: 'AMA Pro Motocross', aliases: ['Pro Motocross', 'AMA Motocross', 'Motocross Nationals'] },
  { id: 'smx', name: 'SuperMotocross', aliases: ['SuperMotocross', 'SMX', 'SMX World Championship', 'SMX Playoffs'] },
  { id: 'mxgp', name: 'MXGP', aliases: ['MXGP', 'FIM Motocross World Championship'] },
  { id: 'mxon', name: 'Motocross of Nations', aliases: ['Motocross of Nations', 'MXoN', 'MXON'] },
  { id: 'wsx', name: 'World Supercross', aliases: ['World Supercrosstitle', 'WSX'] },
  { id: 'loretta', name: "Loretta Lynn's", aliases: ["Loretta Lynn's", 'Lorettas', 'Loretta'] },
  { id: 'world-vet', name: 'World Vet Championship', aliases: ['World Vet'] },
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
]);

/** Google News topic queries stand in for the outlets that block runners. */
export const NEWS_QUERIES = Object.freeze([
  { id: 'gnews-motocross', label: 'Motocross', query: 'motocross', when: '3d' },
  { id: 'gnews-supercross', label: 'Supercross', query: 'supercross', when: '3d' },
  { id: 'gnews-mxgp', label: 'MXGP', query: 'MXGP', when: '3d' },
  { id: 'gnews-smx', label: 'SuperMotocross', query: 'SuperMotocross motocross', when: '3d' },
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

export const SUBREDDITS = Object.freeze([
  { id: 'reddit-motocross', sub: 'Motocross', label: 'r/Motocross' },
  { id: 'reddit-supercross', sub: 'supercross', label: 'r/supercross' },
  { id: 'reddit-mxgp', sub: 'MXGP', label: 'r/MXGP' },
]);

export const REDDIT_ENDPOINT = 'https://www.reddit.com';

export const YOUTUBE_CHANNELS = Object.freeze([
  { id: 'yt-supercrosslive', handle: 'SupercrossLIVE', label: 'Monster Energy Supercross' },
  { id: 'yt-supermotocross', handle: 'SuperMotocross', label: 'SuperMotocross' },
  { id: 'yt-vitalmx', handle: 'vitalmx', label: 'Vital MX' },
  { id: 'yt-motocrossaction', handle: 'motocrossaction', label: 'Motocross Action' },
  { id: 'yt-dirtbikemag', handle: 'DirtBikeMagazine', label: 'Dirt Bike Magazine' },
  { id: 'yt-ktm', handle: 'KTM', label: 'KTM' },
  { id: 'yt-kawasaki', handle: 'KawasakiUSA', label: 'Kawasaki USA' },
  { id: 'yt-yamaha', handle: 'YamahaMotorUSA', label: 'Yamaha Motor USA' },
  { id: 'yt-suzuki', handle: 'suzukicycles', label: 'Suzuki Cycles' },
  { id: 'yt-ducati', handle: 'Ducati', label: 'Ducati' },
]);

export const YOUTUBE_BASE = 'https://www.youtube.com';

/**
 * Instagram answers a browser with a login shell, but a crawler user agent gets
 * the rendered profile page. These handles were checked against the live pages:
 * a wrong handle still returns 200, but as a tiny account with zero posts.
 */
export const INSTAGRAM_CRAWLER_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export const INSTAGRAM_PROFILES = Object.freeze([
  { id: 'ig-kenroczen', handle: 'kenroczen94', label: 'Instagram · Ken Roczen' },
  { id: 'ig-jettlawrence', handle: 'jettson18', label: 'Instagram · Jett Lawrence' },
  { id: 'ig-haidendeegan', handle: 'dangerboydeegan', label: 'Instagram · Haiden Deegan' },
  { id: 'ig-hunterlawrence', handle: 'hunterlawrence', label: 'Instagram · Hunter Lawrence' },
  { id: 'ig-elitomac', handle: 'elitomac', label: 'Instagram · Eli Tomac' },
  { id: 'ig-chasesexton', handle: 'chasesexton', label: 'Instagram · Chase Sexton' },
  { id: 'ig-cooperwebb', handle: 'cooperwebb2', label: 'Instagram · Cooper Webb' },
  { id: 'ig-supermotocross', handle: 'supermotocross', label: 'Instagram · SuperMotocross' },
  { id: 'ig-supercrosslive', handle: 'supercrosslive', label: 'Instagram · Supercross LIVE' },
  { id: 'ig-mxgp', handle: 'mxgp', label: 'Instagram · MXGP' },
]);

/**
 * Coarse route for hosts Instagram refuses: DuckDuckGo finds post permalinks and
 * microlink reads one post from its own infrastructure. It reports the publish
 * DAY, so its records are marked as day-precision, and the free tier is small —
 * hence the interval and the hard per-run call cap.
 */
export const INSTAGRAM_FALLBACK = Object.freeze({
  searchUrl: 'https://html.duckduckgo.com/html/',
  metadataUrl: 'https://api.microlink.io/',
  searchUserAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  /** Run discovery only every N hours: the metadata API allows tens of calls a day. */
  intervalHours: 3,
  searchResults: 10,
  metadataCallsPerRun: 6,
  postsPerProfile: 2,
});

/**
 * An authenticated read of the same private profile endpoint Instagram's own
 * web app calls. The cookie comes from a manual sign-in made by a person, never
 * from a login attempt here: a datacenter IP is exactly what Instagram
 * challenges, and a failed login is what gets an account flagged.
 */
export const INSTAGRAM_SESSION = Object.freeze({
  appId: '936619743392459',
  /**
   * Instagram answers a bare `400 SecFetch Policy violation.` without these;
   * with them the same request reaches the endpoint and returns real JSON.
   */
  headers: Object.freeze({
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    origin: 'https://www.instagram.com',
    'x-asbd-id': '129477',
    'accept-language': 'en-US,en;q=0.9',
  }),
  profileUrl: 'https://i.instagram.com/api/v1/users/web_profile_info/',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  /** How many of the newest posts to keep per profile when a session works. */
  postsPerProfile: 4,
});

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
  /** Reddit throttles datacenter traffic, so its requests are spaced out. */
  redditSpacingMs: 2_500,
});

export const INGEST = Object.freeze({
  itemsPerFeed: 30,
  itemsPerSubreddit: 25,
  itemsPerChannel: 12,
  itemsPerBridge: 12,
  maxTitleLength: 240,
  maxSummaryLength: 320,
  instagramPostsPerProfile: 4,
  instagramSpacingMs: 700,
  instagramTimeoutMs: 20_000,
  bridgeTimeoutMs: 20_000,
});

/** The static snapshot built by the hourly GitHub Actions workflow. */
export const CACHE_URL = new URL('../data/buzz-cache.json', import.meta.url).href;
export const CACHE_SCHEMA_VERSION = 1;
export const CACHE_STALE_HOURS = 2;
export const AUTO_REFRESH_MS = 10 * 60 * 1000;
export const CLOCK_TICK_MS = 30 * 1000;
export const FEED_PAGE_SIZE = 30;
