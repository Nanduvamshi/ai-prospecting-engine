/**
 * Company Enrichment — Fetches company profile data via SerpAPI + Claude.
 * Caches results in Postgres with a 1-week TTL to avoid redundant lookups.
 */

import { searchSerpApi } from './serpapi';
import { scrapeUrl } from '@/server/ai/web-scraper';
import { getProviderRouter } from '../ai/providers';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { enrichmentCache } from '@/server/db/schema';
import type { CompanyEnrichment } from '@/types/lead-enrichment';

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 1 week

/**
 * Build a stable cache key for a company.
 * Uses domain if available, falls back to normalized company name.
 */
function buildCacheKey(companyName: string, domain?: string): string {
  const key = domain
    ? domain.toLowerCase().replace(/^www\./, '')
    : companyName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  return `CACHE#COMPANY#${key}`;
}

/**
 * Read the company enrichment cache.
 *
 * Note on the shape change: in DynamoDB every cached company shared the
 * literal partition key 'ENRICHMENT_CACHE', which meant every read and write
 * for every tenant funnelled through one partition — a textbook hot key, and
 * a hard throughput ceiling. Here the cache key is the primary key, so the
 * load spreads naturally.
 */
async function getCachedEnrichment(cacheKey: string): Promise<CompanyEnrichment | null> {
  try {
    const rows = await db
      .select()
      .from(enrichmentCache)
      .where(eq(enrichmentCache.cacheKey, cacheKey))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    // Expired but not yet reaped counts as a miss.
    if (row.expiresAt.getTime() < Date.now()) return null;

    return row.payload as unknown as CompanyEnrichment;
  } catch {
    return null;
  }
}

/** Write to the company enrichment cache. Non-fatal on failure. */
async function setCachedEnrichment(cacheKey: string, data: CompanyEnrichment): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + CACHE_TTL_SECONDS * 1000);
    await db
      .insert(enrichmentCache)
      .values({
        cacheKey,
        payload: data as unknown as Record<string, unknown>,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: enrichmentCache.cacheKey,
        set: { payload: data as unknown as Record<string, unknown>, expiresAt },
      });
  } catch (err) {
    console.error('[CompanyEnrichment] Cache write failed (non-fatal):', err);
  }
}

/**
 * Enrich a company with profile data: size, industry, revenue, funding, tech stack, etc.
 * Uses SerpAPI to find company info + Claude to extract structured data.
 * Results are cached in Postgres for 1 week.
 */
export async function enrichCompany(
  companyName: string,
  domain?: string,
): Promise<CompanyEnrichment> {
  if (!companyName) return {};

  // Check cache first
  const cacheKey = buildCacheKey(companyName, domain);
  const cached = await getCachedEnrichment(cacheKey);
  if (cached) return cached;

  // 7-query parallel research approach (inspired by BW_Prospecting_hub)
  const queries = [
    // 1. Company overview
    { label: 'overview', query: `"${companyName}" company about headquarters employees industry` },
    // 2. Financial / funding data
    { label: 'financials', query: `"${companyName}" funding valuation revenue employees size` },
    // 3. Contact information
    { label: 'contact', query: `"${companyName}" contact email phone customer support` },
    // 4. Recent news
    { label: 'news', query: `"${companyName}" company news 2024 2025` },
    // 5. Crunchbase profile
    { label: 'crunchbase', query: `site:crunchbase.com "${companyName}"` },
    // 6. LinkedIn company page
    { label: 'linkedin', query: `site:linkedin.com/company/ "${companyName}"` },
    // 7. Site-specific deep dive (if domain available)
    ...(domain ? [{ label: 'site', query: `site:${domain} about OR contact OR team OR company` }] : []),
  ];

  const allSnippets: string[] = [];
  let scrapedContent = '';

  // Execute all 7 searches in parallel
  const searchResults = await Promise.allSettled(
    queries.map(q =>
      searchSerpApi(q.query, { num: 5 })
        .then(results => results.map(r => `[${q.label}] ${r.title}: ${r.snippet}`))
        .catch(() => [] as string[])
    )
  );

  searchResults.forEach(r => {
    if (r.status === 'fulfilled') allSnippets.push(...r.value);
  });

  // Try to scrape the company website "about" and "contact" pages
  if (domain) {
    const pagesToScrape = [`https://${domain}/about`, `https://${domain}/contact`];
    const scrapeResults = await Promise.allSettled(
      pagesToScrape.map(url =>
        scrapeUrl(url, { timeout: 8000 })
          .then(page => page.content ? page.content.substring(0, 2000) : '')
          .catch(() => '')
      )
    );
    const scraped = scrapeResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => (r as PromiseFulfilledResult<string>).value);
    scrapedContent = scraped.join('\n\n');
  }

  if (allSnippets.length === 0 && !scrapedContent) {
    return {};
  }

  // Use Claude to extract structured company data
  try {
    const router = getProviderRouter();
    const response = await router.route({
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      maxTokens: 1024,
      messages: [{
        role: 'user',
        content: `Extract company profile data for "${companyName}"${domain ? ` (${domain})` : ''} from these sources.

Search Results:
${allSnippets.join('\n')}

${scrapedContent ? `Company Website (About Page):\n${scrapedContent}` : ''}

Return ONLY this JSON (no markdown):
{
  "domain": "company.com",
  "size": "1-10" or "11-50" or "51-200" or "201-500" or "501-1000" or "1000+" or "",
  "industry": "e.g., SaaS, Healthcare, FinTech, etc." or "",
  "revenue": "$1M-$10M" or "$10M-$50M" or "$50M-$100M" or "$100M+" or "",
  "funding": "Seed" or "Series A" or "Series B" or "Series C+" or "Public" or "Bootstrapped" or "",
  "fundingAmount": "$5M" or "" (total raised),
  "techStack": ["React", "AWS", "Python"] or [],
  "headcount": 150 or null,
  "foundedYear": 2018 or null,
  "description": "One-sentence description of what the company does" or ""
}

Only include data clearly about "${companyName}". Leave fields empty/null if not found. Do not fabricate.`,
      }],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') return {};

    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const parsed = JSON.parse(jsonMatch[0]);
    const enrichment: CompanyEnrichment = {
      domain: parsed.domain || domain || undefined,
      size: parsed.size || undefined,
      industry: parsed.industry || undefined,
      revenue: parsed.revenue || undefined,
      funding: parsed.funding || undefined,
      fundingAmount: parsed.fundingAmount || undefined,
      techStack: Array.isArray(parsed.techStack) && parsed.techStack.length > 0 ? parsed.techStack : undefined,
      headcount: typeof parsed.headcount === 'number' ? parsed.headcount : undefined,
      foundedYear: typeof parsed.foundedYear === 'number' ? parsed.foundedYear : undefined,
      description: parsed.description || undefined,
    };

    // Cache the result
    const hasData = Object.values(enrichment).some(v => v !== undefined);
    if (hasData) {
      await setCachedEnrichment(cacheKey, enrichment);
    }

    return enrichment;
  } catch (err) {
    console.error('[CompanyEnrichment] Claude extraction failed:', err);
    return {};
  }
}

/**
 * Batch enrich multiple companies. Deduplicates by company name.
 * Returns a map of companyName → CompanyEnrichment.
 */
export async function enrichCompanies(
  companies: Array<{ name: string; domain?: string }>,
  concurrency: number = 3,
): Promise<Map<string, CompanyEnrichment>> {
  const results = new Map<string, CompanyEnrichment>();

  // Deduplicate by normalized company name
  const uniqueCompanies = new Map<string, { name: string; domain?: string }>();
  for (const c of companies) {
    const key = c.name.toLowerCase().trim();
    if (!uniqueCompanies.has(key)) {
      uniqueCompanies.set(key, c);
    }
  }

  const entries = Array.from(uniqueCompanies.values());

  // Process in batches
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async (c) => {
        const enrichment = await enrichCompany(c.name, c.domain);
        return { name: c.name, enrichment };
      })
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.set(r.value.name, r.value.enrichment);
      }
    }
  }

  return results;
}
