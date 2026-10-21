import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { listEnrollmentsForSequence } from '@/server/outreach/sequences/enrollment-store';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, ctx: { params: Promise<{ sequenceId: string }> }) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { sequenceId } = await ctx.params;
  const enrollments = await listEnrollmentsForSequence(user.orgId, sequenceId);
  return NextResponse.json({ enrollments });
}
