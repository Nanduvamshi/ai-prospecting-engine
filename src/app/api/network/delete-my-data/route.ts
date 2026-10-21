import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { deleteAllForUser } from '@/server/network/contact-graph-db';
import { isContactGraphEnabled } from '@/server/network/config';

export const dynamic = 'force-dynamic';

// POST /api/contact-graph/delete-my-data
// GDPR Article 17 — right to erasure.
// Cascade-deletes every contribution record the calling user has ever created.
// Potentially long-running (scans the graph), but these requests are rare.
export async function POST(request: NextRequest) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isContactGraphEnabled()) {
    return NextResponse.json({ error: 'Contact graph feature not enabled' }, { status: 503 });
  }

  try {
    const deletedCount = await deleteAllForUser(user.orgId, user.sub);
    return NextResponse.json({
      deletedCount,
      message: `Deleted ${deletedCount} of your contribution records from the contact graph.`,
    });
  } catch (err) {
    console.error('[contact-graph/delete-my-data] failed:', err);
    return NextResponse.json({ error: 'Deletion failed' }, { status: 500 });
  }
}
