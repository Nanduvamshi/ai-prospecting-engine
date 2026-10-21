/**
 * GitHub commits adapter — Track C Phase C2.
 *
 * STUB: intentionally not wired. The original plan called for pulling
 * public committer emails from the GitHub Archive to seed the contact
 * graph with dev-role contacts. We scoped it out (for now) because:
 *
 *   - Official path (BigQuery) requires a GCP project + service
 *     account + billing — operational overhead we don't want today.
 *   - Direct GitHub REST/search API is rate-limited too aggressively
 *     to bulk-fetch what we'd need.
 *   - Self-hosted gharchive-on-S3 works but is a pipeline project on
 *     its own.
 *
 * When / if this becomes worthwhile, the cleanest revival is the
 * ClickHouse public mirror at play.clickhouse.com (no auth, same
 * dataset as gharchive, free within rate limits). The adapter shape
 * below is ready for that swap — only `isConfigured()` and `run()`
 * change; everything downstream (contact-graph upsert, domain filter)
 * stays the same.
 *
 * Until then this adapter self-skips so the public-data runner keeps
 * moving without it.
 */

import type { PublicDataAdapter, IngestStats } from '../types';

export const githubCommitsAdapter: PublicDataAdapter = {
  source: 'github',

  isConfigured(): boolean {
    return false; // deliberately off — see file header
  },

  async run(): Promise<IngestStats> {
    return {
      source: 'github',
      fetched: 0,
      extracted: 0,
      saved: 0,
      failed: 0,
      note: 'stub — GitHub adapter deferred (see src/lib/data-ingestion/sources/github-commits.ts header)',
    };
  },
};
