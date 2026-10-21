import 'server-only';

import { promises as dns } from 'dns';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { enrichmentCache } from '@/server/db/schema';
import { searchWeb, type SearchResult } from './serpapi';
import { extractDomain } from './email-patterns';
import { ccTldsFor, type RegionCode } from './region';

/**
 * Find the website domain for a company name.
 *
 * The previous approach never searched: it squashed the company name to
 * `[a-z0-9-]` and tried six generic TLDs. "Sails on Lavender Bay Restaurant"
 * became `sailsonlavenderbayrestaurant.com` when the real site is
 * `sailssydney.com`, and with no `.com.au` in the list an Australian business
 * could not be found at all. A campaign of 79 Sydney venues resolved zero
 * domains, which silently disabled email discovery downstream — the pattern
 * step at find-leads-runner only runs when a domain is present.
 *
 * Searching is the fix. The hard part is that a search for a restaurant returns
 * directories and social pages *above* the venue's own site, so most of the
 * work here is deciding which result actually belongs to the company.
 *
 * The scorer weighs two independent signals, and accepts on either:
 *
 *   - the domain label looks like the company name, and
 *   - the result corroborates itself (ranks high, sits at the site root, and
 *     the page title names the company).
 *
 * Both are needed because neither is sufficient alone. `srghospitality.com.au`
 * is the right answer for "Sydney Restaurant Group" and shares no tokens with
 * it; `bestrestaurants.com.au` ranks highly for half the venues in Sydney and
 * is never the answer.
 */

// ─── Hosts that are never a company's own domain ──────────────────────

const SOCIAL_HOSTS = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'threads.net', 'reddit.com',
];

/** Site builders and booking SaaS: a subdomain there is a customer page. */
const PLATFORM_HOSTS = [
  'wixsite.com', 'squarespace.com', 'myshopify.com', 'weebly.com',
  'wordpress.com', 'blogspot.com', 'business.site', 'godaddysites.com',
  'memberjungle.com', 'opentable.com', 'resdiary.com', 'eventbrite.com',
  'linktr.ee', 'bit.ly', 'sharepoint.com', 'medium.com', 'gofundme.com',
];

const DATA_BROKERS = [
  'zoominfo.com', 'crunchbase.com', 'apollo.io', 'rocketreach.co', 'lusha.com',
  'dnb.com', 'bloomberg.com', 'pitchbook.com', 'owler.com', 'glassdoor.com',
  'indeed.com', 'yelp.com', 'tripadvisor.com', 'yellowpages.com',
  'truelocal.com.au', 'zippia.com', 'signalhire.com', 'leadiq.com',
  'wikipedia.org', 'wikidata.org',
  // Listings and review sites, which outrank the venues they list.
  'timeout.com', 'broadsheet.com.au', 'bestrestaurants.com.au', 'agfg.com.au',
  'concreteplayground.com', 'urbanspoon.com', 'dimmi.com.au', 'zomato.com',
  'doordash.com', 'ubereats.com', 'deliveroo.com', 'menulog.com.au',
  'goodfood.com.au', 'delicious.com.au', 'gourmettraveller.com.au',
];

const FREE_MAIL_HOSTS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'live.com', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'proton.me',
];

const BLOCKED_HOSTS = [
  ...SOCIAL_HOSTS, ...PLATFORM_HOSTS, ...DATA_BROKERS, ...FREE_MAIL_HOSTS,
];

/**
 * Words that mark a domain as a directory rather than a business.
 *
 * A closed-ended list, unlike a list of directory *domains* — which is
 * infinite, regional, and grows forever. `bestrestaurants.com.au` is caught by
 * `best`, without anyone having to know it exists.
 */
const GENERIC_DIRECTORY_WORDS = [
  'best', 'top', 'guide', 'guides', 'directory', 'find', 'finder', 'search',
  'list', 'lists', 'local', 'near', 'menu', 'book', 'booking', 'table',
  'review', 'reviews', 'rating', 'ratings', 'compare', 'deals', 'hub',
  'pages', 'yellow', 'portal', 'online', 'info', 'network', 'city',
];

/** Path shapes that mark a listing page rather than a company's own site. */
const DIRECTORY_PATH_SEGMENTS = new Set([
  'c', 'company', 'companies', 'organization', 'org', 'profile', 'profiles',
  'listing', 'listings', 'biz', 'place', 'places', 'chef', 'directory',
  'venue-hire', 'restaurant', 'restaurants', 'venue', 'venues',
]);

const NOISE_TOKENS = new Set([
  'the', 'and', 'by', 'at', 'of', 'on', 'in', 'for', 'a', 'an',
  'pty', 'ltd', 'limited', 'inc', 'incorporated', 'llc', 'llp', 'plc', 'gmbh',
  'corp', 'corporation', 'co', 'company', 'holdings', 'group', 'international',
  'pvt', 'private', 'bv', 'nv', 'sarl', 'ab', 'oy',
  'restaurant', 'restaurants', 'cafe', 'cafes', 'coffee', 'bar', 'bars',
  'kitchen', 'bistro', 'eatery', 'venue', 'venues', 'hotel', 'hotels', 'pub',
  'hospitality', 'catering', 'services', 'solutions', 'consulting', 'agency',
  'studio', 'clinic', 'partners', 'ventures', 'labs',
]);

const MULTI_PART_SUFFIXES = [
  'com.au', 'net.au', 'org.au', 'edu.au', 'co.uk', 'org.uk', 'me.uk',
  'co.nz', 'co.in', 'co.za', 'com.br', 'com.mx', 'com.sg', 'co.jp',
  'com.tr', 'com.ar', 'com.my', 'com.hk', 'com.ae',
];

function isBlockedHost(domain: string): boolean {
  const d = domain.toLowerCase();
  return BLOCKED_HOSTS.some((host) => d === host || d.endsWith('.' + host));
}

// ─── Pure helpers (exported for testing) ──────────────────────────────

/** The distinctive label of a domain: `sailssydney` from `sailssydney.com.au`. */
export function domainLabel(domain: string): string {
  const d = domain.toLowerCase().replace(/^www\./, '');
  const suffix = MULTI_PART_SUFFIXES.find((s) => d.endsWith('.' + s));
  const withoutSuffix = suffix
    ? d.slice(0, -(suffix.length + 1))
    : d.replace(/\.[a-z]+$/, '');
  const parts = withoutSuffix.split('.');
  return parts[parts.length - 1] ?? withoutSuffix;
}

/** Identifying words in a company name, with legal and category noise removed. */
export function distinctiveTokens(companyName: string): string[] {
  return companyName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !NOISE_TOKENS.has(t));
}

/** Grammatical filler only — kept separate so acronyms keep category nouns. */
const STOPWORDS = new Set(['the', 'and', 'of', 'on', 'at', 'in', 'for', 'by', 'a', 'an']);

/**
 * Initials of a company name: "Sydney Restaurant Group" -> "srg".
 *
 * Category words count here even though they are noise elsewhere — they are
 * part of the name people abbreviate. Recognising an acronym in a search result
 * is safe; *generating* candidate domains from one is not, because every
 * three-letter domain is already registered and the result would be a
 * confident wrong answer.
 */
export function acronymOf(companyName: string): string {
  const words = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return words.map((w) => w[0]).join('');
}

/** Share of a company's distinctive tokens that appear in a domain label. */
export function domainAffinity(companyName: string, domain: string): number {
  const tokens = distinctiveTokens(companyName);
  if (tokens.length === 0) return 0;
  const label = domainLabel(domain).replace(/[^a-z0-9]/g, '');
  if (!label) return 0;
  return tokens.filter((t) => label.includes(t)).length / tokens.length;
}

export interface Candidate {
  domain: string;
  url: string;
  rank: number;
  title?: string;
  snippet?: string;
}

/**
 * Score a search result as this company's own domain.
 *
 * A points model rather than a single ratio, because a ratio cannot express
 * the parent-group case. "Attimi by Dario Manca" shares one of three tokens
 * with `attimi.com.au` — a ratio of 0.33, below any threshold strict enough to
 * reject directories, yet obviously the right answer. Points let a strong
 * partial name match plus a root path plus a naming title add up.
 */
export function scoreCandidate(companyName: string, c: Candidate): number {
  const tokens = distinctiveTokens(companyName);
  if (tokens.length === 0) return 0;

  const label = domainLabel(c.domain).replace(/[^a-z0-9]/g, '');
  const joined = tokens.join('');
  let score = 0;

  // Signal A — does the domain label look like the name?
  if (label === joined) {
    score += 50;
  } else if (tokens.every((t) => label.includes(t))) {
    score += 45;
  } else if (label === tokens[0] && tokens[0].length >= 5) {
    score += 35;
  } else if (label.startsWith(tokens[0]) && tokens.some((t, i) => i > 0 && label.includes(t))) {
    score += 30;
  } else if (label.startsWith(tokens[0]) && tokens[0].length >= 4) {
    score += 24;
  } else if (tokens.some((t) => t.length >= 4 && label.includes(t))) {
    score += 18;
  } else {
    // No token match, but the label may carry the company's initials —
    // "Sydney Restaurant Group" trading as srghospitality.com.au. Needs three
    // letters to be worth anything; two would match far too much.
    const acronym = acronymOf(companyName);
    if (acronym.length >= 3 && label.startsWith(acronym)) score += 25;
  }

  // A domain with no link at all to the company name cannot be its site, no
  // matter how well the result corroborates itself. Skipping this check is how
  // `timeout.com` won for a Sydney restaurant: rank, a root path and a naming
  // title are exactly what a listings site has going for it, and a blocklist
  // can never name them all.
  if (score === 0) return 0;

  // Signal B — does the result corroborate itself?
  score += Math.max(0, 12 - c.rank * 2);

  let path = '';
  try {
    path = new URL(c.url.startsWith('http') ? c.url : 'https://' + c.url).pathname;
  } catch {
    path = '';
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) score += 12;
  else if (segments.length === 1) score += 6;

  const haystack = ((c.title ?? '') + ' ' + (c.snippet ?? '')).toLowerCase();
  const normalizedName = companyName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalizedName && haystack.includes(normalizedName)) score += 12;

  if (segments.some((s) => tokens.includes(s.toLowerCase()))) score += 15;

  // Penalties — a directory can score well on rank and title alone.
  const namesCompany = tokens.some((t) => label.includes(t));
  if (!namesCompany && GENERIC_DIRECTORY_WORDS.some((w) => label.includes(w))) {
    score -= 40;
  }
  if (segments.length > 0 && DIRECTORY_PATH_SEGMENTS.has(segments[0].toLowerCase())) {
    score -= 25;
  }

  return score;
}

/** Accept outright. */
const HIGH_SCORE = 55;
/** Accept, but the domain is a guess worth flagging. */
const MEDIUM_SCORE = 35;

// ─── Cache ────────────────────────────────────────────────────────────

const CACHE_VERSION = 'v1';
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Misses expire sooner: a business with no findable site today may have one
// next month, and a null costs a full search to rediscover.
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Survives only for the run, in front of the database. */
const runCache = new Map<string, string | null>();

function slugify(companyName: string): string {
  return companyName.toLowerCase().replace(/\s+/g, ' ').trim();
}

function cacheKey(companyName: string, region?: RegionCode | null): string {
  return 'CACHE#DOMAIN#' + CACHE_VERSION + '#' + (region ?? 'xx') + '#' + slugify(companyName);
}

async function readCache(keys: string[]): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  if (keys.length === 0) return found;
  try {
    const rows = await db
      .select()
      .from(enrichmentCache)
      .where(keys.length === 1 ? eq(enrichmentCache.cacheKey, keys[0]) : inArray(enrichmentCache.cacheKey, keys));
    for (const row of rows) {
      if (row.expiresAt.getTime() < Date.now()) continue;
      found.set(row.cacheKey, (row.payload as { domain: string | null }).domain ?? null);
    }
  } catch {
    // A cache read failing just means a cache miss.
  }
  return found;
}

async function writeCache(key: string, domain: string | null): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + (domain ? HIT_TTL_MS : MISS_TTL_MS));
    const payload = { domain };
    await db
      .insert(enrichmentCache)
      .values({ cacheKey: key, payload, expiresAt })
      .onConflictDoUpdate({ target: enrichmentCache.cacheKey, set: { payload, expiresAt } });
  } catch {
    // Never fail a resolution because caching it failed.
  }
}

// ─── Liveness ─────────────────────────────────────────────────────────

/**
 * Does this domain accept mail?
 *
 * An MX lookup rather than an HTTP request: it is one UDP round-trip, cannot be
 * blocked by a bot filter, is unambiguous about parked pages, and is exactly
 * the precondition the email-pattern step needs anyway. The previous HEAD-only
 * check read a WAF-fronted site returning 403 as dead, which is part of why so
 * little resolved.
 */
export async function hasMailExchanger(domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveMx(domain);
    return records.length > 0;
  } catch {
    return false;
  }
}

// ─── Resolution ───────────────────────────────────────────────────────

export interface ResolveDomainInput {
  company: string;
  /** Free-text location, used to bias the search toward the right country. */
  location?: string | null;
  region?: RegionCode | null;
  /** A site already known for this lead — short-circuits everything. */
  website?: string | null;
}

export interface SearchBudget {
  remaining: number;
  spent: number;
  take(): boolean;
}

export function createSearchBudget(max: number): SearchBudget {
  return {
    remaining: max,
    spent: 0,
    take() {
      if (this.remaining <= 0) return false;
      this.remaining -= 1;
      this.spent += 1;
      return true;
    },
  };
}

export async function resolveCompanyDomain(
  input: ResolveDomainInput,
  budget?: SearchBudget,
): Promise<string | null> {
  const { company } = input;
  if (!company || company.trim().length < 2) return null;
  if (company.toLowerCase() === 'unknown' || /^\d+$/.test(company.trim())) return null;

  // Free: a site we already have beats anything we could look up.
  if (input.website) {
    const known = extractDomain(input.website);
    if (known && !isBlockedHost(known)) return known;
  }

  const key = cacheKey(company, input.region);
  if (runCache.has(key)) return runCache.get(key)!;

  const cached = await readCache([key]);
  if (cached.has(key)) {
    const hit = cached.get(key)!;
    runCache.set(key, hit);
    return hit;
  }

  let resolved: string | null = null;
  if (!budget || budget.take()) {
    resolved = await searchForDomain(company, input);
  }
  if (!resolved) {
    resolved = await guessDomain(company, input.region);
  }

  runCache.set(key, resolved);
  await writeCache(key, resolved);
  return resolved;
}

/**
 * Resolve a batch, one lookup per distinct company.
 *
 * The runner resolves inside its per-lead enrichment loop, so five people at
 * one restaurant previously meant five identical searches — and with the leads
 * processed in concurrent batches, an in-process cache could not catch them.
 * Deduping up front is what keeps a 60-lead Deep run affordable.
 */
export async function resolveCompanyDomains(
  inputs: ResolveDomainInput[],
  opts: { budget?: SearchBudget; concurrency?: number } = {},
): Promise<Map<string, string | null>> {
  const byCompany = new Map<string, ResolveDomainInput>();
  for (const input of inputs) {
    const slug = slugify(input.company || '');
    if (!slug) continue;
    // Prefer the variant that already carries a website — it resolves for free.
    const existing = byCompany.get(slug);
    if (!existing || (!existing.website && input.website)) byCompany.set(slug, input);
  }

  const results = new Map<string, string | null>();
  const entries = Array.from(byCompany.entries());
  const concurrency = opts.concurrency ?? 4;

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async ([slug, input]) => {
        try {
          results.set(slug, await resolveCompanyDomain(input, opts.budget));
        } catch {
          results.set(slug, null);
        }
      }),
    );
  }
  return results;
}

/** Look up a company in a map returned by `resolveCompanyDomains`. */
export function domainFor(map: Map<string, string | null>, company?: string): string | null {
  if (!company) return null;
  return map.get(slugify(company)) ?? null;
}

async function searchForDomain(
  company: string,
  input: ResolveDomainInput,
): Promise<string | null> {
  // The city goes in the query text rather than into `gl`: searchWeb drops its
  // `location` option for the SearXNG and DDG tiers, so a query-string token is
  // the only hint that behaves the same across all three providers.
  const city = (input.location ?? '').split(',')[0]?.trim() ?? '';
  const query = '"' + company + '" official website' + (city ? ' ' + city : '');

  let results: SearchResult[];
  try {
    results = await searchWeb(query, {
      num: 10,
      gl: input.region ? input.region.toLowerCase() : undefined,
    });
  } catch {
    // Every search tier failed. Never rethrow — the runner's classifier maps a
    // SearchProviderError to a fatal job failure, and a domain lookup falling
    // over must not kill an otherwise good run.
    return null;
  }

  const scored: Array<{ domain: string; score: number }> = [];
  const seen = new Set<string>();

  results.forEach((result, rank) => {
    const domain = extractDomain(result.url);
    if (!domain || seen.has(domain) || isBlockedHost(domain)) return;
    seen.add(domain);
    scored.push({
      domain,
      score: scoreCandidate(company, {
        domain,
        url: result.url,
        rank,
        title: result.title,
        snippet: result.snippet,
      }),
    });
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < MEDIUM_SCORE) return null;

  // A high-scoring search result is not re-validated over HTTP: the search
  // engine already proved the page exists, and one flaky request should not
  // discard a correct answer. Medium scores get an MX check as corroboration.
  if (best.score >= HIGH_SCORE) return best.domain;
  return (await hasMailExchanger(best.domain)) ? best.domain : null;
}

/**
 * Construct candidates from the company name.
 *
 * The fallback for when search is unavailable or returns nothing usable. It
 * builds from distinctive tokens rather than the whole squashed name, tries
 * the region's ccTLDs first, and validates with MX rather than an
 * HTTP HEAD. Acronyms are deliberately not attempted — every three-letter
 * domain is registered, and the result would be a confident wrong answer.
 */
async function guessDomain(
  company: string,
  region?: RegionCode | null,
): Promise<string | null> {
  const tokens = distinctiveTokens(company);
  if (tokens.length === 0) return null;

  const bases = Array.from(
    new Set(
      [tokens.join(''), tokens[0], tokens.slice(0, 2).join('')].filter((b) => b.length >= 4),
    ),
  );
  const tlds = ['com', ...ccTldsFor(region), 'co', 'io', 'net', 'org'];

  const candidates: string[] = [];
  for (const base of bases) {
    for (const tld of tlds) candidates.push(base + '.' + tld);
  }

  // MX lookups are free and fast, so the whole ladder can run at once.
  const settled = await Promise.allSettled(
    candidates.slice(0, 24).map(async (d) => ((await hasMailExchanger(d)) ? d : null)),
  );
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) return r.value;
  }
  return null;
}

/** Clears the per-run memo. Call between pipeline runs and in tests. */
export function resetDomainRunCache(): void {
  runCache.clear();
}
