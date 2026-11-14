# Can the build read article bodies?

A survey run on **2026-11-14** against `data/live-cache.json` (47 records, 2026-11-13) and the
seven direct feeds in `src/config.js`, using `npm run survey:articles`.

The question: if a future build wanted to send article bodies to a model rather than titles, which
outlets would actually serve a body to the build? A body was counted **readable** when the page
returned HTML, contained at least 120 words in `<p>` elements across at least two paragraphs, and
showed no paywall or consent wall. The count is rough — it measures paragraph text, not article
quality.

## What the index returns

Ten Google News records, one per publisher, were fetched with the build's user agent and
redirects followed.

| Result | Count |
| --- | --- |
| Landed on a Google page (`news.google.com`), never the outlet | 10 |
| Reached the outlet | 0 |
| Readable article text | 0 |

The `/rss/articles/…` link is a JavaScript shell. The HTML contains no outlet URL, no
meta-refresh, and no `data-n-au`; the target is fetched by script. The page does carry an
`AU_yqL…` article id, but a direct call to Google's `batchexecute` resolver without a signature
was refused (`wrb.fr` with error code `3`). Resolving index links therefore needs a signed,
reverse-engineered endpoint and a browser-like session — not something this build should depend
on. **Body reading through the index is not viable.**

This also means the digest's titles-only design is not a limitation imposed for tidiness: for the
roughly two-thirds of records that come through Google News, the title is all a simple fetch can
see.

## What the direct feeds serve

Fourteen articles, the first two from each configured feed, fetched directly.

| Outlet | Tested | Readable | Median words | Notes |
| --- | --- | --- | --- | --- |
| Vurbmoto | 2 | 2 | 881 | Full reports |
| MXGP | 2 | 2 | 450 | Full reports |
| MX Vice | 2 | 2 | 211 | Short but complete |
| Supercross Live | 2 | 1 | 612 | One item was a 49-word video page |
| SuperMotocross | 2 | 1 | 613 | Same pattern |
| PulpMX | 2 | 1 | 191 | One item was a 64-word show page |
| MotoOnline | 2 | 0 | 59 | Both items were thin shells (video/JS) |

Overall: **10 of 14** direct-feed articles carried readable paragraph text, and six of the seven
outlets served at least one. The four failures are page types, not refusals: video pages and
JavaScript-rendered shells with no body in the served HTML.

## Verdict

- **Titles-only digest: keep it.** It is the only route that covers every record, and it avoids
  the index problem entirely.
- **Body reading is viable only for direct-feed records**, and even there the build would need to
  skip video/show pages rather than treat every item as an article. That is 7 of 30 sources, so a
  body-reading pass would be a partial view presented as a whole one.
- If body reading is ever added, it should be opt-in per outlet (Vurbmoto, MXGP, MX Vice,
  Supercross Live, SuperMotocross, PulpMX), with a minimum body length and the same citation and
  labelling rules as the digest. It should not be attempted through Google News.

## Method and limits

- One request per URL, build user agent (`MotoBuzz/1.0 … cache builder`), 20-second timeout,
  1.5 MB cap, no retries, 700 ms between requests.
- No JavaScript execution, no cookies, no paywall circumvention. A page that needs script to
  render its body reads as thin.
- "Readable" is a content-length heuristic, not an editorial judgement. A short race report can be
  complete; a long page can be an index.
- Single run, single day. Outlets change templates, and a different sample could move the counts by
  an article or two.
- Re-run with `npm run survey:articles -- data/<cache>.json --max 30 --per-publisher 3`.
