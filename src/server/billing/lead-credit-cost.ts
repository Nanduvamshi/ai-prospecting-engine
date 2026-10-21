import type { SearchDepth } from '@/server/discovery/search-config';

export const LEAD_CREDIT_COST = {
  BASIC: 1,           // LinkedIn only (no email/phone)
  ENRICHED: 2,        // Has email and/or phone (Quick search)
  DEEP_ENRICHED: 3,   // Has email and/or phone (Deep search)
  DEEP_FULL: 5,       // Deep search + company enrichment/intent signals
} as const;

interface LeadWithContact {
  email?: string;
  phone?: string;
  score?: number;
  companyEnrichment?: Record<string, any>;
  intentSignals?: Record<string, any>;
  [key: string]: any;
}

export function calculateLeadCost(lead: LeadWithContact, searchDepth?: SearchDepth): number {
  const hasContact = Boolean(lead.email || lead.phone);
  const hasEnrichment = Boolean(
    (lead.companyEnrichment && Object.keys(lead.companyEnrichment).length > 0) ||
    (lead.intentSignals && Object.keys(lead.intentSignals).length > 0)
  );

  if (searchDepth === 'deep' && hasContact && hasEnrichment) {
    return LEAD_CREDIT_COST.DEEP_FULL;
  }
  if (!hasContact) return LEAD_CREDIT_COST.BASIC;
  return searchDepth === 'deep' ? LEAD_CREDIT_COST.DEEP_ENRICHED : LEAD_CREDIT_COST.ENRICHED;
}

export function calculateTotalLeadsCost(leads: LeadWithContact[], searchDepth?: SearchDepth): number {
  return leads.reduce((sum, lead) => sum + calculateLeadCost(lead, searchDepth), 0);
}

/**
 * Truncate leads to fit within a credit budget.
 * Leads are processed in order (assumed already sorted by score desc).
 * Returns as many leads as the budget allows.
 */
export function truncateLeadsToBudget<T extends LeadWithContact>(
  leads: T[],
  budget: number,
  searchDepth?: SearchDepth,
): { leads: T[]; cost: number; truncated: boolean; originalCount: number } {
  const result: T[] = [];
  let cost = 0;

  for (const lead of leads) {
    const leadCost = calculateLeadCost(lead, searchDepth);
    if (cost + leadCost > budget) break;
    result.push(lead);
    cost += leadCost;
  }

  return {
    leads: result,
    cost,
    truncated: result.length < leads.length,
    originalCount: leads.length,
  };
}
