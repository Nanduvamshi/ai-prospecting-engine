// ============================================
// WEB SCRAPER
// Extracts content from websites/URLs
// ============================================

import * as cheerio from 'cheerio';
/**
 * Scraper tuning.
 *
 * Inlined deliberately. Upstream this was two imports from a shared AI
 * config module, and that module transitively pulled in ~1,350 lines of
 * agent/platform types that nothing here uses.
 */
export interface WebScraperConfig {
  defaultExcludeSelectors: string[];
  maxContentLength: number;
  maxKeywords: number;
  minContentLength: number;
  crawlDelayMs: number;
  defaultTimeoutMs: number;
}

export const DEFAULT_WEB_SCRAPER_CONFIG: WebScraperConfig = {
  defaultExcludeSelectors: [
    'nav', 'header', 'footer', 'aside', '.sidebar', '.navigation',
    '.menu', '.advertisement', '.ads', '.social-share', '.comments',
    '.related-posts', 'script', 'style', 'noscript', 'iframe',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  ],
  maxContentLength: 10_000,
  maxKeywords: 15,
  minContentLength: 50,
  crawlDelayMs: 500,
  defaultTimeoutMs: 10_000,
};
import { isScraperPoolConfigured, scrapeViaPool } from '@/server/discovery/scraper-pool-client';

export interface ScrapedPage {
  url: string;
  title: string;
  content: string;
  description?: string;
  keywords: string[];
  links: string[];
  metadata: {
    scrapedAt: string;
    wordCount: number;
    domain: string;
    path: string;
  };
}

export interface ScrapeOptions {
  followLinks?: boolean;
  maxDepth?: number;
  maxPages?: number;
  includeSelector?: string;
  excludeSelector?: string;
  timeout?: number;
}

// Default selectors to exclude — loaded from centralized config
const DEFAULT_EXCLUDE_SELECTORS = DEFAULT_WEB_SCRAPER_CONFIG.defaultExcludeSelectors;

// Fetch URL content.
//
// Route-of-preference: scraper pool (Track B) → direct fetch from App
// Runner's IP. The pool gives us source-IP diversity so heavy-scraping
// callers (knowledge base, company research, contact-page enrich)
// don't get rate-limited on repeat visits to the same target. Failures
// fall through transparently — no caller sees a different API.
async function fetchUrl(url: string, timeout: number = DEFAULT_WEB_SCRAPER_CONFIG.defaultTimeoutMs): Promise<string> {
  // Try pool first when configured. `kind: 'raw'` returns the untouched
  // HTML so the existing cheerio parse downstream works unchanged.
  if (isScraperPoolConfigured()) {
    const pool = await scrapeViaPool(url, { kind: 'raw', timeoutMs: timeout });
    if (pool && pool.kind === 'raw' && pool.html) {
      return pool.html;
    }
    // Pool miss / transport error — log once at warn and fall through.
    console.warn(`[web-scraper] pool miss for ${url.slice(0, 80)}, falling back to direct fetch`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProspectingBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    return await response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw error;
  }
}

// Extract text content from HTML
function extractContent(
  html: string,
  options?: ScrapeOptions
): { title: string; content: string; description?: string; links: string[] } {
  const $ = cheerio.load(html);

  // Remove excluded elements
  const excludeSelectors = options?.excludeSelector
    ? [...DEFAULT_EXCLUDE_SELECTORS, options.excludeSelector]
    : DEFAULT_EXCLUDE_SELECTORS;

  excludeSelectors.forEach(selector => {
    $(selector).remove();
  });

  // Get title
  const title = $('title').text().trim() ||
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    'Untitled';

  // Get description
  const description = $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    undefined;

  // Get main content
  let contentElement;
  if (options?.includeSelector) {
    contentElement = $(options.includeSelector);
  } else {
    // Try common content selectors
    contentElement = $('main').length ? $('main') :
      $('article').length ? $('article') :
      $('[role="main"]').length ? $('[role="main"]') :
      $('.content').length ? $('.content') :
      $('#content').length ? $('#content') :
      $('body');
  }

  // Extract text and clean it
  const content = contentElement
    .text()
    .replace(/\s+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Extract links for potential crawling
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      links.push(href);
    }
  });

  return { title, content, description, links };
}

// Extract keywords from content (configurable)
function extractKeywordsFromContent(
  content: string,
  title: string,
  scraperConfig: WebScraperConfig = DEFAULT_WEB_SCRAPER_CONFIG
): string[] {
  const text = `${title} ${content}`.toLowerCase();

  // Simple keyword extraction
  const words = text
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);

  // Count word frequency
  const wordCount: Record<string, number> = {};
  words.forEach(word => {
    wordCount[word] = (wordCount[word] || 0) + 1;
  });

  // Get top keywords by frequency
  const stopWords = new Set([
    'this', 'that', 'with', 'from', 'have', 'will', 'your', 'more',
    'about', 'they', 'been', 'would', 'there', 'their', 'what', 'when',
    'which', 'could', 'other', 'into', 'some', 'than', 'them', 'only',
  ]);

  return Object.entries(wordCount)
    .filter(([word]) => !stopWords.has(word))
    .sort((a, b) => b[1] - a[1])
    .slice(0, scraperConfig.maxKeywords)
    .map(([word]) => word);
}

// Main scrape function
export async function scrapeUrl(
  url: string,
  options?: ScrapeOptions,
  scraperConfig: WebScraperConfig = DEFAULT_WEB_SCRAPER_CONFIG
): Promise<ScrapedPage> {
  // Validate and normalize URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Fetch the page
  const html = await fetchUrl(url, options?.timeout ?? scraperConfig.defaultTimeoutMs);

  // Extract content
  const { title, content, description, links } = extractContent(html, options);

  if (content.length < scraperConfig.minContentLength) {
    throw new Error('Page has insufficient content');
  }

  // Extract keywords
  const keywords = extractKeywordsFromContent(content, title, scraperConfig);

  return {
    url,
    title,
    content,
    description,
    keywords,
    links: links.map(link => {
      try {
        return new URL(link, url).href;
      } catch {
        return link;
      }
    }).filter(link => link.startsWith('http')),
    metadata: {
      scrapedAt: new Date().toISOString(),
      wordCount: content.split(/\s+/).length,
      domain: parsedUrl.hostname,
      path: parsedUrl.pathname,
    },
  };
}

// Scrape multiple pages (basic crawler)
export async function scrapeMultipleUrls(
  startUrl: string,
  options?: ScrapeOptions,
  scraperConfig: WebScraperConfig = DEFAULT_WEB_SCRAPER_CONFIG
): Promise<ScrapedPage[]> {
  const maxPages = options?.maxPages || 5;
  const maxDepth = options?.maxDepth || 1;

  const visited = new Set<string>();
  const results: ScrapedPage[] = [];
  const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];

  // Get base domain for same-domain filtering
  const baseDomain = new URL(startUrl).hostname;

  while (queue.length > 0 && results.length < maxPages) {
    const { url, depth } = queue.shift()!;

    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const page = await scrapeUrl(url, options, scraperConfig);
      results.push(page);

      // Add links to queue if following links and not at max depth
      if (options?.followLinks && depth < maxDepth) {
        for (const link of page.links) {
          try {
            const linkUrl = new URL(link);
            // Only follow same-domain links
            if (linkUrl.hostname === baseDomain && !visited.has(link)) {
              queue.push({ url: link, depth: depth + 1 });
            }
          } catch {
            // Invalid URL, skip
          }
        }
      }
    } catch (error) {
      console.error(`Failed to scrape ${url}:`, error);
      // Continue with other URLs
    }

    // Configurable delay between requests
    await new Promise(resolve => setTimeout(resolve, scraperConfig.crawlDelayMs));
  }

  return results;
}

// Convert scraped page to knowledge item format
export function scrapedPageToKnowledgeItem(
  page: ScrapedPage,
  options?: {
    category?: string;
    modules?: string[] | null;
    priority?: number;
  },
  scraperConfig: WebScraperConfig = DEFAULT_WEB_SCRAPER_CONFIG
): {
  title: string;
  content: string;
  keywords: string[];
  category: string;
  modules: string[] | null;
  priority: number;
} {
  // Truncate content if too long (configurable)
  const maxContentLength = scraperConfig.maxContentLength;
  const content = page.content.length > maxContentLength
    ? page.content.substring(0, maxContentLength) + '...'
    : page.content;

  return {
    title: page.title,
    content: page.description
      ? `${page.description}\n\n${content}`
      : content,
    keywords: page.keywords,
    category: options?.category || 'custom',
    modules: options?.modules === undefined ? null : options.modules,
    priority: options?.priority ?? 5,
  };
}
