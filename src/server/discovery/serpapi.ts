/**
 * Web search client for lead discovery.
 *
 * Provider order per call (first available wins):
 *   1. SerpAPI (if SERPAPI_API_KEY set) — paid but reliable, our
 *      historical primary. UAT/prod still pay for this quota.
 *   2. SearXNG (if SEARXNG_URL + SEARXNG_KEY set) — self-hosted, no
 *      quota. Becomes useful once the SearXNG ECS service is properly
 *      deployed and reachable.
 *   3. DDG via scraper pool — zero-cost fallback.
 *   4. throw SearchProviderError('unavailable') — caller maps to user
 *      message.
 *
 * The chain was briefly SearXNG → DDG only (SerpAPI removed in
 * b1228e38/2f6be3f2), but that left UAT and prod without a working
 * search backend because SearXNG infra hadn't been deployed and the
 * scraper pool wasn't configured. SerpAPI is restored here as primary
 * to keep lead-finder working while SearXNG is brought up properly.
 *
 * The export name `searchSerpApi` is kept as a legacy alias to avoid
 * churning call sites. New code should import `searchWeb` directly.
 */

import { searchDdg, SearchProviderError } from './ddg-search';
import { searchSearxng, isSearxngConfigured } from './searxng-client';

interface SerpApiOrganicResult {
  position: number;
  title: string;
  link: string;
  snippet: string;
  displayed_link?: string;
}

interface SerpApiResponse {
  search_metadata: {
    id: string;
    status: string;
    total_time_taken: number;
  };
  organic_results?: SerpApiOrganicResult[];
  error?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  displayedLink?: string;
}

export interface LeadSearchQuery {
  query: string;
  type: 'linkedin' | 'general';
}

export type SearchOptions = {
  num?: number;
  gl?: string;
  location?: string;
  start?: number;
};

/**
 * Execute a web search via the configured provider chain. Throws a
 * `SearchProviderError` (name tag) when every provider fails so the
 * find-leads-runner classifier maps it to `search_unavailable`.
 */
export async function searchWeb(
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  // Primary: SerpAPI if the key is provisioned. Reliable, paid.
  const serpApiKey = process.env.SERPAPI_API_KEY;
  if (serpApiKey) {
    try {
      return await searchSerpApiDirect(query, options, serpApiKey);
    } catch (err) {
      console.warn(
        '[searchWeb] SerpAPI failed, falling through to SearXNG/DDG:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Secondary: self-hosted SearXNG (multi-engine aggregation, no quota).
  if (isSearxngConfigured()) {
    try {
      return await searchSearxng(query, { num: options?.num, gl: options?.gl });
    } catch (err) {
      console.warn(
        '[searchWeb] SearXNG failed, falling through to DDG:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Final fallback: DuckDuckGo via scraper pool.
  try {
    return await searchDdg(query, {
      num: options?.num,
      gl: options?.gl,
      start: options?.start,
    });
  } catch (ddgErr) {
    if (ddgErr instanceof SearchProviderError) throw ddgErr;
    const e = new Error(
      ddgErr instanceof Error ? ddgErr.message : 'All search providers unavailable',
    );
    e.name = 'SearchProviderError';
    throw e;
  }
}

async function searchSerpApiDirect(
  query: string,
  options: SearchOptions | undefined,
  apiKey: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    api_key: apiKey,
    engine: 'google',
    num: String(options?.num || 10),
  });

  if (options?.gl) params.set('gl', options.gl);
  if (options?.location) params.set('location', options.location);
  if (options?.start) params.set('start', String(options.start));

  const response = await fetch(`https://serpapi.com/search?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`SerpAPI request failed (${response.status}): ${text}`);
    err.name = 'SearchProviderError';
    throw err;
  }

  const data: SerpApiResponse = await response.json();

  if (data.error) {
    const err = new Error(`SerpAPI error: ${data.error}`);
    err.name = 'SearchProviderError';
    throw err;
  }

  return (data.organic_results || []).map(r => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet || '',
    displayedLink: r.displayed_link,
  }));
}

/**
 * Legacy alias — kept so existing call sites don't churn. Prefer
 * `searchWeb` in new code.
 *
 * Callers that still import this:
 *   - src/lib/crm/find-leads-runner.ts
 *   - src/lib/search/crunchbase.ts
 *   - src/lib/search/intent-signals.ts
 *   - src/lib/search/exec-changes.ts
 *   - src/lib/search/company-enrichment.ts
 *   - src/app/api/tools/lead-finder/route.ts
 *   - src/app/api/linkedin/search/route.ts
 */
export const searchSerpApi = searchWeb;

// ---------------------------------------------------------------------------
// Query-builder helpers
//
// These are pure string-builders used by find-leads-runner and the lead-finder
// route. They were inadvertently dropped during the SearXNG/DDG refactor
// (b1228e38, 2f6be3f2), which replaced the SerpAPI HTTP client but the
// query-construction layer is orthogonal to which provider executes the
// search. Restored verbatim from b1228e38^.
// ---------------------------------------------------------------------------

/**
 * Build search queries from structured ICP filter inputs.
 * Generates LinkedIn-targeted and general company page queries.
 */
export function buildFilterQueries(filters: {
  jobTitles: string[];
  industries: string[];
  locations: string[];
}): LeadSearchQuery[] {
  const queries: LeadSearchQuery[] = [];
  const { jobTitles, industries, locations } = filters;

  const titleChunks = jobTitles.length > 0 ? jobTitles : ['decision maker'];
  const industryPart = industries.length > 0
    ? industries.map(i => `"${i}"`).join(' OR ')
    : '';
  const locationPart = locations.length > 0
    ? locations.map(l => `"${l}"`).join(' OR ')
    : '';

  // LinkedIn profile queries - combine each title with industry + location
  for (const title of titleChunks.slice(0, 3)) {
    const parts = ['site:linkedin.com/in/', `"${title}"`];
    if (industryPart) parts.push(industryPart);
    if (locationPart) parts.push(locationPart);
    queries.push({ query: parts.join(' '), type: 'linkedin' });
  }

  // General company team/about page query
  if (industries.length > 0 || locations.length > 0) {
    const generalParts = ['"team" OR "about us" OR "leadership"'];
    if (industryPart) generalParts.push(industryPart);
    if (locationPart) generalParts.push(locationPart);
    for (const title of titleChunks.slice(0, 2)) {
      generalParts.push(`"${title}"`);
    }
    queries.push({ query: generalParts.join(' '), type: 'general' });
  }

  return queries;
}

/**
 * System prompt for Claude to generate optimal search queries from a free-text user prompt.
 */
export function buildAiModeSystemPrompt(): string {
  return `You are a B2B lead generation expert. Given a user prompt describing their ideal customer profile, generate 4-6 optimized Google search queries to find relevant leads.

Return ONLY a JSON array of objects, each with:
- "query": the Google search query string
- "type": either "linkedin" (for site:linkedin.com/in/ queries) or "general" (for company pages)

Rules for query construction:
- LinkedIn queries MUST start with site:linkedin.com/in/
- Use quoted phrases for job titles and company names
- Include industry and location terms when mentioned
- General queries should target team/about/leadership pages
- Limit to 4-6 queries total for efficiency

Example output:
[
  {"query": "site:linkedin.com/in/ \\"VP of Sales\\" \\"SaaS\\" \\"United States\\"", "type": "linkedin"},
  {"query": "site:linkedin.com/in/ \\"Head of Revenue\\" \\"B2B software\\"", "type": "linkedin"},
  {"query": "\\"our team\\" OR \\"leadership\\" \\"SaaS\\" \\"sales leader\\"", "type": "general"}
]`;
}
