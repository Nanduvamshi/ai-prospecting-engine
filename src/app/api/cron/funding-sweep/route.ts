import { NextRequest, NextResponse } from 'next/server';
import { assertCronAuthorized } from '@/server/cron-auth';
import { fetchRecentFundingAnnouncements } from '@/server/discovery/funding-signals';
import { persistSweepItems } from '@/server/discovery/sweep-sink';

export const dynamic = 'force-dynamic';

// POST /api/cron/funding-sweep
// Scheduled: hourly.
// Polls TechCrunch/VentureBeat RSS for recent funding announcements.
// Persists each announcement to the sweep sink (14-day TTL) so the CRM
// and workflow engine can query them via /api/crm/signals/recent?type=funding.
export async function POST(request: NextRequest) {
  const reject = assertCronAuthorized(request);
  if (reject) return reject;

  try {
    const announcements = await fetchRecentFundingAnnouncements({ sinceDays: 2 });
    const persist = await persistSweepItems('funding', announcements);
    console.log(`[cron/funding-sweep] fetched=${announcements.length} written=${persist.written} failed=${persist.failed}`);
    return NextResponse.json({ count: announcements.length, persisted: persist.written });
  } catch (err) {
    console.error('[cron/funding-sweep] failed:', err);
    return NextResponse.json({ error: 'funding sweep failed' }, { status: 500 });
  }
}
