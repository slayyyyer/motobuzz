# MotoBuzz: how the number is made

**A paper about a static site that measures motocross chatter, and about the build that keeps it honest.**

---

## Abstract

MotoBuzz publishes a single number between 0 and 100, a one-sentence reading, a set of named
trends, and a browsable feed of headlines. The number is a measurement of *published chatter*:
how much has been said about motocross in the last day, by whom, and how recently. It is not a
claim about what is true, important, or popular, and no record on the page exists because a
program inferred it — every headline, timestamp, and audience count came from a source that
published it.

The site has no framework, no runtime dependencies, no database, and no server of its own. A
GitHub Actions workflow runs once an hour, reads public sources, normalizes and deduplicates
what it finds, classifies it with fixed word lists, converts it into energy, and writes one JSON
file. That file and a handful of static files are deployed to GitHub Pages as a single artifact.
The browser makes exactly one request and renders what it received.

This paper describes the whole path, in the order the build walks it: the schedule, the sources
and their adapters, the record model, continuity across builds, deduplication, classification,
the scoring mathematics, the failure taxonomy, the committed local capture used where a runner
is refused, the client, and the limits of what any of it can support.

---

## 1. The claim, and the constraints that shaped it

Four constraints decided the architecture.

**It must cost nothing and be impossible to break by neglect.** GitHub Actions and Pages are
free for a public repository. There is no host to pay, no certificate to renew, no process to
keep alive. If the build fails, the previous deployment stays online — an unattended project
degrades to "stale but working", never to "down".

**It must not require an account, a key, or a token to do its job.** Everything the build reads
is public. Two optional enrichments exist — a language model to label otherwise unlabelled
records, and an operator-run RSS bridge for X — and both are inert when unconfigured. Removing
every secret from the repository leaves the site working, with one source reported as
`unconfigured` and one labelling pass switched off.

**The browser must not be able to fail.** The page downloads one same-origin JSON file and
renders it. There is no CORS, no pagination, no key in client code, no per-visitor query. A copy
of the site on a laptop with the network unplugged and a cache file on disk renders correctly.

**The measurement must never invent.** No record may carry a date no source published, an
engagement number no source showed, or a URL that does not resolve. Where a source reports only
a day, the record says so (`dateBasis: "day"`) and is not presented as an exact time. Where a
source cannot be read, the page reports the source's condition rather than filling the gap.

Everything that follows is a consequence of those four.

---

## 2. System topology

```
                       ┌───────────────────────────────────────────┐
                       │                GitHub Actions             │
                       │  hourly · minute 23 · UTC                 │
                       │                                           │
   public sources      │   ┌───────────────────────────────┐       │
   ──────────────      │   │  scripts/build-buzz-cache.js  │       │
   RSS feeds ──────────┼──▶│                               │       │
   Google News ────────┼──▶│  adapters → classify → score  │       │
   Reddit Atom ────────┼──▶│        → validate → write     │       │
   YouTube pages ──────┼──▶│                               │       │
   Instagram pages ────┼──▶└──────────────┬────────────────┘       │
                       │                  │                        │
   ┌───────────────┐   │                  ▼                        │
   │ relay :8080   │◀──┼── news fetches   data/buzz-cache.json     │
   │ allowlisted   │   │                  │                        │
   └───────────────┘   │                  ▼                        │
                       │        dist/  = index.html + styles.css   │
   ┌───────────────┐   │                 + src/ + data/*.json      │
   │ snapshots/    │──▶│                  │                        │
   │ committed by  │   │                  ▼                        │
   │ a home capture│   │        upload-pages-artifact → deploy     │
   └───────────────┘   └──────────────────┬────────────────────────┘
                                          │
                                          ▼
                                  ┌───────────────┐
                                  │ GitHub Pages  │
                                  └───────┬───────┘
                                          │  one same-origin GET
                                          ▼
                                  ┌───────────────┐
                                  │   browser     │  app/cache.js
                                  │ one JSON file │  app/render.js
                                  └───────────────┘
```

*Figure 1 — Every arrow into the build is public HTTP; every arrow out of it is a file.*

Two details in that picture matter more than they look.

The **relay** is a local HTTP server (`proxy/server.js`) started by the workflow on
`127.0.0.1:8080`. It serves two purposes: it is the static server used in local development, and
it is an allowlisted fetch proxy. Its allowlist (`proxy/allowlist.js`) names each upstream origin
and the path prefixes it may reach, so a compromised or misconfigured adapter cannot turn the
build into an open proxy. News feeds are fetched through it; when no relay is configured the
build fetches directly, which is what a laptop run does.

The **committed capture** (`snapshots/*.json`) is source, not output. It is written by a person
running `npm run capture` on an ordinary home connection, committed, and read out of the
checkout by the runner. Section 11 is about it.

---

## 3. The hourly build

`.github/workflows/pages.yml` has three triggers: a cron schedule at minute 23 of every hour, a
push to `main`, and manual dispatch. The offset from the top of the hour dodges the busiest
minute on Actions' scheduler.

```
 0:00  checkout
 0:01  setup-node 20
 0:05  npm test                     ← the suite gates the build
 0:30  node proxy/server.js &       ← relay on :8080
       poll /healthz up to 30×1 s
 0:35  node scripts/build-buzz-cache.js
         ├─ read previous cache (disk, else PREVIOUS_CACHE_URL)
         ├─ read snapshots/instagram.json, snapshots/reddit.json
         ├─ news + YouTube          (all at once, Promise.all)
         ├─ Reddit                  (one at a time, 2.5 s apart)
         ├─ Instagram               (one at a time, 0.7 s apart)
         ├─ bridge                  (unconfigured unless MOTOBUZZ_BRIDGE_URL)
         ├─ continuity + dedupe + cap
         ├─ optional LLM labelling  (only unlabelled records)
         ├─ score                   (energy, decay, momentum, tables)
         ├─ validate its own output (rejects the whole cache if malformed)
         └─ write data/buzz-cache.json + data/social/*.json
 1:40  mkdir dist/ ; copy index.html, styles.css, src/, data/buzz-cache.json,
       touch .nojekyll
 1:45  kill the relay (always, even on failure)
 1:50  configure-pages → upload-pages-artifact(dist)
 1:55  deploy-pages → https://<user>.github.io/motobuzz/
```

*Figure 2 — One build, wall-clock minutes approximate. Total runtime is dominated by Instagram.*

Concurrency is deliberate rather than uniform. News and YouTube sources are independent and run
together. Reddit is serialized with a 2.5-second gap because its throttle is per-IP and a burst
guarantees a 429. Instagram is serialized with 0.7 seconds between profiles for the same reason.

Three properties of this sequence are load-bearing:

- **The tests run before anything is fetched.** A broken parser cannot reach a deployed artifact.
- **The build validates its own output.** If `validateCache()` rejects the cache it just built,
  the process exits non-zero and the step fails. Corrupt data is never uploaded.
- **A total failure preserves the site.** If every source fails, `recordedSources === 0`, the
  builder exits 1, the job fails, and Pages keeps serving the last successful deployment. Partial
  failure is normal and deploys: each source's state is on the page.

The build takes no positional arguments. Three flags and their environment equivalents exist:

| Flag | Environment | Effect |
| --- | --- | --- |
| `--relay <url>` | `MOTOBUZZ_RELAY` | Fetch through the allowlisted relay |
| `--out <path>` | — | Where to write the cache (default `data/buzz-cache.json`) |
| `--previous <path>` | `PREVIOUS_CACHE_URL` | Continuity source; the URL is tried when the file is missing |

---

## 4. What a record is

Every adapter produces the same shape, so nothing downstream needs to know where a record came
from.

| Field | Meaning |
| --- | --- |
| `id` | FNV-1a hash of `sourceId \| url`, stable across builds |
| `sourceId` | The configured source, e.g. `gnews-motocross`, `ig-kenroczen` |
| `kind` | `news` or `social` — selects the decay schedule and engagement model |
| `title` | Truncated at 240 characters by the adapter |
| `summary` | Truncated at 320 characters, or null |
| `url` | Must be `https:`; anything else is dropped |
| `publisher` | The outlet or channel shown to a reader |
| `publisherUrl` | The publisher's homepage, for Google News redirects |
| `channel` | `@handle`, `r/Subreddit`, or null |
| `publishedAt` | Epoch milliseconds, from the source |
| `fetchedAt` | When this build read it |
| `engagement`, `replies` | Social audience counts, or null |
| `dateBasis` | `exact` or `day` — never a guess presented as exact |
| `topics`, `entities`, `region` | Added by `classify()` |

`src/engine/validate.js` enforces this again on the way out: a record with a non-HTTPS URL, an
empty or over-300-character title, an unknown `kind`, a timestamp more than ten years old or more
than an hour in the future, or a `weight` above 60 is dropped and counted. The page runs the same
function before rendering, so a hand-edited cache cannot introduce a record the build would have
refused.

---

## 5. Ingestion

Thirty-eight configured sources, in five families.

| Family | Count | Adapter | Limit | Refusal behaviour |
| --- | --- | --- | --- | --- |
| Direct RSS feeds | 4 | `news.js` | 30 items | `unavailable` / `malformed` |
| Google News queries | 6 | `news.js` | 30 items | same |
| Subreddit Atom | 3 | `reddit.js` | 25 posts | capture, then `unavailable` |
| YouTube channels | 9 | `youtube.js` | 12 videos | `malformed` on markup change |
| Instagram profiles | 14 | `instagram.js` | 4 posts | capture, then coarse route |
| (X via operator bridge) | 2 | `bridge.js` | 12 posts | `unconfigured` by default |

The Google News queries are not a convenience. Racer X, Vital MX, Dirt Bike, and Motocross Action
either refuse datacenter traffic outright or publish no feed, so a query against the index is the
honest way to include them; each item carries its real outlet in a `<source>` element, and that
outlet — not the index — is what the page shows as the publisher. Two of the six queries name
riders explicitly, because once the race reports are written, a headline often says a name and
never says "motocross".

Each adapter normalizes on the way in and refuses to invent on the way out:

- **RSS/Atom** (`feed.js`) parses both dialects, keeps `<pubDate>`/`<updated>`, and distinguishes
  *malformed* (bytes arrived, nothing parsed) from *empty* (parsed fine, no items). That
  distinction is what the page shows, because they mean different things to an operator.
- **Reddit** reads the public Atom feed, drops entries with no date, drops `.rss` self-links, and
  carries no engagement because the feed publishes none. A post therefore contributes volume and
  recency but not audience size — stated on the page rather than papered over.
- **YouTube** scrapes the channel page. It is best-effort by construction; when the markup
  changes those sources report `malformed` and everything else keeps working.
- **Instagram** reads the page served to a crawler, which now arrives as `xig_user_by_username`
  with a `polaris_ordered_timeline_connection` timeline whose posts carry a shortcode and no
  timestamp. Each post's own page supplies the exact `taken_at` epoch plus like and comment
  counts. A post whose own page has no readable timestamp is dropped rather than dated "now".

A filter runs before any headline counts: `NEWS_TITLE_DENYLIST` removes search-index spam —
"watch live", "live stream", bracketed CJK spam — that is technically a motocross headline and
not a story. It also applies to retained records, so a headline the denylist rejects today cannot
survive by being old.

---

## 6. Continuity

A build that fails is not a build that forgets.

```
        previous cache (disk, else PREVIOUS_CACHE_URL)
                     │
                     ▼
        keep only records still eligible for their kind
        drop anything the denylist would reject today
                     │
                     ▼
        retained ─────────────┐
                              │  appended after this build's fresh records,
        fresh records ────────┴─▶ so a fresh copy always wins the dedupe
```

*Figure 3 — Retained records are a floor under the feed, not a substitute for it.*

Retention is bounded by the same decay schedule as the score: a news record is eligible for 48
hours after publication, a social record for 72. Records that survive are re-scored with the rest,
so a carried record decays exactly as an uncarried one would.

---

## 7. Deduplication and the ceiling

One story, one energy contribution. Deduplication uses two keys:

- **URL key** — the URL lowercased, hash and trailing slash removed, and every query parameter
  dropped except `id`, `p`, `story`, and `article` (which several publishers use to identify the
  story itself). `?utm_source=…` cannot make a second record.
- **Title key** — the normalized title, so a syndicated copy under a different URL is still the
  same story.

Fresh records are ordered before retained ones, so when the same story arrives from both, the
fresh copy's timestamp and engagement survive. Duplicates are counted, not hidden; the count is in
`build.duplicatesDropped` and on the page.

Before scoring, the pool is sorted newest-first and cut to 380 records (`WINDOW.maxItems`). The
ceiling exists because the page renders a list: unbounded, one noisy feed could push everything
else off it. Recency-first ordering means the cut removes the least useful material.

---

## 8. Classification

Classification is deterministic. There is no model in this path, and the same headline always
produces the same labels — which is what lets the page explain itself.

**Topics.** Eight fixed topics (signings, injuries, results, schedule, bike tech, teams and
business, rules and safety, culture and media), each a list of keywords. A keyword hit in the
title scores 2, a hit anywhere in the text scores 1. The top three topics are kept, in score
order. Single-word keywords match whole tokens only, so `sign` does not fire inside `design`.

**Entities.** A watchlist of 49 riders, 12 brands, 9 teams, and 8 series, each with a name and an
alias list. Aliases are compiled to word-boundary regular expressions (`PHRASE_GAP` allows
punctuation or whitespace between words), so "Jett Lawrence" matches across "Jett — Lawrence" and
not inside a longer word.

The alias rule is the part that needed judgement. A surname only becomes an alias when it is
distinctive: `Roczen`, `Tomac`, `Sexton`, `Deegan` are aliases; a bare `Cooper`, `Martin`,
`Lawrence`, or `Brown` is not, because those would let one rider inherit another's buzz. "Jett"
alone is safe; "Hunter" alone is not.

**Region.** American-series words (venues, `supercross`, `ama`, `motocross nationals`) against
world-championship words (`mxgp`, `fim`, `mxon`, and European venues). Both present is `mixed`
unless one side leads by more than 1.5×.

**The optional LLM pass** (`enrich.js`) covers the residue: short captions like "Week 1" that
carry real chatter and no keywords. It is off unless `LLM_API_KEY` (or `ZAI_API_KEY`, or
`NEWS_MODEL_API_KEY`) is set, and its contract is narrow by design:

- At most 40 unlabelled records per build, in batches of 20, `temperature: 0`, JSON object
  response, 60-second timeout, one retry on 429/5xx, Z.ai with thinking disabled.
- It may return only topic and entity **ids that already exist in `config.js`**. Everything else
  is discarded before it touches a record.
- It cannot set a date, an engagement number, a URL, a headline, or a source.
- Any failure — no key, timeout, 4xx after retry, malformed JSON, prose in the response — leaves
  the keyword labels exactly as they were.

The base URL must be HTTPS, or HTTP on loopback for local testing, so a key is never sent to a
plaintext remote host.

---

## 9. The score

One idea, in three steps: a record carries energy, energy fades with age, and the room's
temperature is the total of whatever is still warm.

### 9.1 Energy

```
energy = kind weight × engagement × 2^(−age in hours ÷ half-life in hours)
```

- `kind weight` is 1 for news and 0.9 for social — a published story counts slightly more than a
  post, without pretending social is unimportant.
- `engagement` is 1 for news. For social it is
  `1 + log10(1 + likes)/1.6 + log10(1 + replies)/3.2`, a logarithmic scale so a viral post counts
  for much more than an ignored one but cannot swallow the board.
- Recency is a half-life decay, not a step function: a record does not vanish at a boundary, it
  fades.

```
 remaining
 energy
  1.00 ┤*
       │ *
  0.50 ┤  *  ← half of it is gone
       │    *                        news   half-life 8 h, drops out at 48 h
  0.25 ┤      *                      social half-life 5 h, drops out at 72 h
       │        *   *
  0.10 ┤            *   *   *
       │                      *   *   *
  0.00 ┼──┬───┬───┬───┬───┬───┬───┬───┬──▶ age (hours)
       0  5   10  15  20  25  30  35  40
```

*Figure 4 — The decay curve. The curve is the same shape for both kinds; only the half-life differs.*

### 9.2 The meter

```
score = 100 × (1 − e^(−total energy ÷ 26))
```

An exponential saturation: the first few stories move the needle steeply, and past a certain
volume the meter flattens, because "everything is happening at once" is genuinely hard to
distinguish from "a bit more is happening". 26 is the energy at which the meter reads about 63.

| Score | Label | Reading |
| --- | --- | --- |
| 0–14 | Quiet | Almost nothing new is landing |
| 15–34 | Idling | A slow stretch of the week |
| 35–54 | Warming up | The paddock is starting to talk |
| 55–74 | Running hot | Plenty of fresh chatter across sources |
| 75–100 | Redline | Everything is talking at once |

A band label is never presented as a fact about the sport. It is the reading of a sum.

### 9.3 Momentum

```
      ├─────────── 18 h ───────────┼──── 6 h ────┤
      │        prior energy        │   recent    │
      └────────────────────────────┴─────────────┘
                                   now

 momentum = (recent + 0.5) ÷ (prior/3 + 0.5)

   ≥ 1.20  rising
   ≤ 0.85  cooling
   else    steady
```

*Figure 5 — The last six hours against the six-hour average of the eighteen before them.*

The prior is divided by 3 because it covers three times the span; the comparison is rate against
rate. The `+0.5` on both sides is additive smoothing, so a quiet prior of zero produces a defined
ratio instead of a division by zero or an infinite spike from one post. Momentum uses **raw**
energy — weight without decay — so it measures the arrival rate of chatter rather than
re-decaying the past.

Every rider, team, brand, topic, and the room itself carries its own momentum, which is why one
name can be cooling while the room gets louder.

### 9.4 Tables, buckets, and the headline

- **Buckets.** 24 one-hour buckets for the gauge, filled by publication time, so the sparkline is
  when things were *said*, not when they were fetched. Each entity also carries a 12-bucket,
  2-hour series.
- **Threads.** Records grouped by their top topic; the top five by heat, each with share of total
  energy, item count, distinct sources, its own momentum, and a top entity.
- **Entities.** Heated by summed weight, capped at 12 rows, each with mentions, distinct sources,
  momentum, and its highest-weight exemplar.
- **Region share.** Energy by region, as fractions that sum to 1.
- **Headline.** Composed from what is actually true of the snapshot, in a fixed order: top entity
  plus rising momentum; top entity plus cooling momentum; entity and topic together with flat
  momentum; entity alone; topic alone; volume and spread alone. With no eligible records it says
  so, and distinguishes "no sources answered" from "sources answered, nothing inside two days".
  Each headline carries a `headlineBasis` string, and the page prints it.

No sentence is generated by a model. The headline is a template filled from measurements.

---

## 10. When a source fails

Six statuses, and no seventh. The vocabulary is closed on purpose: a new status would need a
page that knows how to explain it.

```
        attempt
           │
   ┌───────┴────────────────────────────────────────────────┐
   │ no bridge URL configured?          → unconfigured       │
   ├────────────────────────────────────────────────────────┤
   │ answered, parsed, records kept?     → live             │
   ├────────────────────────────────────────────────────────┤
   │ answered, nothing inside the window → empty            │
   ├────────────────────────────────────────────────────────┤
   │ bytes arrived, nothing parsed?      → malformed        │
   ├────────────────────────────────────────────────────────┤
   │ request refused / threw?            → unavailable      │
   ├────────────────────────────────────────────────────────┤
   │ failed, but earlier records survive → cached           │
   └────────────────────────────────────────────────────────┘
```

*Figure 6 — A source's status is derived from what happened, never from what would look better.*

`cached` is the honest middle: this source did not answer, and the records shown under its name
come from a previous read that is still within its retention window. The tooltip says when. The
page never presents a carried record as fresh.

The distinction between `malformed` and `empty` is deliberate and visible: the first means the
parser needs attention, the second means the sport is quiet.

---

## 11. The committed local capture

Two sources answer an ordinary home connection and refuse a runner: Instagram replies to a
datacenter IP with a login shell or a 429, and Reddit throttles datacenter traffic until two of
its three subreddits come back 429. No amount of adapter work fixes an IP-based refusal.

The response is a person, once, on a machine that is allowed to read:

```
  $ npm run capture            # both networks; or capture:instagram / capture:reddit
  $ git add snapshots/ && git commit -m "…" && git push
```

`scripts/capture-local.mjs` drives the **same adapters the build uses** — same user agent, same
parsers, same post-page timestamp route — so a captured record and a live record are
indistinguishable except in where they came from.

```
   capture run                              build run
   ───────────                              ─────────
   read source on home IP                   try the live route
        │                                        │
        ├─ ok ─────▶ snapshots/*.json            ├─ ok ───────────▶ live
        │           (merged, committed)          │
        └─ fail ───▶ keep the previous entry     ├─ refused/threw ─▶ capture (if fresh) → cached
                                                 └─ no capture ────▶ unavailable / malformed
```

*Figure 7 — The live route always goes first. The capture is a floor, not a replacement.*

Rules that keep the fallback honest:

1. **The live route is tried first, always.** A working runner read beats any snapshot.
2. **A capture is trusted for 96 hours** (`INSTAGRAM_CAPTURE.maxAgeHours`,
   `REDDIT_CAPTURE.maxAgeHours`) and ignored after that. Four days covers a weekend away without
   letting the numbers describe a different week. Inside the window, the tooltip still says how
   old the local read is — "read locally 2 h ago", "3 d ago" — and the source is `cached`, not
   `live`.
3. **The record still has to be recent.** Even a fresh capture contributes nothing older than the
   social retention window (72 h), and nothing dated more than an hour in the future.
4. **A failed capture keeps its previous entry.** Only a run in which every source failed leaves
   the file untouched, and it exits non-zero so a scheduled job notices.
5. **The file is validated like any other input.** Shape, key types, and timestamps are checked;
   anything unreadable parses to null and the live routes run exactly as if no capture existed.

The capture file is therefore audit-able: it holds the URL, title, publish time, like and comment
counts, and the `capturedAt` of the read that produced it.

---

## 12. The client

```
  page load
     │
     ├─ GET data/buzz-cache.json?v=<10-minute bucket>      ← the only network request
     │
     ├─ validateCache(cache)      envelope bad → keep whatever was on screen
     │                            records bad → dropped, counted
     ├─ render gauge, headline, threads, entities, feed
     ├─ clock tick every 30 s     "since you last looked"
     └─ auto-refresh every 10 min (cache older than 2 h is marked stale)
```

*Figure 8 — The client's entire contract with the world.*

The `?v=` query is a ten-minute bucket, so browsers and the Pages CDN can cache the file hard
without anyone seeing an hour-old number. Validation on the client is the same module the build
used, which means a cache that the build would reject is rejected in the browser too — and an
invalid envelope is refused **whole**, so a broken snapshot cannot replace a good one.

`localStorage` holds exactly one key: the previous visit time, used for the "since you last
looked" line. No cookies, no analytics, no third-party scripts, no fonts.

---

## 13. What this measurement cannot say

- **It cannot tell you what matters.** Energy is volume and recency weighted by kind. A slow news
  week with one signing reads differently from a race weekend, and both readings are correct.
- **It cannot rank sources by quality.** Every configured source counts the same per record.
- **It cannot see what was not published.** Silent riders, private accounts, and unpublished
  injuries are invisible, and the page does not infer them.
- **Its social engagement numbers are only what a page displayed** at read time. A captured
  record's like count is as old as the capture.
- **Reddit contributes no audience size**, because the public feed publishes none.
- **Google News timestamps are the index's**, not always the outlet's. The publisher is shown;
  the timestamp is what arrived.
- **Day-precision records are day-precision.** They are stamped midday UTC with
  `dateBasis: "day"` and are never drawn as an exact hour.
- **The LLM pass can mislabel**, and that is why it is limited to choosing from a closed list of
  ids, cannot touch dates or numbers, and does nothing when unconfigured or failing.

---

## 14. Tests and reproducibility

`npm test` runs 64 tests on Node's built-in assertions, with no test framework and no
dependencies: text decoding and normalization, RSS and Atom parsing, malformed-versus-empty
diagnostics, the YouTube extractor against a fixture, the Instagram timeline and post-page
parsers against fixtures of both container generations, capture parsing and expiry for both
networks, classifier and alias safety (including the surnames that must *not* match), decay,
momentum, saturation, bucket accounting, cache validation, and the relay allowlist.

Everything in this paper can be reproduced without credentials:

```bash
npm test                                          # the suite
npm start                                         # static server + relay on :8080
npm run cache:local                               # build through the relay
node scripts/build-buzz-cache.js --out /tmp/c.json # build directly, no relay
npm run capture:reddit                            # write a local capture
```

The build prints every source with its status and record count, then the score, the momentum, the
headline, and the dedupe/retention counts — the same numbers this paper describes, for the hour
it ran.

---

## Appendix: where each part lives

```
.github/workflows/pages.yml   schedule, test gate, relay, build, artifact, deploy
scripts/build-buzz-cache.js   the pipeline in Figure 2
scripts/capture-local.mjs     the capture run in Figure 7
proxy/server.js               dev server + allowlisted relay
proxy/allowlist.js            every upstream the relay may reach
src/config.js                 sources, watchlist, topics, decay, thresholds
src/adapters/                 news, reddit, youtube, instagram, bridge, feed parser, http
src/adapters/local-capture.js shared capture plumbing (shape, freshness, age label)
src/engine/classify.js        topics, entities, region (§8)
src/engine/enrich.js          optional LLM labelling, closed id list (§8)
src/engine/score.js           energy, decay, momentum, tables, headline (§9)
src/engine/validate.js        the record and envelope rules (§4, §12)
src/app/                      cache loader, renderer, bootstrap, formatters
tests/run.js                  the suite (§14)
```
