#!/usr/bin/env node
/**
 * Prove a Meta app can read the handles this build tracks.
 *
 *   INSTAGRAM_TOKEN=... INSTAGRAM_BUSINESS_ID=... npm run instagram:check
 *
 * It runs the same `loadInstagramDiscovery` the hourly build runs, so a green
 * column here means the workflow will go green too. The token is never printed.
 *
 * Exit codes: 0 the credentials work and at least one handle read, 1 the calls
 * were refused (dead token, wrong id, missing permission, rate limit), 2 nothing
 * was attempted because a credential is missing.
 */
import { discoveryConfig, instagramSourceDefs, loadInstagramDiscovery } from '../src/adapters/instagram.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : null;
};

const token = flag('token') || process.env.INSTAGRAM_TOKEN;
const businessId = flag('business-id') || process.env.INSTAGRAM_BUSINESS_ID;
if (token && businessId) {
  process.env.INSTAGRAM_TOKEN = token;
  process.env.INSTAGRAM_BUSINESS_ID = businessId;
}

const config = discoveryConfig();
if (!config) {
  const missing = [token ? null : 'INSTAGRAM_TOKEN', businessId ? null : 'INSTAGRAM_BUSINESS_ID'];
  console.error(`Missing ${missing.filter(Boolean).join(' and ')}.\n`);
  console.error('Create a long-lived token at developers.facebook.com and pass both values:');
  console.error('  INSTAGRAM_TOKEN=EAAG... INSTAGRAM_BUSINESS_ID=1784140... npm run instagram:check\n');
  console.error('See the README section "A Meta app is the steady route" for how to obtain them.');
  process.exit(2);
}

const mask = (value) => `${value.slice(0, 6)}… (${value.length} chars)`;

/**
 * Graph answers a bad token, a wrong id and a missing permission all as HTTP 400
 * with an error object. Read the code rather than showing the raw message, which
 * is usually about an access token and says nothing about the actual cause.
 */
function diagnose(error) {
  const code = Number(error.code);
  const message = error.error_user_msg || error.message || 'no message';
  if (code === 190) return `The token is expired, revoked, or not a token for this app. Mint a new one. (${message})`;
  if (code === 100) return `The id is not an Instagram Business account id. Use instagram_business_account.id, not a Page id. (${message})`;
  if ([200, 10, 3].includes(code)) return `The token lacks a required permission: instagram_basic, instagram_manage_insights, pages_read_engagement. (${message})`;
  if ([4, 17, 32, 613].includes(code)) return `Graph rate limited the calls; wait a few minutes and run it again. (${message})`;
  return `${message} (code ${code}${error.error_subcode ? `/${error.error_subcode}` : ''})`;
}

/** Confirm the id belongs to an Instagram account before blaming the handles. */
async function checkIdentity() {
  const query = new URLSearchParams({
    fields: 'id,username,followers_count,media_count',
    access_token: config.token,
  });
  const response = await fetch(
    `${INSTAGRAM_DISCOVERY.host}/${INSTAGRAM_DISCOVERY.version}/${encodeURIComponent(config.businessId)}?${query}`,
  );
  const body = JSON.parse(await response.text());
  return body.error ? { error: diagnose(body.error) } : { self: body };
}

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z').replace('T', ' ').slice(0, 16);

console.log(`token ${mask(config.token)}  ig user ${config.businessId}\n`);

const identity = await checkIdentity();
if (identity.error) {
  console.error(`The id/token pair is not usable: ${identity.error}`);
  process.exit(1);
}
console.log(
  `Reading as @${identity.self.username} (${identity.self.followers_count ?? '?'} followers)\n`,
);

const now = Date.now();
const rows = [];
for (const def of instagramSourceDefs()) {
  const result = await loadInstagramDiscovery(def, { now, fetchedAt: now });
  rows.push({ def, result });
  const newest = result.records[0]?.publishedAt;
  const detail =
    result.status === 'live'
      ? `${String(result.records.length).padStart(2)} posts  newest ${iso(newest)}`
      : (result.error ?? result.note ?? '');
  const followers = result.snapshot?.followers;
  console.log(
    `  ${def.handle.padEnd(18)} ${result.status.padEnd(17)} ${
      followers == null ? '' : String(followers).padStart(9)
    }  ${detail}`,
  );
}

const live = rows.filter((row) => row.result.status === 'live');
const refused = rows.filter((row) => row.result.status === 'unavailable');
const hidden = rows.filter((row) => row.result.status === 'empty');

console.log('');
console.log(`${live.length}/${rows.length} handles read, ${hidden.length} had no posts in the window, ${refused.length} refused.`);

if (hidden.length > 0) {
  console.log('\nNo posts in the window usually means the handle is not a Business or Creator account.');
  console.log('Those handles cannot be covered by this route; a personal account cannot be read at all.');
}
if (refused.length > 0) {
  for (const row of refused) console.log(`\n${row.def.handle}: ${row.result.error}`);
  console.log('\nFix that before setting the secrets: the build would return the same refusal.');
  process.exit(1);
}
if (live.length === 0) {
  console.log('\nNothing read, so the route is not working yet.');
  process.exit(1);
}
console.log('\nGood: set INSTAGRAM_TOKEN and INSTAGRAM_BUSINESS_ID as Actions secrets and the build will use this route.');
