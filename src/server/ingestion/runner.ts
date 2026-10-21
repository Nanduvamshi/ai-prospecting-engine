/**
 * Public-data ingestion runner.
 *
 * One entry point that runs every configured adapter and aggregates
 * stats. Scheduled from the `/api/cron/public-data-sync` endpoint
 * (daily). Adapters that aren't configured self-skip via isConfigured()
 * so the runner doesn't fail on missing credentials.
 *
 * Adapters run sequentially today — cron has plenty of budget and we
 * don't want multiple adapters fighting over network / rate limits on
 * the same hosts. Parallelize later if runtime becomes a concern.
 */

import type { PublicDataAdapter, IngestStats } from './types';
import { secOfficerAdapter } from './sources/sec-officers';
import { githubCommitsAdapter } from './sources/github-commits';
import { crunchbaseAdapter } from './sources/crunchbase';
import { jobPostingsAdapter } from './sources/job-postings';

const adapters: PublicDataAdapter[] = [
  secOfficerAdapter,
  githubCommitsAdapter,
  crunchbaseAdapter,
  jobPostingsAdapter,
];

export interface RunnerResult {
  ranAt: string;
  durationMs: number;
  stats: IngestStats[];
  skipped: Array<{ source: string; reason: 'not_configured' }>;
}

export async function runAllPublicDataAdapters(opts: { sinceDays?: number } = {}): Promise<RunnerResult> {
  const started = Date.now();
  const stats: IngestStats[] = [];
  const skipped: RunnerResult['skipped'] = [];

  for (const adapter of adapters) {
    if (!adapter.isConfigured()) {
      skipped.push({ source: adapter.source, reason: 'not_configured' });
      continue;
    }
    try {
      const s = await adapter.run(opts);
      stats.push(s);
      console.log(`[data-ingestion] ${s.source}: fetched=${s.fetched} extracted=${s.extracted} saved=${s.saved} failed=${s.failed}${s.note ? ` (${s.note})` : ''}`);
    } catch (err) {
      console.error(`[data-ingestion] ${adapter.source} crashed:`, err instanceof Error ? err.message : String(err));
      stats.push({
        source: adapter.source,
        fetched: 0, extracted: 0, saved: 0, failed: 1,
        note: err instanceof Error ? err.message.slice(0, 200) : 'crash',
      });
    }
  }

  return {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    stats,
    skipped,
  };
}
