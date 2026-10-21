/**
 * Find-leads job types.
 *
 * Split out of the old store file so the Drizzle schema can import the exact
 * same interfaces it persists, without pulling a database client into the
 * schema module.
 */

export type FindLeadsJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Stable enum of user-safe error codes the UI can translate to copy. */
export type FindLeadsErrorCode =
  | 'ai_unavailable'
  | 'search_unavailable'
  | 'rate_limited'
  | 'no_results'
  | 'internal';

/** Mirrors the ExtractedLead shape the UI already consumes. */
export interface PartialLead {
  name: string;
  title: string;
  company: string;
  companyDomain?: string;
  linkedinUrl?: string;
  website?: string;
  email?: string;
  phone?: string;
  twitterUrl?: string;
  githubUrl?: string;
  facebookUrl?: string;
  avatar?: string;
  location?: string;
  seniority?: string;
  department?: string;
  score: number;
  confidence?: string;
  source: string;
  companyEnrichment?: Record<string, unknown>;
  intentSignals?: Record<string, unknown>;
  emailVerified?: boolean;
}

export interface FindLeadsJobRequest {
  mode: 'filters' | 'ai';
  searchDepth?: 'quick' | 'deep';
  sources?: string[];
  jobTitles?: string;
  industries?: string[];
  locations?: string;
  prompt?: string;
  offset?: number;
  excludeUrls?: string[];
  excludeNames?: string[];
}

export interface FindLeadsJob {
  jobId: string;
  orgId: string;
  userId: string;
  /** Auth token captured at job creation so the background runner can
   * consume credits once the pipeline finishes. Never returned to clients. */
  authToken?: string;
  status: FindLeadsJobStatus;
  /** 1..8 — updated by the runner before starting each phase. */
  phase: number;
  /** User-safe label shown in the UI. */
  phaseLabel: string;
  /** 0..100 rough progress indicator. */
  percentComplete: number;
  /** Leads discovered so far. Appended after Claude extraction and mutated
   * in place when enrichment phases complete. Capped to the credit budget
   * before the final status flips to 'completed'. */
  partialLeads: PartialLead[];
  /** Search queries that have actually been executed — drives the "looking
   * for X…" ticker while phase 2 is active. */
  searchesRun: string[];
  summary?: string;
  /** Echoed back to the client so the UI can show "Quick/Deep" etc. */
  request: FindLeadsJobRequest;
  estimatedSeconds: number;
  /** Metadata the existing UI already consumes (hasMore, creditCost, …). */
  metadata?: Record<string, unknown>;
  errorCode?: FindLeadsErrorCode;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
