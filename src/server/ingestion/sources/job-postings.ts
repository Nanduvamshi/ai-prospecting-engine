/**
 * Public job postings ingestion (Track C Phase C2).
 *
 * STUB: not yet implemented. Once built, this adapter will poll ATSs
 * (Greenhouse, Lever, SmartRecruiters) for target companies' public
 * careers pages and extract:
 *  - Hiring-manager names (when the posting includes them)
 *  - Team-composition signals (roles currently being backfilled)
 *  - Growth signals (rate of new postings)
 *
 * Implementation notes:
 *  - Greenhouse: GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs
 *    — public, no auth, returns JSON incl. departments + offices
 *  - Lever: GET https://api.lever.co/v0/postings/{company}
 *  - SmartRecruiters: GET https://api.smartrecruiters.com/v1/companies/{id}/postings
 *  - Hiring-manager names usually appear in the posting `content` field
 *    as free text — needs LLM extraction, same pattern as SEC-officers
 *
 * Until built, the adapter self-skips so the runner keeps moving.
 */

import type { PublicDataAdapter, IngestStats } from '../types';

export const jobPostingsAdapter: PublicDataAdapter = {
  source: 'job-postings',

  isConfigured(): boolean {
    // Gated on an explicit opt-in env var rather than a credential,
    // because the adapter doesn't need auth but does want deliberate
    // enablement (so we don't start polling ATSs the moment the code
    // is deployed).
    return process.env.JOB_POSTINGS_INGESTION === 'true';
  },

  async run(): Promise<IngestStats> {
    return {
      source: 'job-postings',
      fetched: 0,
      extracted: 0,
      saved: 0,
      failed: 0,
      note: 'stub — JOB_POSTINGS_INGESTION not set to true',
    };
  },
};
