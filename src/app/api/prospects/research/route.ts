import { NextRequest, NextResponse } from 'next/server';
import { billingErrorResponse, getBillingProvider } from '@/server/billing';
import { requireAuth } from '@/server/auth/require-auth';
import { scrapeMultipleUrls } from '@/server/ai/web-scraper';
import { getProviderRouter } from '@/server/ai/providers';

export const dynamic = 'force-dynamic';

const RESEARCH_COST = 2;

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth(request);
    if (error || !user) {
      return NextResponse.json(
        { success: false, error: error?.message || 'Authentication required' },
        { status: error?.status || 401 }
      );
    }

    const billing = getBillingProvider();
    const billingCtx = {
      orgId: user.orgId,
      userId: user.sub,
      authToken: request.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
    };
    const gate = await billing.preCheck(billingCtx, RESEARCH_COST);
    if (!gate.ok) return billingErrorResponse(gate);

    const router = getProviderRouter();
    const body = await request.json();
    const { companyName, website, industry, notes } = body;

    if (!companyName || !website) {
      return NextResponse.json(
        { success: false, error: 'Company name and website URL are required' },
        { status: 400 }
      );
    }

    // Normalize URL
    let normalizedUrl = website.trim();
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    // Validate URL
    try {
      new URL(normalizedUrl);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid website URL format' },
        { status: 400 }
      );
    }

    // Scrape website
    let pages;
    try {
      pages = await scrapeMultipleUrls(normalizedUrl, {
        followLinks: true,
        maxPages: 3,
        maxDepth: 1,
        timeout: 15000,
      });
    } catch (scrapeError) {
      console.error('Scrape error:', scrapeError);
      return NextResponse.json(
        {
          success: false,
          error: `Could not access website: ${scrapeError instanceof Error ? scrapeError.message : 'Unknown error'}. Please verify the URL is correct and the site is publicly accessible.`,
        },
        { status: 400 }
      );
    }

    if (!pages || pages.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Could not extract any content from the website. Please verify the URL.' },
        { status: 400 }
      );
    }

    // Combine scraped content with truncation
    const combinedContent = pages
      .map(p => {
        const truncatedContent = p.content.length > 2000
          ? p.content.slice(0, 2000) + '...'
          : p.content;
        return `PAGE: ${p.title}\nURL: ${p.url}\n${p.description ? `Description: ${p.description}\n` : ''}${truncatedContent}`;
      })
      .join('\n\n---\n\n');

    // Build prompt
    const systemPrompt = `You are an expert B2B sales researcher and prospect strategist. Your job is to analyze company websites and suggest the most relevant decision-maker roles for sales outreach. Always respond with valid JSON.`;

    const userPrompt = `Analyze this company and suggest prospect targets for B2B sales outreach.

Company: ${companyName}
Website: ${normalizedUrl}
${industry ? `Industry: ${industry}` : ''}
${notes ? `Additional Context: ${notes}` : ''}

Website Content:
${combinedContent}

Based on the company's website content, provide:
1. A brief company profile
2. An ICP (Ideal Customer Profile) fit score (0-100)
3. A suggested outreach approach
4. 5-7 specific decision-maker roles to target as prospects

For each suggested prospect role, include:
- title: The exact job title (e.g., "VP of Engineering", "Head of Sales")
- department: The department (e.g., "Engineering", "Sales", "Marketing", "Operations", "Finance", "Executive")
- priority: "high", "medium", or "low"
- reasoning: A brief explanation of why this role is a good prospect target
- score: A qualification score from 0-100

Respond ONLY with this JSON structure:
{
  "companyProfile": {
    "industry": "string",
    "size": "string (e.g., 'Startup', 'SMB', 'Mid-Market', 'Enterprise')",
    "description": "1-2 sentence company summary"
  },
  "icpScore": 75,
  "approach": "1-2 sentence suggested outreach approach",
  "suggestedProspects": [
    {
      "title": "Chief Technology Officer",
      "department": "Technology",
      "priority": "high",
      "reasoning": "Primary technical decision-maker for technology purchases",
      "score": 85
    }
  ]
}`;

    // Call Claude
    const response = await router.route({
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      maxTokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Extract text response
    const textBlock = response.content.find(block => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from AI');
    }

    // Parse JSON from response
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse AI response as JSON');
    }

    const result = JSON.parse(jsonMatch[0]);

    // Validate response structure
    if (!result.suggestedProspects || !Array.isArray(result.suggestedProspects)) {
      throw new Error('AI response missing suggestedProspects array');
    }

    // Charged only now, after the research actually produced something. A
    // failed scrape or an unparseable model response costs the user nothing.
    await billing.consume(billingCtx, 'copilot', RESEARCH_COST, {
      description: `Company research — ${companyName}`,
      context: { surface: 'prospects.research', company: companyName },
    });

    return NextResponse.json({
      success: true,
      companyProfile: result.companyProfile || { industry: industry || 'Unknown', size: 'Unknown', description: '' },
      icpScore: result.icpScore || 50,
      approach: result.approach || '',
      suggestedProspects: result.suggestedProspects.map((p: any) => ({
        title: p.title || 'Unknown Role',
        department: p.department || 'General',
        priority: ['high', 'medium', 'low'].includes(p.priority) ? p.priority : 'medium',
        reasoning: p.reasoning || '',
        score: typeof p.score === 'number' ? Math.min(100, Math.max(0, p.score)) : 50,
      })),
      metadata: {
        pagesAnalyzed: pages.length,
        websiteScraped: normalizedUrl,
      },
    });
  } catch (err) {
    const errName = (err as { name?: string })?.name;
    const errMsg = err instanceof Error ? err.message : String(err);
    const errMeta = (err as { $metadata?: unknown })?.$metadata;
    console.error('Prospect research API error:', { errName, errMsg, errMeta, stack: err instanceof Error ? err.stack : undefined });

    const lower = errMsg.toLowerCase();
    const isAiError =
      lower.includes('bedrock') ||
      lower.includes('anthropic') ||
      lower.includes('claude') ||
      lower.includes('modelstream') ||
      lower.includes('accessdenied') ||
      lower.includes('throttl');

    return NextResponse.json(
      {
        success: false,
        errorCode: isAiError ? 'ai_unavailable' : 'internal',
        error: isAiError
          ? "We couldn't reach the AI right now. Please try again in a minute."
          : 'Research failed. Please try again.',
      },
      { status: 500 }
    );
  }
}
