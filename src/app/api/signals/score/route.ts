import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { scoreProspect, buildScoringInput } from '@/server/discovery/intent-scoring';

export const dynamic = 'force-dynamic';

// POST /api/crm/signals/score
// Body: pre-fetched signal data. Accepts the raw shape from buildScoringInput
// OR the flattened scoreProspect input directly.
// Returns composite 0-100 score + contribution breakdown.
export async function POST(request: NextRequest) {
  const { error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);

  try {
    const body = await request.json();

    // If the body looks like raw signal outputs, build the scoring input first.
    if (body?.techStack || body?.jobPostingIcpMatches || body?.techStackDiff
      || body?.negativeReviews || body?.socialSignals || body?.visitorEvents
      || body?.fundingAnnouncement || body?.execChanges || body?.newDomain) {
      const input = buildScoringInput(body);
      const score = scoreProspect(input);
      return NextResponse.json(score);
    }

    // Otherwise assume caller already shaped the input
    const score = scoreProspect(body || {});
    return NextResponse.json(score);
  } catch {
    return NextResponse.json({ error: 'Scoring failed' }, { status: 500 });
  }
}
