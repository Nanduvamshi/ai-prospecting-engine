import { NextRequest, NextResponse } from 'next/server';
import { assertCronAuthorized } from '@/server/cron-auth';
import { runNegativeReviewSweep } from '@/server/discovery/review-signals';
import { persistSweepItems } from '@/server/discovery/sweep-sink';

export const dynamic = 'force-dynamic';

// POST /api/cron/review-sweep
// Scheduled: daily.
// Sweeps G2 + Capterra for 1-2★ reviews of competitors with switching intent.
// Persisted to sweep sink (14-day TTL).
export async function POST(request: NextRequest) {
  const reject = assertCronAuthorized(request);
  if (reject) return reject;

  try {
    const reviews = await runNegativeReviewSweep();
    const persist = await persistSweepItems('review', reviews);
    console.log(`[cron/review-sweep] fetched=${reviews.length} written=${persist.written}`);
    return NextResponse.json({ count: reviews.length, persisted: persist.written });
  } catch (err) {
    console.error('[cron/review-sweep] failed:', err);
    return NextResponse.json({ error: 'review sweep failed' }, { status: 500 });
  }
}
