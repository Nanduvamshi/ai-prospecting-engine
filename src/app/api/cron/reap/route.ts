import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { assertCronAuthorized } from '@/server/cron-auth';
import { deleteExpiredJobs, reapStalledJobs } from '@/server/pipeline/jobs';
import { deleteExpiredSweepItems } from '@/server/discovery/sweep-sink';
import { deleteExpiredVerifications } from '@/server/discovery/verification-cache-store';
import { deleteExpiredPublicRoles } from '@/server/ingestion/public-role-store';
import { reapStalledImports } from '@/server/prospects/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/cron/reap — expiry sweep and stalled-work recovery.
 *
 * Two problems need solving here.
 *
 * Postgres has no built-in row TTL, so every table carrying an `expires_at`
 * needs something to delete from it. Each
 * delete is bounded so a long-neglected table cannot produce a single enormous
 * transaction.
 *
 * More importantly, a pipeline run is an unawaited promise living inside a
 * request handler. If the instance is recycled mid-run — a deploy, a scale-in —
 * nothing ever writes a terminal state, and the job sits at "running" forever
 * while the browser polls it. Marking those jobs failed is what closes that
 * gap, and because credits are only
 * charged on success, a reaped run costs the user nothing.
 */
export async function POST(request: NextRequest) {
  const denied = assertCronAuthorized(request);
  if (denied) return denied;

  const started = Date.now();

  // Settled rather than all: one failing table should not stop the others
  // from being swept.
  const [
    stalledJobs,
    stalledImports,
    expiredJobs,
    expiredSweeps,
    expiredVerifications,
    expiredRoles,
  ] = await Promise.allSettled([
    reapStalledJobs(5),
    reapStalledImports(30),
    deleteExpiredJobs(),
    deleteExpiredSweepItems(),
    deleteExpiredVerifications(),
    deleteExpiredPublicRoles(),
  ]);

  const value = (r: PromiseSettledResult<number>, label: string): number => {
    if (r.status === 'fulfilled') return r.value;
    console.error(`[cron/reap] ${label} failed:`, r.reason);
    return -1;
  };

  const result = {
    recovered: {
      stalledJobs: value(stalledJobs, 'stalledJobs'),
      stalledImports: value(stalledImports, 'stalledImports'),
    },
    deleted: {
      expiredJobs: value(expiredJobs, 'expiredJobs'),
      expiredSweepItems: value(expiredSweeps, 'expiredSweepItems'),
      expiredVerifications: value(expiredVerifications, 'expiredVerifications'),
      expiredPublicRoles: value(expiredRoles, 'expiredPublicRoles'),
    },
    durationMs: Date.now() - started,
  };

  console.log('[cron/reap]', JSON.stringify(result));
  return NextResponse.json({ success: true, ...result });
}
