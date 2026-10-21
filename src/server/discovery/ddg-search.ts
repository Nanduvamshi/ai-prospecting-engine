/**
 * DuckDuckGo search — zero-cost SerpAPI replacement.
 *
 * Why: SerpAPI has a quota + billing surface we want to eliminate.
 * DDG's HTML results page (`https://html.duckduckgo.com/html/?q=…`) has
 * no API key, no quota, and renders the same organic_results subset our
 * lead-finder uses (`title`, `url`, `snippet`). We route the actual HTTP
 * fetch through the existing scraper pool so App Runner's source IP
 * isn't the one DDG rate-limits — the pool gives us IP diversity for
 * free.
 *
 * Fallback order inside this file:
 *   1. scraperPool(kind='raw') — IP-diverse fetch, Playwright if needed
 *   2. direct fetch() from App Runner — last-resort if pool is unset
 *
 * If both fail we throw `SearchProviderError`, which the classifier in
 * find-leads-runner maps to `search_unavailable` (distinct from
 * `rate_limited`, so the UI copy is honest).
 */

import * as cheerio from 'cheerio';
import { isScraperPoolConfigured, scrapeViaPool } from './scraper-pool-client';
import type { SearchResult } from './serpapi';

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class SearchProviderError extends Error {
  readonly code: 'unavailable' | 'blocked';
  constructor(code: 'unavailable' | 'blocked', message: string) {
    super(message);
    this.name = 'SearchProviderError';
    this.code = code;
  }
}

export interface DdgSearchOptions {
  /** Approximate number of results (DDG returns ~30 per page; we slice). */
  num?: number;
  /** 2-letter country bias, e.g. 'us', 'in'. */
  gl?: string;
  /** Offset into results — we page by blocks of 30. */
  start?: number;
}

/** Build the DDG HTML SERP URL. DDG uses POST-style params on /html/. */
function buildDdgUrl(query: string, opts: DdgSearchOptions): string {
  const params = new URLSearchParams({ q: query });
  if (opts.gl) params.set('kl', `${opts.gl}-en`); // DDG's region code
  if (opts.start && opts.start > 0) params.set('s', String(opts.start));
  return `${DDG_ENDPOINT}?${params.toString()}`;
}

/**
 * Parse a DDG HTML SERP into our `SearchResult[]` shape.
 *
 * DDG's /html/ page uses stable, unobfuscated class names we can rely
 * on (it's designed to work without JS). If DDG ever changes the
 * selectors we catch zero results and surface a `blocked` error so the
 * runner can fall through rather than returning a false empty set.
 */
function parseDdgHtml(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  // Each organic result is a .result block with .result__title → <a>,
  // .result__snippet, and .result__url. DDG strips outbound links
  // through `//duckduckgo.com/l/?uddg=<encoded-real-url>`; we unwrap.
  $('.result').each((_, el) => {
    const $el = $(el);
    // Skip ads ("result--ad") and sponsored blocks.
    if ($el.hasClass('result--ad') || $el.hasClass('result--more')) return;

    const titleEl = $el.find('.result__title a').first();
    const title = titleEl.text().trim();
    const rawHref = titleEl.attr('href') || '';
    const snippet = $el.find('.result__snippet').first().text().trim();
    if (!title || !rawHref) return;

    const url = unwrapDdgRedirect(rawHref);
    if (!url) return;

    results.push({ title, url, snippet });
  });

  return results;
}

/** DDG wraps outbound links in /l/?uddg=<encoded>. Strip it. */
function unwrapDdgRedirect(href: string): string | null {
  try {
    // Handle protocol-relative DDG links like //duckduckgo.com/l/?uddg=…
    const absolute = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(absolute, 'https://duckduckgo.com');
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname === '/l/') {
      const real = u.searchParams.get('uddg');
      if (real) return decodeURIComponent(real);
      return null;
    }
    // Already a direct URL — accept http/https, reject everything else.
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    return null;
  } catch {
    return null;
  }
}

async function fetchDdgDirect(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Drop-in replacement for `searchSerpApi`. Same signature, same return
 * shape — existing call sites work unchanged when serpapi.ts routes
 * through here.
 */
export async function searchDdg(
  query: string,
  options?: DdgSearchOptions,
): Promise<SearchResult[]> {
  const opts = options || {};
  const targetCount = opts.num ?? 10;
  const url = buildDdgUrl(query, opts);
  const timeoutMs = 12_000;

  let html: string | null = null;

  // Primary: route through scraper pool for IP diversity.
  if (isScraperPoolConfigured()) {
    const pooled = await scrapeViaPool(url, { kind: 'raw', timeoutMs });
    if (pooled && pooled.kind === 'raw' && pooled.html) {
      html = pooled.html;
    }
  }

  // Fallback: direct fetch from App Runner. DDG does rate-limit by IP,
  // so this is best-effort — but beats failing the whole lead search.
  if (!html) {
    html = await fetchDdgDirect(url, timeoutMs);
  }

  if (!html) {
    throw new SearchProviderError(
      'unavailable',
      'DuckDuckGo search is temporarily unavailable (pool + direct fetch both failed).',
    );
  }

  const parsed = parseDdgHtml(html);

  // Zero results on a non-empty HTML page usually means DDG served a
  // block page or changed selectors. Signal `blocked` so the caller
  // knows this wasn't a "no leads matched" — it's provider-side.
  if (parsed.length === 0 && html.length > 0) {
    const looksLikeBlock =
      /unusual traffic|anomaly|captcha|blocked/i.test(html) ||
      html.length < 500;
    if (looksLikeBlock) {
      throw new SearchProviderError(
        'blocked',
        'DuckDuckGo returned a block page (CAPTCHA or rate limit).',
      );
    }
  }

  return parsed.slice(0, targetCount);
}
