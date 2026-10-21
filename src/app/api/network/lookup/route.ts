import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { lookupContact } from '@/server/network/lookup';
import { isContactGraphEnabled } from '@/server/network/config';

export const dynamic = 'force-dynamic';

// GET /api/contact-graph/lookup?email=<email>
// Returns the graph's record for a contact, IF:
//   - Feature flag is on
//   - Caller's org is an opted-in contributor
//   - A record exists with confidence >= threshold
export async function GET(request: NextRequest) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!isContactGraphEnabled()) {
    return NextResponse.json({ found: false, reason: 'feature_disabled' });
  }

  const email = request.nextUrl.searchParams.get('email');
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }

  try {
    const result = await lookupContact({ email, callerOrgId: user.orgId });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }
}
