import { NextRequest, NextResponse } from 'next/server';
import { assertCronAuthorized } from '@/server/cron-auth';
import { runDomainKeywordSweep } from '@/server/discovery/domain-monitor';
import { persistSweepItems } from '@/server/discovery/sweep-sink';

export const dynamic = 'force-dynamic';

// POST /api/cron/domain-sweep
// Scheduled: daily.
// Queries crt.sh for newly-certified domains matching ICP keywords.
// Persisted to sweep sink (14-day TTL).
export async function POST(request: NextRequest) {
  const reject = assertCronAuthorized(request);
  if (reject) return reject;

  try {
    const matches = await runDomainKeywordSweep(undefined, { sinceDays: 3 });
    const persist = await persistSweepItems('domain', matches);
    console.log(`[cron/domain-sweep] fetched=${matches.length} written=${persist.written}`);
    return NextResponse.json({ count: matches.length, persisted: persist.written });
  } catch (err) {
    console.error('[cron/domain-sweep] failed:', err);
    return NextResponse.json({ error: 'domain sweep failed' }, { status: 500 });
  }
}
