/**
 * Crunchbase Integration — Free API for company profiles and funding data.
 * Uses SerpAPI to search Crunchbase pages + Claude to extract structured data.
 * (Direct Crunchbase API requires enterprise pricing, so we scrape public pages.)
 */

import { searchSerpApi } from './serpapi';
import { scrapeUrl } from '@/server/ai/web-scraper';
import { getProviderRouter } from '../ai/providers';

export interface CrunchbaseResult {
  name: string;
  title?: string;
  company?: string;
  linkedinUrl?: string;
  website?: string;
  location?: string;
  source: string;
  score: number;
  /** Company data extracted from Crunchbase */
  companyData?: {
    funding?: string;
    fundingAmount?: string;
    industry?: string;
    size?: string;
    foundedYear?: number;
  };
}

/**
 * Search Crunchbase for people and companies matching search criteria.
 * Returns leads found on Crunchbase profiles.
 */
export async function searchCrunchbase(
  searchTerms: string,
  options?: { maxResults?: number },
): Promise<CrunchbaseResult[]> {
  const maxResults = options?.maxResults || 10;

  // Search Crunchbase via SerpAPI
  const queries = [
    `site:crunchbase.com/person ${searchTerms}`,
    `site:crunchbase.com/organization ${searchTerms}`,
  ];

  const allSnippets: Array<{ url: string; title: string; snippet: string }> = [];

  const searchResults = await Promise.allSettled(
    queries.map(q =>
      searchSerpApi(q, { num: Math.ceil(maxResults / 2) })
        .catch(() => [])
    )
  );

  for (const r of searchResults) {
    if (r.status === 'fulfilled') {
      allSnippets.push(...r.value);
    }
  }

  if (allSnippets.length === 0) return [];

  // Scrape top results for richer data
  const scrapedContent: string[] = [];
  const scrapePromises = allSnippets.slice(0, 6).map(async (result) => {
    try {
      const page = await scrapeUrl(result.url, { timeout: 8000 });
      return `URL: ${result.url}\nTitle: ${result.title}\n${page.content.substring(0, 2500)}`;
    } catch {
      return `URL: ${result.url}\nTitle: ${result.title}\n${result.snippet}`;
    }
  });

  const scraped = await Promise.allSettled(scrapePromises);
  scraped.forEach(r => {
    if (r.status === 'fulfilled') scrapedContent.push(r.value);
  });

  if (scrapedContent.length === 0) return [];

  // Extract structured leads from Crunchbase content
  try {
    const router = getProviderRouter();
    const response = await router.route({
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      maxTokens: 2048,
      messages: [{
        role: 'user',
        content: `Extract people and company information from these Crunchbase pages.

Search context: ${searchTerms}

Content:
${scrapedContent.join('\n\n---\n\n')}

Return ONLY this JSON (no markdown):
{
  "leads": [
    {
      "name": "Person Name",
      "title": "Job Title",
      "company": "Company Name",
      "linkedinUrl": "",
      "website": "company website",
      "location": "City, Country",
      "source": "crunchbase url",
      "score": 70,
      "companyData": {
        "funding": "Series A",
        "fundingAmount": "$5M",
        "industry": "SaaS",
        "size": "51-200",
        "foundedYear": 2019
      }
    }
  ]
}

Rules:
- Only extract real people with identifiable names
- Include company funding/size data when available
- Score based on relevance to search context (0-100)
- Return up to ${maxResults} leads
- Do not fabricate information`,
      }],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') return [];

    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    return (parsed.leads || []).map((l: any) => ({
      name: l.name || '',
      title: l.title || '',
      company: l.company || '',
      linkedinUrl: l.linkedinUrl || undefined,
      website: l.website || undefined,
      location: l.location || '',
      source: l.source || 'crunchbase',
      score: typeof l.score === 'number' ? l.score : 50,
      companyData: l.companyData || undefined,
    }));
  } catch (err) {
    console.error('[Crunchbase] Extraction failed:', err);
    return [];
  }
}
