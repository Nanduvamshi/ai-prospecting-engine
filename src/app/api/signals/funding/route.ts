import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { fetchRecentFundingAnnouncements, fetchRecentIpoFilings, fetchRecentMaterialEvents } from '@/server/discovery/funding-signals';

export const dynamic = 'force-dynamic';

// GET /api/crm/signals/funding?type=rss|s1|8k&days=7
// Returns recent funding announcements / filings from public sources.
export async function GET(request: NextRequest) {
  const { error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);

  try {
    const type = request.nextUrl.searchParams.get('type') || 'rss';
    const daysRaw = request.nextUrl.searchParams.get('days');
    const days = daysRaw ? Math.max(1, Math.min(90, parseInt(daysRaw, 10) || 7)) : 7;

    if (type === 's1') {
      const filings = await fetchRecentIpoFilings(days);
      return NextResponse.json({ filings });
    }
    if (type === '8k') {
      const filings = await fetchRecentMaterialEvents(days);
      return NextResponse.json({ filings });
    }
    const announcements = await fetchRecentFundingAnnouncements({ sinceDays: days });
    return NextResponse.json({ announcements });
  } catch {
    return NextResponse.json({ error: 'Funding signal fetch failed' }, { status: 500 });
  }
}
