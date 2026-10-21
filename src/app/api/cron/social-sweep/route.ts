import { NextRequest, NextResponse } from 'next/server';
import { assertCronAuthorized } from '@/server/cron-auth';
import { runBuyingIntentSweep } from '@/server/discovery/social-listening';
import { persistSweepItems } from '@/server/discovery/sweep-sink';

export const dynamic = 'force-dynamic';

// POST /api/cron/social-sweep
// Scheduled: every 4 hours.
// Runs the default buying-intent query set against Reddit + HN Algolia.
// Persisted to sweep sink (14-day TTL).
export async function POST(request: NextRequest) {
  const reject = assertCronAuthorized(request);
  if (reject) return reject;

  try {
    const signals = await runBuyingIntentSweep();
    const persist = await persistSweepItems('social', signals);
    console.log(`[cron/social-sweep] fetched=${signals.length} written=${persist.written}`);
    return NextResponse.json({ count: signals.length, persisted: persist.written });
  } catch (err) {
    console.error('[cron/social-sweep] failed:', err);
    return NextResponse.json({ error: 'social sweep failed' }, { status: 500 });
  }
}
