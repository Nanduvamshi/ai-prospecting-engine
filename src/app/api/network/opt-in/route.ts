import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { getOrgParticipation, setOrgParticipation } from '@/server/network/contact-graph-db';
import { isContactGraphEnabled } from '@/server/network/config';

export const dynamic = 'force-dynamic';

// GET /api/contact-graph/opt-in — current org participation state
export async function GET(request: NextRequest) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isContactGraphEnabled()) {
    return NextResponse.json({ enabled: false, participation: null });
  }
  const participation = await getOrgParticipation(user.orgId);
  return NextResponse.json({ enabled: true, participation });
}

// POST /api/contact-graph/opt-in — body: { optedIn: boolean }
// Only org super_admin or manager can toggle.
export async function POST(request: NextRequest) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'super_admin' && user.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden — only admins can toggle this' }, { status: 403 });
  }
  if (!isContactGraphEnabled()) {
    return NextResponse.json({ error: 'Contact graph feature not enabled' }, { status: 503 });
  }

  try {
    const body = await request.json();
    if (typeof body?.optedIn !== 'boolean') {
      return NextResponse.json({ error: 'optedIn (boolean) required' }, { status: 400 });
    }
    await setOrgParticipation({
      orgId: user.orgId,
      optedIn: body.optedIn,
      actorUserId: user.sub,
    });
    const participation = await getOrgParticipation(user.orgId);
    return NextResponse.json({ participation });
  } catch {
    return NextResponse.json({ error: 'Opt-in update failed' }, { status: 500 });
  }
}
