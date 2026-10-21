/**
 * SearXNG client — PR #3 primary web-search backend.
 *
 * Talks to our self-hosted SearXNG fleet (see infrastructure/lib/
 * searxng-stack.ts). SearXNG aggregates Google/Bing/DuckDuckGo/Qwant/
 * Brave in one request, returns merged organic results, and has no
 * third-party quota — any single engine being rate-limited doesn't
 * fail the search.
 *
 * Gated on SEARXNG_URL + SEARXNG_KEY env vars. When unset, `isSearxngConfigured()`
 * returns false and callers should fall through to DDG-via-pool.
 *
 * Errors are always thrown with `name = 'SearchProviderError'` so the
 * find-leads-runner classifier maps them to `search_unavailable`
 * instead of the misleading `rate_limited`.
 */

import type { SearchResult } from './serpapi';

const USER_AGENT =
  'Mozilla/5.0 (compatible; prospecting-search/1.0)';

export function isSearxngConfigured(): boolean {
  return Boolean(process.env.SEARXNG_URL && process.env.SEARXNG_KEY);
}

export interface SearxngSearchOptions {
  /** Approximate number of results to return. SearXNG doesn't respect
   *  this server-side (it aggregates whatever engines return) — we
   *  slice on the client. */
  num?: number;
  /** 2-letter country bias, e.g. 'us', 'in'. */
  gl?: string;
  /** Page number (1-based). SearXNG paginates with `&pageno=`. */
  pageno?: number;
  /** Comma-separated engine list override. Default: config-driven. */
  engines?: string;
}

interface SearxngJsonResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
}

interface SearxngJsonResponse {
  query?: string;
  results?: SearxngJsonResult[];
  unresponsive_engines?: [string, string][];
}

/** Tagged error type — matches ddg-search.ts so one classifier handles both. */
class SearchProviderError extends Error {
  readonly code: 'unavailable' | 'blocked';
  constructor(code: 'unavailable' | 'blocked', message: string) {
    super(message);
    this.name = 'SearchProviderError';
    this.code = code;
  }
}

/**
 * Execute a web search via SearXNG. Returns results in the same shape
 * as `searchDdg` / legacy `searchSerpApi` so the shim in serpapi.ts can
 * delegate without touching callers.
 */
export async function searchSearxng(
  query: string,
  options?: SearxngSearchOptions,
): Promise<SearchResult[]> {
  const baseUrl = (process.env.SEARXNG_URL || '').replace(/\/+$/, '');
  const key = process.env.SEARXNG_KEY || '';
  if (!baseUrl || !key) {
    throw new SearchProviderError('unavailable', 'SearXNG is not configured');
  }

  const num = options?.num ?? 10;
  const pageno = options?.pageno ?? 1;

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    pageno: String(pageno),
  });
  if (options?.engines) params.set('engines', options.engines);
  // SearXNG wants a BCP-47 tag like `en-AU`. This was built the other way
  // round (`au-en`), which is DuckDuckGo's `kl` region format — correct there,
  // meaningless here, so country bias has never worked on this tier.
  if (options?.gl) {
    const region = options.gl.split('-').pop() ?? options.gl;
    params.set('language', `en-${region.toUpperCase()}`);
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/search?${params.toString()}`, {
      method: 'GET',
      headers: {
        'x-searxng-key': key,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // Network-level failure (DNS, timeout, connection refused). Fleet
    // is probably down / deploying — signal unavailable so caller falls
    // through to DDG.
    throw new SearchProviderError(
      'unavailable',
      `SearXNG unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new SearchProviderError(
      'blocked',
      `SearXNG rejected request (HTTP ${response.status}) — check SEARXNG_KEY matches the ALB shim.`,
    );
  }

  if (!response.ok) {
    throw new SearchProviderError(
      'unavailable',
      `SearXNG HTTP ${response.status}`,
    );
  }

  let data: SearxngJsonResponse;
  try {
    data = (await response.json()) as SearxngJsonResponse;
  } catch (e) {
    throw new SearchProviderError(
      'unavailable',
      `SearXNG returned non-JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const raw = data.results || [];
  // Dedupe on URL (SearXNG doesn't always dedupe across engines
  // perfectly — the same page can come back from Google and Bing with
  // slightly different snippets).
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const r of raw) {
    if (!r.url || !r.title) continue;
    const key = r.url;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      title: r.title,
      url: r.url,
      snippet: r.content || '',
    });
    if (deduped.length >= num) break;
  }

  // If every engine was unresponsive, surface it as unavailable rather
  // than silently returning []. find-leads-runner will then try DDG.
  if (
    deduped.length === 0 &&
    (data.unresponsive_engines?.length ?? 0) > 0 &&
    raw.length === 0
  ) {
    const enginesFailed = data.unresponsive_engines!
      .map(([name, reason]) => `${name}:${reason}`)
      .join(', ');
    throw new SearchProviderError(
      'unavailable',
      `All SearXNG engines unresponsive: ${enginesFailed}`,
    );
  }

  return deduped;
}

export { SearchProviderError };
