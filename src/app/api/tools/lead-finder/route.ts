/**
 * Free Lead Finder — Public API endpoint (no auth required).
 * Rate-limited to 3 searches/day per IP. Returns max 3 leads, no enrichment.
 * Requires email signup to see results.
 */

import { NextRequest, NextResponse } from 'next/server';
import { callerKey, consumeGlobalDailyCap, consumeRateLimit } from '@/server/rate-limit';
import { getProviderRouter } from '@/server/ai/providers';
import { searchSerpApi, buildFilterQueries, type LeadSearchQuery } from '@/server/discovery/serpapi';
import { scrapeUrl } from '@/server/ai/web-scraper';

export const dynamic = 'force-dynamic';

const FREE_TOOL_RATE_LIMIT = {
  limit: 3,
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
};

const FREE_MAX_LEADS = 3;
const FREE_MAX_PAGES = 4;
const FREE_MAX_QUERIES = 3;

interface FreeLeadFinderRequest {
  jobTitles?: string;
  industries?: string[];
  locations?: string;
  email: string; // Required — captures email for the signup funnel
}

export async function POST(request: NextRequest) {
  try {
    // Rate limit by IP
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || request.headers.get('x-real-ip')
      || 'unknown';
    // Two limits, because they defend against different things. The per-IP
    // limit stops one person hammering the endpoint; the global daily cap
    // bounds what a distributed caller can cost, since this route is
    // unauthenticated and every request spends LLM and search credits.
    const perCaller = await consumeRateLimit(
      callerKey(request, 'free-lead-finder'),
      FREE_TOOL_RATE_LIMIT.limit,
      FREE_TOOL_RATE_LIMIT.windowMs / 1000,
    );
    if (!perCaller.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: 'You have reached the free search limit. Please try again tomorrow.',
        },
        {
          status: 429,
          headers: {
            'retry-after': String(Math.ceil((perCaller.resetAt.getTime() - Date.now()) / 1000)),
            'x-ratelimit-limit': String(perCaller.limit),
            'x-ratelimit-remaining': String(perCaller.remaining),
          },
        },
      );
    }

    const globalCap = await consumeGlobalDailyCap('free-lead-finder');
    if (!globalCap.allowed) {
      console.warn('[lead-finder] global daily cap reached');
      return NextResponse.json(
        {
          success: false,
          error: 'This free tool is at capacity for today. Please try again tomorrow.',
        },
        { status: 429, headers: { 'retry-after': '3600' } },
      );
    }

    const body: FreeLeadFinderRequest = await request.json();

    // Validate email is provided
    if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return NextResponse.json(
        { success: false, error: 'A valid email address is required to use this tool.' },
        { status: 400 }
      );
    }

    // Validate at least one filter
    const jobTitles = body.jobTitles?.split(',').map(t => t.trim()).filter(Boolean) || [];
    const industries = body.industries || [];
    const locations = body.locations?.split(',').map(l => l.trim()).filter(Boolean) || [];

    if (jobTitles.length === 0 && industries.length === 0 && locations.length === 0) {
      return NextResponse.json(
        { success: false, error: 'At least one search filter is required.' },
        { status: 400 }
      );
    }

    // Build search queries (limited)
    const searchQueries = buildFilterQueries({ jobTitles, industries, locations })
      .slice(0, FREE_MAX_QUERIES);

    // Execute searches
    const allSearchResults: Array<{ title: string; url: string; snippet: string; queryType: string }> = [];
    const serpResults = await Promise.allSettled(
      searchQueries.map(sq =>
        searchSerpApi(sq.query, { num: 5 })
          .then(results => results.map(r => ({ ...r, queryType: sq.type })))
      )
    );
    for (const result of serpResults) {
      if (result.status === 'fulfilled') {
        allSearchResults.push(...result.value);
      }
    }

    if (allSearchResults.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No results found. Try broader search criteria.' },
        { status: 404 }
      );
    }

    // Deduplicate and scrape (limited)
    const uniqueResults = Array.from(
      new Map(allSearchResults.map(r => [r.url, r])).values()
    ).slice(0, FREE_MAX_PAGES);

    const scrapePromises = uniqueResults.map(async (result) => {
      try {
        const page = await scrapeUrl(result.url, { timeout: 8000 });
        return {
          url: result.url,
          title: page.title || result.title,
          content: (page.content || '').substring(0, 3000),
          queryType: result.queryType,
        };
      } catch {
        return {
          url: result.url,
          title: result.title,
          content: result.snippet,
          queryType: result.queryType,
        };
      }
    });

    const scrapeResults = await Promise.allSettled(scrapePromises);
    const scrapedContents: Array<{ url: string; title: string; content: string }> = [];
    scrapeResults.forEach(r => {
      if (r.status === 'fulfilled' && r.value) scrapedContents.push(r.value);
    });

    if (scrapedContents.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Could not extract content. Please try again.' },
        { status: 500 }
      );
    }

    // Extract leads with Claude (limited to 3)
    const router = getProviderRouter();
    const combinedContent = scrapedContents
      .map((s, i) => `--- PAGE ${i + 1} ---\nURL: ${s.url}\nTitle: ${s.title}\n${s.content}`)
      .join('\n\n');

    const extractionResponse = await router.route({
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      maxTokens: 1024,
      messages: [{
        role: 'user',
        content: `Extract up to ${FREE_MAX_LEADS} B2B leads from these pages.

Search: Job Titles: ${body.jobTitles || 'any'}, Industries: ${body.industries?.join(', ') || 'any'}, Locations: ${body.locations || 'any'}

Content:
${combinedContent}

Return ONLY JSON:
{
  "leads": [
    { "name": "...", "title": "...", "company": "...", "location": "...", "score": 80 }
  ],
  "summary": "Brief summary"
}

Rules:
- Max ${FREE_MAX_LEADS} leads, sorted by score
- Only include name, title, company, location, score
- No email/phone (free tier)
- Do not fabricate`,
      }],
    });

    const text = extractionResponse.content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') {
      return NextResponse.json(
        { success: false, error: 'Extraction failed. Please try again.' },
        { status: 500 }
      );
    }

    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json(
        { success: false, error: 'Could not parse results.' },
        { status: 500 }
      );
    }

    const result = JSON.parse(jsonMatch[0]);
    const leads = (result.leads || []).slice(0, FREE_MAX_LEADS).map((l: any) => ({
      name: l.name || 'Unknown',
      title: l.title || '',
      company: l.company || '',
      location: l.location || '',
      score: typeof l.score === 'number' ? l.score : 50,
    }));

    return NextResponse.json({
      success: true,
      leads,
      summary: result.summary || '',
      metadata: {
        tier: 'free',
        maxLeads: FREE_MAX_LEADS,
        upgradeMessage: 'Upgrade for unlimited leads with email, phone, intent signals, and more.',
      },
    });
  } catch (err) {
    console.error('[FreeLeadFinder] Error:', err);
    return NextResponse.json(
      { success: false, error: 'Search failed. Please try again.' },
      { status: 500 }
    );
  }
}
