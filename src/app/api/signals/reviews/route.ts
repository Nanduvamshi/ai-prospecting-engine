import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { scrapeCompetitorReviews, runNegativeReviewSweep, COMPETITOR_SLUGS } from '@/server/discovery/review-signals';

export const dynamic = 'force-dynamic';

// POST /api/crm/signals/reviews
// Body options:
//   { competitor: "HubSpot", site?: "g2" | "capterra" | "trustradius" }  → single scrape
//   { sweep: true }                                                      → sweep all competitors (slow)
export async function POST(request: NextRequest) {
  const { error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);

  try {
    const body = await request.json();

    if (body?.sweep === true) {
      const reviews = await runNegativeReviewSweep();
      return NextResponse.json({ reviews });
    }

    const competitor: string = body?.competitor;
    const site: 'g2' | 'capterra' | 'trustradius' = body?.site || 'g2';
    if (!competitor || typeof competitor !== 'string') {
      return NextResponse.json({ error: 'competitor required', supported: Object.keys(COMPETITOR_SLUGS) }, { status: 400 });
    }
    const result = await scrapeCompetitorReviews(competitor, site);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Review scan failed' }, { status: 500 });
  }
}
