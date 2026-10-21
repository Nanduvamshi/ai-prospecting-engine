/**
 * Crunchbase free-tier ingestion (Track C Phase C2).
 *
 * STUB: not yet implemented. Once built, this adapter will pull the
 * weekly Crunchbase open dataset (company size, industry, funding
 * rounds) and upsert org-metadata records that the enrichment flow can
 * use to fill in company facts without an Apollo call.
 *
 * Implementation notes for whoever picks this up:
 *  - Crunchbase free CSV export requires a no-cost developer account +
 *    API key set as CRUNCHBASE_API_KEY env var
 *  - Weekly refresh is plenty; data doesn't churn daily
 *  - Store records with a distinct SK prefix (e.g. ORG_META#) so they
 *    don't collide with person-keyed PUBLIC_ROLE records
 *  - Add a `lookupOrgMetadata(companyName)` helper on the store and
 *    wire it into the enrich route's Phase 2 (web+AI) section as a
 *    cheaper-first alternative to Claude-summarising company pages
 */

import type { PublicDataAdapter, IngestStats } from '../types';

export const crunchbaseAdapter: PublicDataAdapter = {
  source: 'crunchbase',

  isConfigured(): boolean {
    return Boolean(process.env.CRUNCHBASE_API_KEY);
  },

  async run(): Promise<IngestStats> {
    return {
      source: 'crunchbase',
      fetched: 0,
      extracted: 0,
      saved: 0,
      failed: 0,
      note: 'stub — CRUNCHBASE_API_KEY not configured',
    };
  },
};
