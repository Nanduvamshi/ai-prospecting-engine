import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { exportUserData } from '@/server/network/contact-graph-db';
import { isContactGraphEnabled } from '@/server/network/config';

export const dynamic = 'force-dynamic';

// GET /api/contact-graph/export
// GDPR Article 15 — right of access. Returns everything the calling user
// has contributed to the graph, plus the merged contact records that
// resulted from their contributions.
export async function GET(request: NextRequest) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isContactGraphEnabled()) {
    return NextResponse.json({ error: 'Contact graph feature not enabled' }, { status: 503 });
  }

  try {
    const data = await exportUserData(user.orgId, user.sub);
    return NextResponse.json({
      exportedAt: new Date().toISOString(),
      userId: user.sub,
      orgId: user.orgId,
      ...data,
    });
  } catch {
    return NextResponse.json({ error: 'Export failed' }, { status: 500 });
  }
}
