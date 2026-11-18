# MotoBuzz

A running readout of what the motocross world is talking about, rebuilt once an hour by GitHub Actions.

MotoBuzz reads public motocross news and the YouTube channels of riders, teams, and brands, then turns
that pile into one number, a sentence, a few named trends, and a browsable feed. Nothing is stored about you,
no model writes the score, and the page never contacts a source directly: it downloads one same-origin JSON
snapshot and renders it. The only model-written text is a clearly labelled digest whose claims each cite the records
they came from; switch it off and nothing else changes.

The build, the adapters, and the maths behind the number are written up in [`docs/paper.md`](docs/paper.md).

The buzz is a measurement of published chatter. It is not a claim about what is true, important, or popular in the
sport, and it never invents an injury, a signing, or a result that no source published.

---

## How the data reaches the browser

```
GitHub Actions (hourly, minute 23)
  ├─ npm test
  ├─ start the allowlisted relay on the runner
  ├─ scripts/build-buzz-cache.js
  │    ├─ news adapters   → official RSS + Google News topic queries
  │    ├─ youtube adapter → public channel pages (scraped, best effort)
  │    ├─ bridge adapter  → your own RSS bridge, only if configured
  │    ├─ classify        → topics, riders, brands, teams, series, region
  │    ├─ dedupe + retain → one copy per story, older records carried forward
  │    └─ score           → energy, decay, momentum, buckets, heat tables
  ├─ assemble dist/ (app + data/buzz-cache.json)
  └─ deploy that artifact to GitHub Pages
```

The browser makes exactly one request: `data/buzz-cache.json?v=<ten-minute bucket>`. It never talks to a feed, the
relay, or a third-party API, so there is no CORS problem and no key anywhere near the client.

## What "the buzz" means

### Energy and the score

Every record in the window carries energy:

```
energy = kind weight × engagement × 2^(−age in hours ÷ half-life in hours)
```

- `kind weight` is 1 for news and 0.9 for social.
- `engagement` is 1 for news, and for social it is `1 + log10(1 + score)/1.6`, so a video with a large audience
  counts for more but cannot swallow the board.
- Recency is a half-life decay, not a step function.

The meter is `100 × (1 − e^(−total energy ÷ 26))`: it climbs steeply with the first few stories and flattens out as
the room gets loud. The constant is held at 26. A post-removal review of eleven stored builds, with the Instagram
and Reddit records filtered out, put off-season days at 6.3–13.4 energy, which reads 21–43 on this scale — Idling to
Warming up, where a quiet stretch belongs. A lower constant (18) was tried and rejected: it made an ordinary
off-season day read Running hot, and the sample has no race weekend in it. `npm run calibrate` reprints the
distribution and says why its own suggestion is not a target; re-run it with a race weekend included before changing
the constant.

| Score | Label | Reading |
| --- | --- | --- |
| 0–14 | Quiet | Almost nothing new is landing |
| 15–34 | Idling | A slow stretch of the week |
| 35–54 | Warming up | The paddock is starting to talk |
| 55–74 | Running hot | Plenty of fresh chatter across sources |
| 75–100 | Redline | Everything is talking at once |

### Momentum

The last six hours are compared with the six-hour average of the eighteen hours before them. Above 1.2× is **rising**,
below 0.85× is **cooling**, anything else is **holding**. Every rider, brand, and topic row carries its own momentum,
which is why one name can be cooling while the room is getting louder. A row prints a multiplier only once it has three
records in the window; with one or two there is nothing to compare, so it shows no number.

### Decay and eligibility

| Kind | Half-life | Drops out |
| --- | --- | --- |
| News | 8 hours | 48 hours after publication |
| Social | 5 hours | 72 hours after publication |

The score uses a 24-hour window. The cache retains up to 72 hours for browsing, capped at 380 records.

### Topics and names

- Eight fixed topics — signings, injuries, results, schedules, bikes and tech, teams and business, rules and safety,
  culture and media — scored by keyword hits, with title hits weighted double.
- A watchlist of riders, brands, teams, and series, matched through aliases. Surnames only become aliases when they
  are distinctive; a bare "Cooper" or "Martin" is never counted, so one rider cannot inherit another's buzz. A rider
  whose full name is shared with someone else can be marked `contextRequired`, which makes a motocross term in the
  title or summary, or an outlet whose domain or configured source id is a known motocross publication,
  mandatory before the name counts. Brands and teams use a stricter MX-only tier: generic words such as "bike" and
  "racing" are not enough, and specific product terms such as Civic, Africa Twin, or e-MTB veto the hit, so a car
  review mentioning Honda is not counted as motocross. An MX-only model name counts in that tier — `Desmo450`
  places a Ducati story — and `Stark Future` is the one ungated brand, because both of its names are MX-only on
  their own. Generic words such as pilot, passport, marine, aircraft, and piano are deliberately not vetoes
  because they can appear in real race coverage. `npm run riders:audit` checks
  recent headlines for gated riders, brands, and teams; it fails when a non-MX mention still counts, an MX mention is
  dropped, or an MX mention is dropped only because a product term matched.
- A region read: American series versus world championship, from venue and series words.

Everything lives in [`src/config.js`](src/config.js). Topics and names are deterministic lists. The one model-written
piece of text is the optional digest, which is labelled on the page and never feeds the score.

## Sources

| Source | Kind | Endpoint | Why this one |
| --- | --- | --- | --- |
| Supercross Live | news | `supercrosslive.com/rss` | Official Monster Energy AMA Supercross feed |
| SuperMotocross | news | `supermotocross.com/feed/` | Official SMX World Championship feed |
| PulpMX | news | `pulpmx.com/feed/` | The show and the shop talk that break signings and injuries first |
| MotoOnline | news | `motoonline.com/au/feed/` | Australian MX coverage, still publishing daily through the off-season |
| MX Vice | news | `mxvice.com/feed/` | Publishes daily, including race weekends, and was one of the outlets the index used to supply |
| Vurbmoto | news | `www.vurbmoto.com/feed/` | Same reasoning: a daily outlet read directly instead of through the index |
| Google News × 12 | news | `news.google.com/rss/search?q=…&when:3d` | Reaches Racer X, Vital MX, Dirt Bike, and the rest, which block datacenter traffic or have no feed of their own; seven of the queries name riders from the watchlist, so a headline that never says "motocross" still counts |
| 8 YouTube channels | social | `youtube.com/feeds/videos.xml?channel_id=…` | The documented channel feed, with the channel page as a fallback; series, magazines, and shows that publish every week. Vital MX and Gypsy Tales also publish mountain-bike, MMA, MotoGP and F1 videos, so their uploads count only when they say motocross in their own words or name a watchlist entry whose gate passes; a gated brand alone is enough, so `NON_MOTOCROSS_PRODUCTS` is the only guard on that path |

Google News items carry the real outlet in their `<source>` element, so the publisher shown is the outlet, not the
index. The direct feeds for Racer X, Dirt Bike, and Motocross Action were tested and refused the request; the query
route is the honest way to include them. MXGP's own `rss.xml` was removed in November 2026: its three newest items
were from mid-2025, so a first-party feed that had stopped publishing no longer reports `live` with nothing to show,
and the world series arrives through the MXGP index query instead.

**An index result still has to be a motocross story.** The index answers a query loosely: `motocross` comes back with
a powerboat race report, and a rider-name group comes back with an obituary of an unrelated namesake. A record from a
Google News query is therefore kept only when its own title or summary carries a motocross term, names someone on the
watchlist who passes their gate, or comes from a known motocross outlet. The rest are skipped and counted in that
source's note, so a thin result is visible rather than unexplained. Outcomes that look like a race report but are not
one — `wins`, `title`, `team` — cannot carry another sport's story into Results & titles this way. The same test is
applied to records carried forward from the previous cache, because an already-published story would otherwise survive
the fix for up to two days.

**A thin build says so.** When fewer than `COVERAGE.minLiveShare` (70%) of configured sources answer, the page
prints a coverage note beside the score: "Thin build: N of M sources answered…". The number itself is not rescaled,
because a quiet week and a failed fetch are different claims and only one of them is about the sport.

**X is not scraped.** It still refuses anonymous reads. If you run your own RSS bridge (RSSHub, for example), set
`MOTOBUZZ_BRIDGE_URL` for the build and the handles in `BRIDGE_HANDLES` are read through it, labelled as bridged.
Without it those sources report `not configured` on the page.

**The LLM pass is optional and cannot invent facts.** If `LLM_API_KEY` is set, one request per build asks a model to
label the records the keyword classifier could not place at all, such as a bare caption like "Week 1". It may only
return topic and entity ids that already exist in `src/config.js`; everything else is discarded, and it never supplies
a date, an engagement number or a URL. Without the key, or after any error, the keyword labels stand unchanged.
The settings mirror murmur's news model: Z.ai's OpenAI-compatible endpoint, `glm-4.5-flash`, Z.ai "thinking" disabled,
a 60-second timeout and one retry on 429 or 5xx. `LLM_MODEL` and `LLM_API_BASE` override them, and `ZAI_API_KEY` or
`NEWS_MODEL_API_KEY` are accepted in place of `LLM_API_KEY`.

**The digest is one optional call, titles only, and out of the score.** After scoring, the same model settings may make
one more request with up to 48 records, giving it only each record's id, title, publisher, topics, and entities — never
a summary or an article body. Records covering the same event are grouped first and the groups are ranked by their
combined weight, so the model gets stories rather than a flat list. It must return 1–4 short claims, one per story,
one per line as `claim || recordId` (JSON is also accepted), citing that story's records. Claims
citing an id that is not in the build are discarded, as are claims with no citation, and a failed or unconfigured call
leaves the digest empty. The page shows surviving claims in a panel marked *written by a model*, in story order and with every citation
linked to its record. The digest cannot change a record, the energy total, the headline, or any table, and it is not
part of `buzz`; it is stored beside it as an optional `digest` field.

## Local development

Requires Node 18.17 or newer. There is no install step and no dependencies.

```bash
npm start          # static server + allowlisted relay on http://127.0.0.1:8080
```

In a second terminal, build a cache through the relay:

```bash
npm run cache:local
```

Then open <http://127.0.0.1:8080>. `npm run cache` fetches directly instead, which is what the runner does when no
relay is configured.

Useful flags and variables:

```bash
node scripts/build-buzz-cache.js --relay http://127.0.0.1:8080
node scripts/build-buzz-cache.js --out ./data/buzz-cache.json --previous ./data/buzz-cache.json
MOTOBUZZ_BRIDGE_URL=https://your-bridge.example node scripts/build-buzz-cache.js
MOTOBUZZ_RELAY=http://127.0.0.1:8080 node scripts/build-buzz-cache.js
npm run calibrate                                  # score distribution of stored caches
npm run watchlist:audit                            # quiet riders and unwatched names
npm run riders:audit -- --days 90                  # gated riders, brands, and teams
node scripts/build-feed.js data/buzz-cache.json dist/feed.xml
PORT=8099 HOST=0.0.0.0 npm start
```

`data/` is generated and gitignored.

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.** This is a one-time setting; the workflow
   cannot enable Pages with the default token.
3. Optionally add a repository variable `MOTOBUZZ_PUBLIC_URL` pointing at
   `https://<user>.github.io/<repo>/data/buzz-cache.json`. The build fetches it first so records survive a bad hour.
4. Optionally add `MOTOBUZZ_BRIDGE_URL` as a repository variable (not a secret) if you run a social bridge.
   Add `MOTOBUZZ_SITE_URL` if the site is served from a custom domain, so `feed.xml`'s absolute links point there.
5. Run **Buzz cache and Pages** from the Actions tab, or push to `main`.

The workflow runs at minute 23 of every hour, on every push to `main`, and on manual dispatch. Because nothing is
committed between builds, GitHub would otherwise disable the hourly trigger after 60 days without repository activity;
a `keepalive` job re-enables the workflow through the API on every scheduled run, which resets that counter. If every source fails,
the builder exits non-zero and the previous successful deployment stays online. Partial failures still deploy, with
each source's state shown on the page.

## Cache format

`data/buzz-cache.json`:

```json
{
  "schemaVersion": 1,
  "generatedAt": 1793500000000,
  "site": { "name": "MotoBuzz", "timezone": "America/New_York", "scoreHours": 24, "retainHours": 72 },
  "build": { "relay": true, "bridge": false, "sourcesLive": 12, "duplicatesDropped": 39 },
  "buzz": {
    "score": 46,
    "label": "Warming up",
    "headline": "Ken Roczen is carrying the room. …",
    "momentum": 1.41,
    "momentumLabel": "rising",
    "counts": { "news": 31, "social": 9 },
    "buckets": [{ "start": 1793498400000, "energy": 3.2, "items": 4 }]
  },
  "threads": [{ "id": "topic:signings", "label": "Signings & contracts", "share": 0.31 }],
  "entities": [{ "id": "ken-roczen", "kind": "rider", "name": "Ken Roczen", "mentions": 7 }],
  "region": { "us": 0.62, "world": 0.18, "mixed": 0.12, "unknown": 0.08 },
  "sources": [{ "sourceId": "gnews-motocross", "status": "live", "recordCount": 19 }],
  "items": [{ "id": "3f2a1b", "title": "…", "url": "https://…", "publishedAt": 1793499000000 }],
  "digest": {
    "model": "glm-4.5-flash",
    "generatedAt": 1793500000000,
    "claims": [{ "text": "Two teams confirmed riders for 2027.", "recordIds": ["3f2a1b"] }]
  }
}
```

`src/engine/validate.js` checks the envelope, the buzz block, every record, every source, and every digest citation
before the page renders anything. An invalid envelope is rejected whole so a broken snapshot cannot replace a good one; individual bad records
are dropped and counted.

## The published feed

`dist/feed.xml` is an Atom feed of the same records, written by `scripts/build-feed.js` from the cache after the
build. It carries the newest 30 records with their link, publisher, and publish time, plus the current headline, and
`index.html` links to it as the alternate feed. Nothing in it is generated separately from the cache, and every link
in it is absolute: the site origin comes from the `MOTOBUZZ_SITE_URL` repository variable when set, otherwise from
`GITHUB_REPOSITORY` as `https://<owner>.github.io/<repo>/`, and a local run uses `http://127.0.0.1:8080/`.

## Adding a source or a name

- **A rider, brand, team, or series**: add an entry with a `name` and `aliases` to `RIDERS`, `BRANDS`, `TEAMS`, or
  `SERIES` in `src/config.js`. Aliases are matched on word boundaries against a normalized copy of the title. A new
  rider is also searched for by name automatically: `NEWS_QUERIES` derives its rider-name queries from `RIDERS`,
  dealt round-robin into groups of up to `RIDER_QUERY_GROUP_SIZE`, because Google News honours only a bounded number
  of terms per query and a quiet rider in a group of quiet riders returns nothing.
- **A news feed**: add it to `FEEDS` in `src/config.js` and to `ALLOWED_UPSTREAMS` in `proxy/allowlist.js` if the relay
  should reach it too.
- **A YouTube channel**: add to `YOUTUBE_CHANNELS` with the handle and the 24-character channel id (the feed URL on
the channel page has it). The build reads `feeds/videos.xml?channel_id=…` first and the channel page second.
- **A topic**: add to `TOPICS` with its keywords.

## Privacy and limitations

- No accounts, analytics, trackers, cookies, or third-party scripts. The only browser storage is one `localStorage`
  key holding your previous visit time, used for the "since you last looked" line.
- The browser downloads one same-origin JSON cache. Headlines never leave your machine.
- If the digest is enabled, the build sends only record ids and titles (plus publisher, topics, and entities) to the
  configured model endpoint. Article bodies are never fetched or sent.
- The cache contains only public records: titles, links, publisher names, timestamps, and the audience numbers those
  sources already publish.
- YouTube is read from each channel's public Atom feed first, with the channel page as a fallback. When neither
  parses, the source reports `malformed` and keeps a small excerpt under `data/diagnostics/` (gitignored, never
  published) so the next person can see what changed; every other source keeps working.
- A build in which fewer than 70% of sources answered is labelled thin on the page. The score is not adjusted for it.
- Google News links point at a Google redirect; the publisher and its homepage are stored alongside.
- Greenhouse cases: a quiet weekend really does read as a low score, and the page says so instead of manufacturing
  drama.

## Files

```
index.html                  page shell
styles.css                  all styling
proxy/server.js             local static server + allowlisted relay
proxy/allowlist.js          every upstream the relay may reach
scripts/build-buzz-cache.js the hourly build
scripts/build-feed.js       Atom feed written from the cache into dist/
scripts/check-article-text.js  read-only survey of article text served to the build
scripts/audit-rider-context.js repeatable gated-entity audit
src/engine/audit.js         pure false-positive / near-miss decisions for that audit
scripts/calibrate.js        score-distribution report for the meter
scripts/watchlist-audit.js  quiet riders and unwatched names in a cache
docs/paper.md               the paper: build system, adapters, classification, scoring
docs/article-readability.md what outlets actually serve to the build
src/config.js               feeds, watchlist, topics, decay, thresholds
src/adapters/               news, youtube, bridge, feed parser, http
src/engine/classify.js      topics, names, region
src/engine/score.js         energy, decay, momentum, heat, headline
src/engine/pipeline.js      continuity, dedupe, source status
src/engine/digest.js        optional, cited, titles-only model digest
src/engine/feed.js          Atom feed generation
src/engine/diagnostics.js   excerpt writing for failed parses
src/engine/validate.js      cache validation used by both build and page
src/lib/text.js             entity decoding, normalization, URL and count parsing
src/app/                    cache loader, renderer, bootstrap, formatters
tests/run.js                the suite
```

## Tests

```bash
npm test
```

89 tests using only Node's built-in assertions: text decoding, feed and Atom parsing, malformed-versus-empty
diagnostics, the YouTube channel-feed reader and page extractor against fixtures, classifier and alias safety,
decay and momentum, saturation, bucket accounting, cache validation, the digest's citation rules and fail-open path,
the relay allowlist, continuity and dedupe, deprecated-source filtering, source status, the thin-build note,
diagnostics, and the Atom feed.
