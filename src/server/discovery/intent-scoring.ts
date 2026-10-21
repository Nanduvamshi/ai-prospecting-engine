/**
 * Composite Intent Scoring — Phase 1 Scoring Layer.
 *
 * Aggregates results from all 9 intent signals into a single 0-100 score
 * per prospect, with a breakdown explaining why.
 *
 * This layer is intentionally dumb and deterministic — no LLM calls.
 * Weights are first-pass heuristics; tune based on observed close rates
 * per signal combination once we have enough data (Phase 2 will replace
 * this with an LLM-based fit scorer that reads the breakdown).
 *
 * Signals (all optional — higher score if more present):
 *   S1  Competitor detection          +25
 *   S2  Hiring ICP roles              +15
 *   S3  Tech stack change (switch)    +30   <-- highest single bump
 *   S4  Negative review w/ switch     +20
 *   S5  Reddit/HN direct buying Q     +25
 *   S6  First-party site visit        +35   <-- highest, already researching US
 *   S7  Recent funding announcement   +15
 *   S8  Recent C-level / VP change    +15
 *   S9  New domain (if ICP-keyword)   +10
 *
 * Max raw: 190. Capped at 100.
 */

export interface ProspectScoringInput {
  company?: string;
  domain?: string;

  // Optional pre-fetched signal inputs. Pass what you already have;
  // the scorer won't refetch. If omitted, that signal contributes zero
  // (don't make the scorer fetch — keeps it fast, let the caller decide
  // what to spend API budget on).
  competitors?: string[];                       // Signal 1 — list of detected CRM/helpdesk tools
  icpJobCount?: number;                          // Signal 2 — count of ICP roles open
  techStackChanged?: { added: string[]; removed: string[]; competitorChange: boolean }; // Signal 3
  negativeReviewSwitchIntent?: number;           // Signal 4 — count of 1-2★ reviews w/ switching intent
  socialBuyingSignals?: number;                  // Signal 5 — count of direct Reddit/HN buying queries
  recentFundingRound?: string;                   // Signal 7 — "Series A", "Seed", etc. if fresh (<90 days)
  recentExecChange?: 'this_week' | 'this_month' | 'this_quarter'; // Signal 8
  newDomainMatch?: boolean;                      // Signal 9 — domain registered < 30 days
}

export interface SignalContribution {
  signalId: string;
  label: string;
  points: number;
}

export interface ProspectScore {
  company?: string;
  domain?: string;
  /** 0-100 */
  score: number;
  /** Verdict band for the UI */
  tier: 'hot' | 'warm' | 'lukewarm' | 'cold';
  /** Positive-only contributions, largest first */
  contributions: SignalContribution[];
  /** One-line headline explaining the hottest factor */
  headline: string;
}

const TIER_CUTOFFS: Array<{ tier: ProspectScore['tier']; min: number }> = [
  { tier: 'hot', min: 70 },
  { tier: 'warm', min: 45 },
  { tier: 'lukewarm', min: 20 },
  { tier: 'cold', min: 0 },
];

function tierFor(score: number): ProspectScore['tier'] {
  for (const { tier, min } of TIER_CUTOFFS) if (score >= min) return tier;
  return 'cold';
}

/**
 * Compute a composite intent score from the signals the caller has gathered.
 */
export function scoreProspect(input: ProspectScoringInput): ProspectScore {
  const contributions: SignalContribution[] = [];

  // Signal 1: Competitor detection
  if (input.competitors && input.competitors.length > 0) {
    contributions.push({
      signalId: 'S1_competitor',
      label: `Uses competitor: ${input.competitors.slice(0, 3).join(', ')}`,
      points: 25,
    });
  }

  // Signal 2: Hiring ICP roles
  if (input.icpJobCount && input.icpJobCount > 0) {
    const points = Math.min(15, 5 + input.icpJobCount * 3);
    contributions.push({
      signalId: 'S2_hiring',
      label: `Hiring ${input.icpJobCount} ICP role${input.icpJobCount > 1 ? 's' : ''}`,
      points,
    });
  }

  // Signal 3: Tech stack change (highest single-factor bump — tool SWITCH is fresh)
  if (input.techStackChanged) {
    const { added, removed, competitorChange } = input.techStackChanged;
    if (competitorChange) {
      const what = removed.length > 0 ? `Removed ${removed.slice(0, 2).join(', ')}` : `Added ${added.slice(0, 2).join(', ')}`;
      contributions.push({ signalId: 'S3_switch', label: `Tool switch: ${what}`, points: 30 });
    } else if (added.length + removed.length > 0) {
      contributions.push({
        signalId: 'S3_change',
        label: `Tech stack changed (${added.length + removed.length} tools)`,
        points: 10,
      });
    }
  }

  // Signal 4: Negative review with switching intent
  if (input.negativeReviewSwitchIntent && input.negativeReviewSwitchIntent > 0) {
    contributions.push({
      signalId: 'S4_review',
      label: `${input.negativeReviewSwitchIntent} negative review${input.negativeReviewSwitchIntent > 1 ? 's' : ''} with switch intent`,
      points: 20,
    });
  }

  // Signal 5: Social buying signals
  if (input.socialBuyingSignals && input.socialBuyingSignals > 0) {
    const points = Math.min(25, 10 + input.socialBuyingSignals * 5);
    contributions.push({
      signalId: 'S5_social',
      label: `${input.socialBuyingSignals} public buying-intent post${input.socialBuyingSignals > 1 ? 's' : ''}`,
      points,
    });
  }

  // Signal 7: Recent funding
  if (input.recentFundingRound) {
    contributions.push({
      signalId: 'S7_funding',
      label: `Raised ${input.recentFundingRound} recently`,
      points: 15,
    });
  }

  // Signal 8: Exec change
  if (input.recentExecChange) {
    const recencyPoints = input.recentExecChange === 'this_week' ? 15
      : input.recentExecChange === 'this_month' ? 12
      : 8;
    contributions.push({
      signalId: 'S8_exec',
      label: `New executive (${input.recentExecChange.replace('_', ' ')})`,
      points: recencyPoints,
    });
  }

  // Signal 9: New domain
  if (input.newDomainMatch) {
    contributions.push({
      signalId: 'S9_newdomain',
      label: 'Newly-registered domain (<30d)',
      points: 10,
    });
  }

  // Aggregate + rank
  contributions.sort((a, b) => b.points - a.points);
  const rawTotal = contributions.reduce((sum, c) => sum + c.points, 0);
  const score = Math.min(100, rawTotal);
  const headline = contributions[0]?.label || 'No buying-intent signals detected';

  return {
    company: input.company,
    domain: input.domain,
    score,
    tier: tierFor(score),
    contributions,
    headline,
  };
}

/**
 * Helper to build the scoring input from raw signal module outputs.
 * Pass in whatever you've fetched; missing fields don't penalize.
 */
export function buildScoringInput(sources: {
  company?: string;
  domain?: string;
  techStack?: Array<{ name: string; category: string }>;
  jobPostingIcpMatches?: Array<unknown>;
  techStackDiff?: { added: Array<{ name: string; category: string }>; removed: Array<{ name: string; category: string }>; competitorChangeDetected: boolean };
  negativeReviews?: Array<{ hasSwitchingIntent: boolean }>;
  socialSignals?: Array<unknown>;
  fundingAnnouncement?: { round?: string; publishedAt?: string };
  execChanges?: Array<{ recencyTier: 'this_week' | 'this_month' | 'this_quarter' | 'older' }>;
  newDomain?: boolean;
}): ProspectScoringInput {
  const competitors = (sources.techStack || [])
    .filter(t => t.category === 'crm' || t.category === 'helpdesk')
    .map(t => t.name);

  const icpJobCount = sources.jobPostingIcpMatches?.length;

  const techStackChanged = sources.techStackDiff ? {
    added: sources.techStackDiff.added.map(t => t.name),
    removed: sources.techStackDiff.removed.map(t => t.name),
    competitorChange: sources.techStackDiff.competitorChangeDetected,
  } : undefined;

  const negativeReviewSwitchIntent = (sources.negativeReviews || []).filter(r => r.hasSwitchingIntent).length;

  const socialBuyingSignals = sources.socialSignals?.length;

  // Funding is meaningful only if fresh (<90 days)
  let recentFundingRound: string | undefined;
  if (sources.fundingAnnouncement?.round && sources.fundingAnnouncement.publishedAt) {
    const publishedMs = Date.parse(sources.fundingAnnouncement.publishedAt);
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    if (publishedMs >= ninetyDaysAgo) recentFundingRound = sources.fundingAnnouncement.round;
  }

  const mostRecentExecChange = (sources.execChanges || [])
    .map(e => e.recencyTier)
    .filter((t): t is 'this_week' | 'this_month' | 'this_quarter' => t !== 'older')
    .sort((a, b) => {
      const order = { this_week: 0, this_month: 1, this_quarter: 2 } as const;
      return order[a] - order[b];
    })[0];

  return {
    company: sources.company,
    domain: sources.domain,
    competitors: competitors.length > 0 ? competitors : undefined,
    icpJobCount,
    techStackChanged,
    negativeReviewSwitchIntent: negativeReviewSwitchIntent > 0 ? negativeReviewSwitchIntent : undefined,
    socialBuyingSignals,
    recentFundingRound,
    recentExecChange: mostRecentExecChange,
    newDomainMatch: sources.newDomain,
  };
}
