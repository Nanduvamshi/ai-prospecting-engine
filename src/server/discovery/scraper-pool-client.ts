/**
 * Scraper Pool client — Track B scaffold.
 *
 * POSTs a scrape request to the ALB fronting the fleet, returns the
 * extractor output. Gated on `SCRAPER_POOL_URL` + `SCRAPER_POOL_KEY`;
 * when unset, callers should fall through to BrightData.
 *
 * Extractor `kind` drives which site-specific parser runs on the node:
 *   'contact-page' — company /contact or /about pages
 *   'generic'      — raw HTML text + email regex (fallback)
 *
 * Add new kinds by updating infrastructure/scraper-service/extractors.js
 * alongside this file; protocol stays the same.
 */

export function isScraperPoolConfigured(): boolean {
  return Boolean(process.env.SCRAPER_POOL_URL && process.env.SCRAPER_POOL_KEY);
}

// ─── Observability counters ─────────────────────────────────────────
//
// Same shape as email-verifier tier stats (in-memory, per-instance,
// reset on App Runner redeploy). Surfaced via
// /api/admin/scraper-pool/status for the Ops dashboard so admins can
// see whether Track B is actually serving traffic vs silently falling
// through to direct fetch.

type ScrapeOutcome = 'pool' | 'fallback' | 'pool-not-configured' | 'error';

interface ScraperCounter {
  attempts: number;
  byKind: Record<string, number>;
  byOutcome: Record<ScrapeOutcome, number>;
  byRenderMode: Record<'fetch' | 'playwright' | 'unknown', number>;
  totalPoolMs: number;
  poolCallsTimed: number;
}

function newScraperCounter(): ScraperCounter {
  return {
    attempts: 0,
    byKind: {},
    byOutcome: { pool: 0, fallback: 0, 'pool-not-configured': 0, error: 0 },
    byRenderMode: { fetch: 0, playwright: 0, unknown: 0 },
    totalPoolMs: 0,
    poolCallsTimed: 0,
  };
}

let scraperStats: ScraperCounter = newScraperCounter();

export function recordScrapeAttempt(kind: string): void {
  scraperStats.attempts += 1;
  scraperStats.byKind[kind] = (scraperStats.byKind[kind] || 0) + 1;
}

export function recordPoolHit(
  _kind: string,
  renderMode: 'fetch' | 'playwright' | undefined,
  durationMs?: number,
): void {
  scraperStats.byOutcome.pool += 1;
  const mode = renderMode === 'playwright' ? 'playwright' : renderMode === 'fetch' ? 'fetch' : 'unknown';
  scraperStats.byRenderMode[mode] += 1;
  if (typeof durationMs === 'number' && durationMs > 0) {
    scraperStats.totalPoolMs += durationMs;
    scraperStats.poolCallsTimed += 1;
  }
}

export function recordScrapeFallback(reason: ScrapeOutcome = 'fallback'): void {
  scraperStats.byOutcome[reason] += 1;
}

export function getScraperPoolStats() {
  const s = scraperStats;
  const avgPoolMs = s.poolCallsTimed > 0 ? Math.round(s.totalPoolMs / s.poolCallsTimed) : 0;
  const poolHitRate = s.attempts > 0 ? s.byOutcome.pool / s.attempts : 0;
  return {
    attempts: s.attempts,
    byKind: { ...s.byKind },
    byOutcome: { ...s.byOutcome },
    byRenderMode: { ...s.byRenderMode },
    avgPoolMs,
    poolHitRate: Number(poolHitRate.toFixed(3)),
  };
}

export function resetScraperPoolStats(): void {
  scraperStats = newScraperCounter();
}

export interface ContactPageResult {
  kind: 'contact-page';
  url: string;
  emails: string[];
  personalEmails: string[];
  phones: string[];
  nodeId?: string;
  durationMs?: number;
  renderMode?: 'fetch' | 'playwright';
}

export interface GenericScrapeResult {
  kind: 'generic';
  url: string;
  textLength: number;
  textExcerpt: string;
  emails: string[];
  nodeId?: string;
  durationMs?: number;
  renderMode?: 'fetch' | 'playwright';
}

export interface RawScrapeResult {
  kind: 'raw';
  url: string;
  html: string;
  text: string;
  nodeId?: string;
  durationMs?: number;
  renderMode?: 'fetch' | 'playwright';
}

export type ScrapeResult = ContactPageResult | GenericScrapeResult | RawScrapeResult;

/**
 * Scrape "kind" — which server-side handler to use.
 *   'contact-page' / 'generic' → plain fetch (Tier 1, cheap)
 *   'raw'                      → plain fetch, returns raw HTML + stripped
 *                                 text so the caller can run its own
 *                                 extraction. Used when the server-side
 *                                 extractor would lose signal the caller
 *                                 needs (JSON-LD, tel: hrefs, etc.)
 *   'dynamic'                  → Playwright render (Tier 2, for SPAs /
 *                                 anti-bot sites — returns generic shape)
 */
export type ScrapeKind = 'contact-page' | 'generic' | 'raw' | 'dynamic';

export interface ScrapeOptions {
  kind?: ScrapeKind;
  timeoutMs?: number;
  /** Only used when kind === 'dynamic' — CSS selector to await before extracting */
  waitFor?: string;
  /** Skip images/fonts/media when rendering (default true) */
  blockAssets?: boolean;
}

/**
 * Scrape + fall through to direct fetch from App Runner's IP when the
 * pool isn't configured or errors. Returns uniform shape regardless of
 * which path served the request — callers don't need to branch.
 *
 * Use this for any public-page scraping that benefits from source-IP
 * diversity (company contact pages, press pages, public directory
 * pages). Skip it for auth-gated or highly dynamic sites — those still
 * belong on BrightData until Track B Tier 2 (Playwright) lands.
 */
export async function scrapeUrlSmart(
  url: string,
  opts: ScrapeOptions = {},
): Promise<ScrapeResult | null> {
  // Prefer the pool when available — diverse source IPs avoid App
  // Runner's IP hitting the same destination repeatedly, and the pool
  // is the only way to get Playwright-rendered pages. scrapeViaPool
  // records its own attempt/hit/fallback counters so callers (this
  // function, brightdata.ts, web-scraper.ts) don't need to.
  if (isScraperPoolConfigured()) {
    const result = await scrapeViaPool(url, opts);
    if (result) return result;
  }
  // Fallback: direct fetch from App Runner. Does NOT support `dynamic`
  // kind (no browser available outside the pool) — return null so the
  // caller can surface an actionable error rather than degrading
  // silently to an empty fetch.
  if (opts.kind === 'dynamic') return null;
  const timeoutMs = opts.timeoutMs || 12_000;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; prospecting-scraper/1.0)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    return extractFallback(html, url, opts.kind === 'contact-page' ? 'contact-page' : 'generic');
  } catch {
    return null;
  }
}

function extractFallback(html: string, url: string, kind: 'contact-page' | 'generic'): ScrapeResult {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const emailRe = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;
  const emails = Array.from(new Set((stripped.match(emailRe) || []).map((e) => e.toLowerCase())));
  if (kind === 'contact-page') {
    const phoneRe = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;
    const phones = Array.from(new Set(stripped.match(phoneRe) || []));
    const GENERIC = new Set(['info', 'hello', 'contact', 'support', 'hi', 'help', 'admin', 'sales', 'team', 'office', 'jobs', 'careers', 'press', 'media', 'privacy', 'legal', 'abuse', 'noreply', 'no-reply', 'donotreply']);
    const personalEmails = emails.filter((e) => !GENERIC.has(e.split('@')[0]));
    return { kind: 'contact-page', url, emails, personalEmails, phones };
  }
  return { kind: 'generic', url, textLength: stripped.length, textExcerpt: stripped.slice(0, 5000), emails };
}

export async function scrapeViaPool(
  url: string,
  opts: ScrapeOptions = {},
): Promise<ScrapeResult | null> {
  const kind = opts.kind || 'generic';
  // Every call to scrapeViaPool is a scrape attempt. Counters are
  // consolidated here so callers in brightdata.ts / web-scraper.ts /
  // scrapeUrlSmart don't each have to record their own. The Ops tab
  // reads from getScraperPoolStats().
  recordScrapeAttempt(kind);

  const baseUrl = (process.env.SCRAPER_POOL_URL || '').replace(/\/+$/, '');
  const key = process.env.SCRAPER_POOL_KEY || '';
  if (!baseUrl || !key) {
    recordScrapeFallback('pool-not-configured');
    return null;
  }

  const isDynamic = kind === 'dynamic';
  // Dynamic requests get a longer budget — Chromium render takes time.
  const timeoutMs = opts.timeoutMs || (isDynamic ? 20_000 : 12_000);

  try {
    const res = await fetch(`${baseUrl}/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-scraper-key': key,
      },
      body: JSON.stringify({
        url,
        kind,
        timeoutMs,
        waitFor: opts.waitFor,
        blockAssets: opts.blockAssets,
      }),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });
    if (!res.ok) {
      recordScrapeFallback('error');
      return null;
    }
    const result = (await res.json()) as ScrapeResult;
    recordPoolHit(kind, result.renderMode, result.durationMs);
    return result;
  } catch {
    recordScrapeFallback('error');
    return null;
  }
}
