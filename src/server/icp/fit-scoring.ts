/**
 * Fit Scoring — Phase 2 AI layer.
 *
 * Given a prospect + the customer's ICP, asks Claude to rate how well the
 * prospect matches on a 0-100 scale with structured reasoning.
 *
 * This is the LLM-based companion to intent-scoring.ts (which is
 * deterministic, rule-based signal aggregation). Intent scoring tells you
 * "how much buying intent does this prospect show right now." Fit scoring
 * tells you "is this prospect even the right target for my product."
 *
 * A prospect with low fit + high intent = probably a bad lead (wrong ICP).
 * A prospect with high fit + high intent = IDEAL target (pursue now).
 * Use both in the outreach prioritization pipeline.
 */

import { getProviderRouter } from '@/server/ai/providers';

/**
 * Customer's Ideal Customer Profile — structured enough to feed an LLM,
 * flexible enough to describe any B2B ICP.
 *
 * Extended with `outreach` — the customer's own pitch context (value prop,
 * sender identity, social proof). Stored alongside the targeting criteria
 * so the outreach drafter can auto-populate instead of asking every time.
 */
export interface CustomerICP {
  /** Industries the product fits (e.g., "SaaS", "Healthcare", "E-commerce") */
  industries?: string[];
  /** Company headcount ranges */
  companySizes?: Array<'1-10' | '11-50' | '51-200' | '201-1000' | '1000+'>;
  /** Target prospect titles (e.g., "CRO", "Head of Sales", "Founder") */
  titles?: string[];
  /** Geographies (ISO country codes or free text) */
  geographies?: string[];
  /** Use cases the product solves (free text per case) */
  useCases?: string[];
  /** Catch-all free-text criteria ("must have a field sales team") */
  customCriteria?: string;
  /** Customer's own pitch context, used by outreach drafter */
  outreach?: {
    /** Customer's company name — appears in signature */
    companyName?: string;
    /** One-line value prop */
    valueProp?: string;
    /** Default sender name */
    senderName?: string;
    /** Default sender title */
    senderTitle?: string;
    /** Social proof logos/names */
    socialProof?: string[];
    /** Default tone for drafts */
    defaultTone?: 'formal' | 'casual' | 'consultative' | 'direct';
    /** Calendar / meeting booking link (Calendly, Cal.com, internal, etc.) */
    bookingUrl?: string;
  };
}

/**
 * What we know about the prospect. All fields optional — scorer handles
 * partial data gracefully.
 */
export interface ProspectProfile {
  name?: string;
  title?: string;
  company?: string;
  companySize?: string;
  industry?: string;
  country?: string;
  description?: string;
  /** Intent signals from the deterministic scorer, if already computed */
  intentHeadline?: string;
}

export interface FitScore {
  /** 0-100 */
  score: number;
  tier: 'ideal' | 'good' | 'marginal' | 'poor';
  /** One-sentence headline e.g. "Matches industry + title; below target company size" */
  reasoning: string;
  /** 2-4 concrete factors that drove the score */
  matchedFactors: string[];
  /** 0-2 concrete gaps */
  gaps: string[];
}

function tierFor(score: number): FitScore['tier'] {
  if (score >= 75) return 'ideal';
  if (score >= 50) return 'good';
  if (score >= 25) return 'marginal';
  return 'poor';
}

/**
 * Score a prospect against the customer's ICP. Uses Claude Haiku (fast, cheap).
 * Returns a structured score; swallows model errors into a neutral 0 score
 * so the caller never has to try/catch.
 */
export async function scoreProspectFit(
  prospect: ProspectProfile,
  icp: CustomerICP,
): Promise<FitScore> {
  // Short-circuit: if the ICP is empty, there's nothing to score against.
  const icpIsEmpty = !icp.industries?.length && !icp.titles?.length
    && !icp.companySizes?.length && !icp.geographies?.length
    && !icp.useCases?.length && !icp.customCriteria;
  if (icpIsEmpty) {
    return {
      score: 0,
      tier: 'poor',
      reasoning: 'No ICP defined — cannot compute fit',
      matchedFactors: [],
      gaps: ['Customer has not defined an ideal customer profile'],
    };
  }

  const prospectDesc = [
    prospect.name && `Name: ${prospect.name}`,
    prospect.title && `Title: ${prospect.title}`,
    prospect.company && `Company: ${prospect.company}`,
    prospect.industry && `Industry: ${prospect.industry}`,
    prospect.companySize && `Company size: ${prospect.companySize}`,
    prospect.country && `Country: ${prospect.country}`,
    prospect.description && `About: ${prospect.description}`,
    prospect.intentHeadline && `Intent: ${prospect.intentHeadline}`,
  ].filter(Boolean).join('\n');

  const icpDesc = [
    icp.industries?.length && `Target industries: ${icp.industries.join(', ')}`,
    icp.companySizes?.length && `Target company sizes: ${icp.companySizes.join(', ')}`,
    icp.titles?.length && `Target titles: ${icp.titles.join(', ')}`,
    icp.geographies?.length && `Target geographies: ${icp.geographies.join(', ')}`,
    icp.useCases?.length && `Use cases solved: ${icp.useCases.join('; ')}`,
    icp.customCriteria && `Other criteria: ${icp.customCriteria}`,
  ].filter(Boolean).join('\n');

  try {
    const router = getProviderRouter();
    const response = await router.route({
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      maxTokens: 512,
      messages: [{
        role: 'user',
        content: `You are a B2B sales-fit analyst. Score how well this prospect matches the customer's ICP.

ICP:
${icpDesc}

PROSPECT:
${prospectDesc || '(minimal info)'}

Return ONLY this JSON (no markdown, no prose before/after):
{
  "score": 0-100,
  "reasoning": "one sentence, max 120 chars",
  "matchedFactors": ["2-4 short factors, each max 60 chars"],
  "gaps": ["0-2 short gaps, each max 60 chars"]
}

Scoring guide:
- 85-100: Perfect match across all ICP axes we have data on
- 65-84: Strong match on most axes, minor mismatches
- 40-64: Half-match — right industry but wrong title, or vice versa
- 20-39: Weak match with one or two aligned factors
- 0-19: Fundamental mismatch

Penalize aggressively for missing prospect data — if you can't verify fit, score lower.`,
      }],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') {
      return {
        score: 0, tier: 'poor',
        reasoning: 'Fit scorer returned no content',
        matchedFactors: [], gaps: [],
      };
    }

    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        score: 0, tier: 'poor',
        reasoning: 'Fit scorer returned invalid JSON',
        matchedFactors: [], gaps: [],
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const score = Math.max(0, Math.min(100, Number(parsed.score) || 0));
    return {
      score,
      tier: tierFor(score),
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : '',
      matchedFactors: Array.isArray(parsed.matchedFactors)
        ? parsed.matchedFactors.slice(0, 4).map((f: unknown) => String(f).slice(0, 80))
        : [],
      gaps: Array.isArray(parsed.gaps)
        ? parsed.gaps.slice(0, 2).map((g: unknown) => String(g).slice(0, 80))
        : [],
    };
  } catch (err) {
    console.error('[fit-scoring] Claude call failed:', err);
    return {
      score: 0, tier: 'poor',
      reasoning: 'Fit scoring failed',
      matchedFactors: [], gaps: [],
    };
  }
}
