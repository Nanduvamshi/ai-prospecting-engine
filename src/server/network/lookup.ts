/**
 * Contact Graph — lookup by identity + query surface for the enrich flow.
 *
 * Queries the graph for a matching contact record and returns a shaped result
 * suitable for the Phase 0 prospect-enrichment pipeline to consume as a
 * pre-Apollo fallback.
 *
 * Gating rules:
 *   - Feature flag must be ON (isContactGraphEnabled).
 *   - Caller org MUST itself be a participating contributor to the graph
 *     before the graph will return results. This preserves the "contribute
 *     to access" fairness model and keeps the product out of "selling contact data
 *     we collected from others" territory.
 */

import { getContactByEmail, countContributors, callerContributed as didCallerContribute, liveConfidence, getOrgParticipation } from './contact-graph-db';
import { isContactGraphEnabled, CONFIDENCE_HIDE_THRESHOLD } from './config';
import type { ContactLookupResult } from './types';

export interface LookupOptions {
  email?: string;
  callerOrgId: string;
  /** If true, bypass the "caller must be a contributor" check. For internal
   * support tools only — never expose this to end-user-facing endpoints. */
  bypassContributionCheck?: boolean;
}

export async function lookupContact(opts: LookupOptions): Promise<ContactLookupResult> {
  if (!isContactGraphEnabled()) {
    return { found: false };
  }
  if (!opts.email) {
    return { found: false };
  }

  // Fairness gate: caller's org must be a participating contributor
  if (!opts.bypassContributionCheck) {
    const participation = await getOrgParticipation(opts.callerOrgId);
    if (!participation.optedIn) {
      return { found: false };
    }
  }

  const record = await getContactByEmail(opts.email);
  if (!record) return { found: false };

  const contributorCount = await countContributors(record.contactHash);
  const confidence = liveConfidence(record, contributorCount);
  if (confidence < CONFIDENCE_HIDE_THRESHOLD) return { found: false };

  const callerContributed = await didCallerContribute(record.contactHash, opts.callerOrgId);

  return {
    found: true,
    contact: {
      email: record.email,
      name: record.name,
      title: record.title,
      company: record.company,
      companyDomain: record.companyDomain,
      phone: record.phone,
      linkedinUrl: record.linkedinUrl,
      confidenceScore: confidence,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      lastVerifiedAt: record.lastVerifiedAt,
      sightingCount: record.sightingCount,
    },
    contributorCount,
    callerContributed,
  };
}
