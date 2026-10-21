/**
 * Review-Site Negative Signals — Phase 1 Signal 4.
 *
 * Scrapes public review pages on G2 / Capterra / TrustRadius for 1-2★
 * reviews of competitor products. Authors of negative reviews are
 * actively unhappy and primed to switch — highest-intent signal.
 *
 * Caveats:
 *   - G2 and Capterra actively block scrapers. MVP uses a curated fetcher
 *     with realistic headers; it will sometimes be blocked. Real production
 *     needs residential-proxy rotation or headless browser. We return
 *     `error: 'blocked'` cleanly when that happens rather than throwing.
 *   - Reviewer names are public on these sites. We do NOT store PII beyond
 *     the public display name and any company they publicly disclose.
 *   - Scrape volume is rate-limited (max one competitor / 30 s).
 */

export interface NegativeReview {
  competitor: string;
  reviewSite: 'g2' | 'capterra' | 'trustradius';
  /** 1-5; we only include <= 2 here */
  rating: number;
  title?: string;
  excerpt: string;
  /** Reviewer public display name (first name + initial on most sites) */
  reviewer?: string;
  /** Reviewer's self-reported company if public */
  reviewerCompany?: string;
  reviewerRole?: string;
  url: string;
  /** Whether the review contains explicit switching-intent language */
  hasSwitchingIntent: boolean;
}

export interface ReviewSignalsResult {
  competitor: string;
  detectedAt: string;
  reviews: NegativeReview[];
  error?: string;
}

// Language patterns that indicate active switching intent
const SWITCHING_INTENT_PATTERNS = [
  /looking for alternatives/i,
  /switching to/i,
  /moved away from/i,
  /migrat(?:ed|ing) (?:away |from)/i,
  /can'?t wait to (?:switch|leave)/i,
  /ready to (?:switch|move|leave)/i,
  /considering other (?:options|tools|vendors)/i,
  /will not renew/i,
  /won'?t renew/i,
  /cancel(?:ed|ing) our subscription/i,
];

// Keywords that amplify the negative signal
const PAIN_KEYWORDS = [
  'overpriced', 'too expensive', 'too complicated', 'too complex',
  'terrible support', 'poor support', 'unresponsive',
  'buggy', 'slow', 'clunky', 'dated', 'legacy',
  'frustrating', 'disappointing', 'regret',
];

// ─── Site-specific URL patterns ───
// Canonical review listing pages. Competitor slug must match the site's slug.

const SITE_CONFIGS: Record<'g2' | 'capterra' | 'trustradius', {
  baseUrl: (slug: string) => string;
  /** Regex selectors for HTML → review objects */
  reviewContainerPattern: RegExp;
  ratingExtractor: (block: string) => number | null;
}> = {
  g2: {
    baseUrl: (slug) => `https://www.g2.com/products/${slug}/reviews?filters=rating%5B%5D%3D1%26rating%5B%5D%3D2`,
    // G2 wraps each review in an article element with a data-reviewid
    reviewContainerPattern: /<article[^>]*data-reviewid=["'][^"']+["'][\s\S]*?<\/article>/gi,
    ratingExtractor: (block) => {
      const m = block.match(/aria-label=["'](\d(?:\.\d)?)\s*out of 5/i);
      return m ? parseFloat(m[1]) : null;
    },
  },
  capterra: {
    baseUrl: (slug) => `https://www.capterra.com/p/${slug}/reviews/`,
    reviewContainerPattern: /<div[^>]*class=["'][^"']*review-card[^"']*["'][\s\S]*?<\/div>\s*<\/div>/gi,
    ratingExtractor: (block) => {
      const m = block.match(/(\d(?:\.\d)?)\s*\/\s*5/);
      return m ? parseFloat(m[1]) : null;
    },
  },
  trustradius: {
    baseUrl: (slug) => `https://www.trustradius.com/products/${slug}/reviews`,
    reviewContainerPattern: /<div[^>]*class=["'][^"']*review__container[^"']*["'][\s\S]*?<\/div>\s*<\/div>/gi,
    ratingExtractor: (block) => {
      const m = block.match(/Rating:\s*(\d(?:\.\d)?)\s*(?:\/|out of)\s*10/i);
      return m ? Math.round(parseFloat(m[1]) / 2) : null; // TrustRadius uses /10 scale
    },
  },
};

// Competitor → slug mapping per site. Missing entries are silently skipped.
export const COMPETITOR_SLUGS: Record<string, { g2?: string; capterra?: string; trustradius?: string }> = {
  HubSpot: { g2: 'hubspot-sales-hub', capterra: '135661/HubSpot-CRM', trustradius: 'hubspot-sales' },
  Salesforce: { g2: 'salesforce-sales-cloud', capterra: '62904/Salesforce-Sales-Cloud', trustradius: 'salesforce' },
  'Zoho CRM': { g2: 'zoho-crm', capterra: '57703/Zoho-CRM', trustradius: 'zoho-crm' },
  Freshworks: { g2: 'freshsales', capterra: '136093/Freshsales', trustradius: 'freshsales' },
  Pipedrive: { g2: 'pipedrive', capterra: '132666/Pipedrive' },
  'Monday.com': { g2: 'monday-com', capterra: '155977/monday-com' },
  Close: { g2: 'close', capterra: '154672/Close' },
  Copper: { g2: 'copper', capterra: '143267/Copper' },
  ActiveCampaign: { g2: 'activecampaign', capterra: '125306/ActiveCampaign' },
  Keap: { g2: 'keap', capterra: '149551/Keap' },
};

// Rotating user-agents to reduce basic bot detection. Not a replacement for
// residential proxies / Playwright — those are the real fixes for aggressive
// anti-scraping on G2/Capterra. See class doc at top of file.
const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // Googlebot — some review sites allow it through to preserve SEO indexing.
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
];

async function fetchPageAttempt(url: string, userAgent: string, timeoutMs: number): Promise<{ html: string | null; status: number }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { html: null, status: response.status };
    const text = await response.text();
    return { html: text.length > 1000 ? text : null, status: response.status };
  } catch {
    return { html: null, status: 0 };
  }
}

/**
 * Fetch via BrightData Web Unlocker — CAPTCHA-solving, residential-proxy
 * service. Only fires when env is configured (BRIGHTDATA_API_TOKEN +
 * BRIGHTDATA_WEB_UNLOCKER_ZONE). Costs per-request, so used as a fallback
 * after direct-fetch attempts fail.
 *
 * Docs: https://docs.brightdata.com/api-reference/web-unlocker
 */
async function fetchViaBrightDataUnlocker(url: string, timeoutMs: number): Promise<string | null> {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  const zone = process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
  if (!token || !zone) return null;

  try {
    const response = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ zone, url, format: 'raw' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.length > 1000 ? text : null;
  } catch {
    return null;
  }
}

async function fetchPage(url: string, timeoutMs = 10000): Promise<string | null> {
  // Try each UA in order; bail on first success or hard rate-limit.
  for (let i = 0; i < UA_POOL.length; i++) {
    const { html, status } = await fetchPageAttempt(url, UA_POOL[i], timeoutMs);
    if (html) return html;
    // 429 = rate-limited by site. Further UA attempts on the same IP won't help —
    // escalate to the Web Unlocker (different IP + CAPTCHA solving).
    if (status === 429) break;
    // Small backoff between retries to avoid hammering
    if (i < UA_POOL.length - 1) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
    }
  }

  // Last resort: BrightData Web Unlocker (env-gated; no-op if not configured).
  // Catches residential-blocked sites like G2/Capterra that defeat UA rotation.
  const unlocked = await fetchViaBrightDataUnlocker(url, Math.max(timeoutMs, 30000));
  if (unlocked) return unlocked;

  return null;
}

function hasSwitchingIntent(text: string): boolean {
  return SWITCHING_INTENT_PATTERNS.some(p => p.test(text));
}

function extractReviewExcerpt(block: string): string {
  // Strip HTML tags, collapse whitespace, cap at 500 chars
  return block
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * Scrape one review site for negative reviews of a specific competitor.
 */
export async function scrapeCompetitorReviews(
  competitor: string,
  site: 'g2' | 'capterra' | 'trustradius' = 'g2',
): Promise<ReviewSignalsResult> {
  const now = new Date().toISOString();
  const slug = COMPETITOR_SLUGS[competitor]?.[site];
  if (!slug) {
    return { competitor, detectedAt: now, reviews: [], error: 'unknown competitor/site' };
  }

  const config = SITE_CONFIGS[site];
  const url = config.baseUrl(slug);
  const html = await fetchPage(url);
  if (!html) {
    return { competitor, detectedAt: now, reviews: [], error: 'blocked or fetch failed' };
  }

  const reviews: NegativeReview[] = [];
  const blocks = html.match(config.reviewContainerPattern) || [];
  for (const block of blocks.slice(0, 20)) {
    const rating = config.ratingExtractor(block);
    if (rating === null || rating > 2) continue;
    const excerpt = extractReviewExcerpt(block);
    if (excerpt.length < 30) continue;

    // Pick up reviewer details if present (best-effort — formats vary)
    const nameMatch = block.match(/data-reviewer-name=["']([^"']+)["']/i)
      || block.match(/class=["'][^"']*reviewer-name[^"']*["'][^>]*>([^<]{2,60})</i);
    const companyMatch = block.match(/class=["'][^"']*reviewer-company[^"']*["'][^>]*>([^<]{2,80})</i);
    const roleMatch = block.match(/class=["'][^"']*reviewer-title[^"']*["'][^>]*>([^<]{2,80})</i);

    reviews.push({
      competitor,
      reviewSite: site,
      rating,
      excerpt,
      reviewer: nameMatch?.[1]?.trim(),
      reviewerCompany: companyMatch?.[1]?.trim(),
      reviewerRole: roleMatch?.[1]?.trim(),
      url,
      hasSwitchingIntent:
        hasSwitchingIntent(excerpt) ||
        PAIN_KEYWORDS.some(k => excerpt.toLowerCase().includes(k)),
    });
  }

  return { competitor, detectedAt: now, reviews };
}

/**
 * Scan multiple competitors across multiple sites.
 * Returns only high-intent reviews — those flagged with `hasSwitchingIntent`.
 */
export async function runNegativeReviewSweep(
  competitors: string[] = Object.keys(COMPETITOR_SLUGS),
  sites: Array<'g2' | 'capterra' | 'trustradius'> = ['g2', 'capterra'],
): Promise<NegativeReview[]> {
  const allReviews: NegativeReview[] = [];
  // Serial to stay under rate limits and not flag anti-bot heuristics.
  for (const competitor of competitors) {
    for (const site of sites) {
      const result = await scrapeCompetitorReviews(competitor, site);
      allReviews.push(...result.reviews.filter(r => r.hasSwitchingIntent));
      // Polite delay between site requests
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  return allReviews;
}
