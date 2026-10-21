/**
 * Intent Signals — In-house buying intent detection via SerpAPI + Claude.
 * Detects: job postings, funding rounds, tech stack, growth signals.
 * No external paid APIs (Bombora, 6sense, etc.) — uses Google search.
 */

import { searchSerpApi } from './serpapi';
import { detectTechStack } from './tech-stack';
import { getProviderRouter } from '../ai/providers';
import type { IntentSignals, FundingSignal } from '@/types/lead-enrichment';

/**
 * Detect intent signals for a company using SerpAPI searches + Claude analysis.
 * Returns an IntentSignals object with a composite intentScore (0-100).
 *
 * Executes up to 3 SerpAPI queries in parallel:
 * 1. Job postings query
 * 2. Funding/news query
 * 3. Tech stack query
 */
export async function getIntentSignals(
  companyName: string,
  domain?: string,
): Promise<IntentSignals> {
  if (!companyName) {
    return { isHiring: false, intentScore: 0 };
  }

  const queries = [
    // Job postings
    {
      type: 'hiring',
      query: `"${companyName}" ("we're hiring" OR "open positions" OR "join our team" OR "careers")`,
    },
    // Funding / news
    {
      type: 'funding',
      query: `"${companyName}" ("raised" OR "funding" OR "series" OR "investment") site:techcrunch.com OR site:crunchbase.com OR site:bloomberg.com`,
    },
    // Tech stack (optional, only if domain available)
    ...(domain ? [{
      type: 'tech',
      query: `site:builtwith.com "${domain}" OR site:stackshare.io "${companyName}"`,
    }] : []),
  ];

  // Execute searches in parallel — plus a direct tech-stack scan if we have a domain.
  // Tech-stack scan is a far stronger buying signal than search snippets (pattern-matches
  // the prospect's actual live website for competitor signatures).
  const [searchResults, techStackResult] = await Promise.all([
    Promise.allSettled(
      queries.map(async (q) => {
        try {
          const results = await searchSerpApi(q.query, { num: 5 });
          return {
            type: q.type,
            snippets: results.map(r => `${r.title}: ${r.snippet}`).join('\n'),
            count: results.length,
          };
        } catch {
          return { type: q.type, snippets: '', count: 0 };
        }
      })
    ),
    domain ? detectTechStack(domain).catch(() => null) : Promise.resolve(null),
  ]);

  const searchData: Record<string, { snippets: string; count: number }> = {};
  searchResults.forEach(r => {
    if (r.status === 'fulfilled') {
      searchData[r.value.type] = { snippets: r.value.snippets, count: r.value.count };
    }
  });

  const competitorNames = (techStackResult?.competitors || []).map(c => c.name);
  // Detected-competitor bonus: using HubSpot/Zoho/etc. is a strong switching-target signal.
  const competitorBonus = competitorNames.length > 0 ? 25 : 0;

  // If no search results at all, return signals based on tech-stack alone (if any).
  const totalSnippets = Object.values(searchData).reduce((sum, d) => sum + d.snippets.length, 0);
  if (totalSnippets === 0) {
    return {
      isHiring: false,
      competitors: competitorNames.length > 0 ? competitorNames : undefined,
      intentScore: competitorBonus,
    };
  }

  // Use Claude to extract structured intent signals from search snippets
  try {
    const router = getProviderRouter();
    const response = await router.route({
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      maxTokens: 1024,
      messages: [{
        role: 'user',
        content: `Analyze these search results about "${companyName}" and extract buying intent signals.

HIRING SIGNALS:
${searchData.hiring?.snippets || 'No results found'}

FUNDING/NEWS:
${searchData.funding?.snippets || 'No results found'}

TECH STACK:
${searchData.tech?.snippets || 'No results found'}

Return ONLY this JSON (no markdown):
{
  "isHiring": true/false,
  "hiringDepartments": ["Engineering", "Sales", etc.] or [],
  "recentFunding": { "amount": "$10M", "round": "Series A", "date": "2024-03", "source": "TechCrunch" } or null,
  "techStack": ["React", "AWS", "Python", etc.] or [],
  "growthSignals": ["Expanding to new markets", "Rapid headcount growth", etc.] or [],
  "intentScore": 0-100
}

Intent score guide:
- 80-100: Actively hiring in relevant departments + recent funding + tech adoption signals
- 60-79: Hiring OR recent funding, some growth signals
- 40-59: Some signals present but not strong
- 20-39: Weak signals, limited recent activity
- 0-19: No meaningful intent signals found

Only include data clearly about "${companyName}". Do not fabricate.`,
      }],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') {
      return { isHiring: false, intentScore: 0 };
    }

    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { isHiring: false, intentScore: 0 };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Merge Claude-extracted techStack with directly-detected stack, dedupe.
    const mergedTechStack = Array.from(new Set([
      ...(Array.isArray(parsed.techStack) ? parsed.techStack : []),
      ...(techStackResult?.technologies.map(t => t.name) || []),
    ]));

    const baseScore = typeof parsed.intentScore === 'number'
      ? Math.min(100, Math.max(0, parsed.intentScore))
      : 0;

    return {
      isHiring: Boolean(parsed.isHiring),
      hiringDepartments: Array.isArray(parsed.hiringDepartments) ? parsed.hiringDepartments : [],
      recentFunding: parsed.recentFunding ? {
        amount: parsed.recentFunding.amount || undefined,
        round: parsed.recentFunding.round || undefined,
        date: parsed.recentFunding.date || undefined,
        source: parsed.recentFunding.source || undefined,
      } as FundingSignal : undefined,
      techStack: mergedTechStack,
      competitors: competitorNames.length > 0 ? competitorNames : undefined,
      growthSignals: Array.isArray(parsed.growthSignals) ? parsed.growthSignals : [],
      intentScore: Math.min(100, baseScore + competitorBonus),
    };
  } catch (err) {
    console.error('[IntentSignals] Claude analysis failed:', err);
    // Return basic signals from search hit count + competitor detection alone
    const hiringHits = searchData.hiring?.count || 0;
    const fundingHits = searchData.funding?.count || 0;
    return {
      isHiring: hiringHits > 0,
      competitors: competitorNames.length > 0 ? competitorNames : undefined,
      intentScore: Math.min(100, (hiringHits * 10) + (fundingHits * 15) + competitorBonus),
    };
  }
}
