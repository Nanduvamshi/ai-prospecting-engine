/**
 * Public-data ingestion — Track C Phase C2.
 *
 * Shared types for adapters that pull from free/public sources (SEC,
 * GitHub, Crunchbase, job boards) and write into the public-role
 * registry. Not to be confused with the Phase 3 contact-graph, which is
 * email-keyed + user-contributed. The public-role registry is
 * company+role keyed and supplements enrichment when an email isn't
 * available but we know a real person holds the target title.
 */

export type PublicSource = 'sec-edgar' | 'github' | 'crunchbase' | 'job-postings';

export interface PublicContactRecord {
  /** Company name as it appears in the source (post-normalization) */
  company: string;
  /** Person's name, or null for org-only records */
  name: string | null;
  /** Normalized title (e.g. "Chief Executive Officer", "VP Engineering") */
  title: string | null;
  /** Where we got this — drives confidence weighting in enrichment */
  source: PublicSource;
  /** URL linking back to the source filing / commit / post */
  sourceUrl: string;
  /** Source-specific sub-type (filing form, commit hash, etc.) for debugging */
  sourceKind?: string;
  /** ISO timestamp when we first saw this record */
  foundAt: string;
  /** Confidence 0-1. LLM-extracted = 0.5, regex-extracted = 0.3, manual = 0.9 */
  confidence: number;
}

export interface IngestStats {
  source: PublicSource;
  fetched: number;
  extracted: number;
  saved: number;
  failed: number;
  /** Adapter-specific notes surfaced in the cron response */
  note?: string;
}

export interface PublicDataAdapter {
  source: PublicSource;
  /** Pull + extract + persist. Returns stats for the runner to aggregate. */
  run(opts?: { sinceDays?: number }): Promise<IngestStats>;
  /** True when required env (API keys, etc.) is present. Adapters skip themselves when false. */
  isConfigured(): boolean;
}
