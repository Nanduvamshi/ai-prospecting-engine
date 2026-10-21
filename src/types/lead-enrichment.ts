/**
 * Shared types for lead enrichment, intent signals, and company data.
 * Used across find-leads route, enrichment route, and frontend components.
 */

// ─── Seniority & Department Classification ───

export type SeniorityLevel =
  | 'C-level'
  | 'VP'
  | 'Director'
  | 'Manager'
  | 'Senior IC'
  | 'IC'
  | 'Unknown';

export type Department =
  | 'Engineering'
  | 'Sales'
  | 'Marketing'
  | 'Product'
  | 'Finance'
  | 'HR'
  | 'Operations'
  | 'Other';

// ─── Company Enrichment ───

export interface CompanyEnrichment {
  domain?: string;
  /** e.g., '1-10', '11-50', '51-200', '201-500', '501-1000', '1000+' */
  size?: string;
  industry?: string;
  /** e.g., '$1M-$10M', '$10M-$50M', '$50M+' */
  revenue?: string;
  /** e.g., 'Seed', 'Series A', 'Series B', 'Series C+', 'Public', 'Bootstrapped' */
  funding?: string;
  fundingAmount?: string;
  techStack?: string[];
  headcount?: number;
  foundedYear?: number;
  description?: string;
}

// ─── Intent Signals ───

export interface FundingSignal {
  amount?: string;
  round?: string;
  date?: string;
  source?: string;
}

export interface IntentSignals {
  isHiring: boolean;
  hiringDepartments?: string[];
  recentFunding?: FundingSignal;
  techStack?: string[];
  /** CRM/helpdesk competitors detected on the prospect's website — qualified switching targets */
  competitors?: string[];
  growthSignals?: string[];
  /** Composite intent score 0-100 */
  intentScore: number;
}

// ─── Enriched Lead (extends base extracted lead) ───

export interface EnrichedLeadData {
  companyDomain?: string;
  seniority?: SeniorityLevel;
  department?: Department;
  confidence?: 'high' | 'medium' | 'low';
  emailVerified?: boolean;
  companyEnrichment?: CompanyEnrichment;
  intentSignals?: IntentSignals;
}
