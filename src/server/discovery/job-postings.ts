/**
 * Job Posting Scraping — Phase 1 Signal 2.
 *
 * Scrapes a company's public careers page for open roles. Classifies roles
 * against an ICP keyword list — "hiring a CRM Manager" = strong buying signal
 * for the product (customer explicitly builds the function it enables).
 *
 * Sources tried, in order:
 *   1. Common careers paths on the company's own domain
 *      (/careers, /jobs, /work-with-us, etc.)
 *   2. Indeed public RSS (no scraping) — not implemented in MVP, stubbed
 *
 * No external paid API. No secrets.
 */

export interface JobPosting {
  title: string;
  /** The page URL where the posting was found */
  sourceUrl: string;
  /** First ICP tag that matched the title — empty if no match */
  icpMatch?: string;
  /** Raw snippet of surrounding text for context (first 200 chars) */
  snippet?: string;
}

export interface JobPostingsResult {
  domain: string;
  detectedAt: string;
  postings: JobPosting[];
  /** Subset of postings that matched the ICP keyword list */
  icpMatches: JobPosting[];
  error?: string;
}

// ICP role keywords — roles whose existence signals the company is building
// the function the product powers (revenue ops, sales ops, success ops, AI ops).
// Ordered so the *more specific* match wins in `findIcpMatch`.
const ICP_KEYWORDS: Array<{ tag: string; patterns: RegExp[] }> = [
  { tag: 'RevOps', patterns: [/revenue[\s-]?operations/i, /\brevops\b/i] },
  { tag: 'Sales Ops', patterns: [/sales[\s-]?operations/i, /\bsalesops\b/i] },
  { tag: 'CRM Manager', patterns: [/crm[\s-]?(manager|lead|admin)/i, /crm[\s-]?administrator/i] },
  { tag: 'Growth', patterns: [/growth[\s-]?(manager|lead|marketer|hacker)/i, /head of growth/i] },
  { tag: 'Customer Success', patterns: [/customer[\s-]?success/i, /\bcsm\b/i, /client[\s-]?success/i] },
  { tag: 'Support Lead', patterns: [/support[\s-]?(lead|manager)/i, /head of support/i] },
  { tag: 'Marketing Ops', patterns: [/marketing[\s-]?operations/i, /\bmarketops\b/i] },
  { tag: 'AI/Automation', patterns: [/ai[\s-]?operations/i, /automation[\s-]?(engineer|manager)/i, /ml[\s-]?ops/i] },
  { tag: 'BDR/SDR', patterns: [/\bbdr\b/i, /\bsdr\b/i, /business[\s-]?development[\s-]?rep/i, /sales[\s-]?development[\s-]?rep/i] },
  { tag: 'Account Executive', patterns: [/account[\s-]?executive/i, /\bae\b(?!\w)/i] },
  { tag: 'Account Manager', patterns: [/account[\s-]?manager/i] },
];

const CAREERS_PATHS = [
  '/careers', '/jobs', '/work-with-us', '/join-us', '/hiring',
  '/company/careers', '/about/careers', '/careers/open-positions',
  '/team/careers', '/about/jobs', '/careers/jobs',
];

function findIcpMatch(title: string): string | undefined {
  for (const { tag, patterns } of ICP_KEYWORDS) {
    for (const p of patterns) {
      if (p.test(title)) return tag;
    }
  }
  return undefined;
}

async function fetchPage(url: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; prospecting-job-scanner/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.length > 500 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Extract job titles from careers-page HTML.
 *
 * Heuristic-based — looks at:
 *  - <a> tag text if the href matches /job[s]?/ or /careers/
 *  - <h1>/<h2>/<h3> text
 *  - elements with common ATS class names (greenhouse, lever, workable)
 *
 * Returns deduplicated titles (max 50).
 */
function extractJobTitles(html: string, sourceUrl: string): JobPosting[] {
  const seen = new Set<string>();
  const postings: JobPosting[] = [];

  const push = (rawTitle: string) => {
    const cleaned = rawTitle
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length < 4 || cleaned.length > 120) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    postings.push({
      title: cleaned,
      sourceUrl,
      icpMatch: findIcpMatch(cleaned),
    });
  };

  // Job-link anchors — most common pattern on careers pages
  const anchorRe = /<a[^>]*href=["'][^"']*(?:\/job[s]?\/|\/careers?\/|\/positions?\/|greenhouse\.io\/[^\/"']+\/jobs|boards\.greenhouse\.io|lever\.co|workable\.com\/j\/|ashbyhq\.com\/[^\/"']+\/[^"']+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null && postings.length < 50) push(m[1]);

  // ATS class patterns (greenhouse, lever, workable)
  const atsClassRe = /<(?:div|span|h[1-4])[^>]*class=["'][^"']*(?:posting-title|job-title|opening-title|position-title|greenhouse-job|lever-job)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|h[1-4])>/gi;
  while ((m = atsClassRe.exec(html)) !== null && postings.length < 50) push(m[1]);

  // Fallback: plausibly-job headings near the word "apply"
  if (postings.length < 3) {
    const headingRe = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
    while ((m = headingRe.exec(html)) !== null && postings.length < 50) {
      const text = m[1].replace(/<[^>]+>/g, '').trim();
      if (text.length < 6 || text.length > 120) continue;
      // Heuristic: job titles usually contain a job-ish noun
      if (/engineer|manager|designer|analyst|lead|director|officer|specialist|representative|executive|coordinator|developer|architect|consultant|associate|intern|head of|vp of|chief/i.test(text)) {
        push(text);
      }
    }
  }

  return postings;
}

/**
 * Scrape a company's public careers page for open roles.
 * Tries common careers-page paths and aggregates unique job titles.
 */
export async function scrapeJobPostings(domain: string, timeoutMs = 8000): Promise<JobPostingsResult> {
  const now = new Date().toISOString();
  if (!domain) {
    return { domain, detectedAt: now, postings: [], icpMatches: [], error: 'no domain' };
  }

  let baseUrl = domain.trim();
  if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;
  baseUrl = baseUrl.replace(/\/+$/, '');

  const urlsToTry = CAREERS_PATHS.map(p => `${baseUrl}${p}`);

  const allPostings: JobPosting[] = [];
  const seen = new Set<string>();

  for (const url of urlsToTry) {
    if (allPostings.length >= 40) break;
    const html = await fetchPage(url, timeoutMs);
    if (!html) continue;
    const postings = extractJobTitles(html, url);
    for (const p of postings) {
      const key = p.title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        allPostings.push(p);
      }
    }
  }

  return {
    domain,
    detectedAt: now,
    postings: allPostings,
    icpMatches: allPostings.filter(p => p.icpMatch),
  };
}

/**
 * Quick yes/no: is this company hiring ICP-relevant roles?
 */
export async function isHiringIcpRoles(domain: string): Promise<boolean> {
  const result = await scrapeJobPostings(domain);
  return result.icpMatches.length > 0;
}
