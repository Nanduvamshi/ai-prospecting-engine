import { NextRequest, NextResponse } from 'next/server';
import { assertCronAuthorized } from '@/server/cron-auth';
import { runAllPublicDataAdapters } from '@/server/ingestion/runner';

export const dynamic = 'force-dynamic';

/**
 * POST /api/cron/public-data-sync
 *
 * Track C Phase C2 — pulls from every configured public-data adapter
 * (SEC EDGAR today; GitHub / Crunchbase / job-boards stubbed) and
 * upserts records into the public-role registry.
 *
 * Schedule: daily at 06:00 UTC (wired in ProspectingCronStack as a
 * follow-up). Can also be triggered manually for testing.
 */
export async function POST(request: NextRequest) {
  const reject = assertCronAuthorized(request);
  if (reject) return reject;

  try {
    const result = await runAllPublicDataAdapters({ sinceDays: 7 });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[cron/public-data-sync] failed:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'public-data sync failed' }, { status: 500 });
  }
}
