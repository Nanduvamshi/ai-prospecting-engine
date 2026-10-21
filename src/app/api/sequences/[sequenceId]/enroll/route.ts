import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { getSequence, bumpSequenceCounter } from '@/server/outreach/sequences/sequence-store';
import { createEnrollment } from '@/server/outreach/sequences/enrollment-store';

export const dynamic = 'force-dynamic';

// POST /api/crm/sequences/[sequenceId]/enroll
// Body: { prospects: Array<{ email, name?, company? }> }
// Idempotency: caller dedupes — the API doesn't auto-dedupe across re-enrolls.
export async function POST(request: NextRequest, ctx: { params: Promise<{ sequenceId: string }> }) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { sequenceId } = await ctx.params;

  const seq = await getSequence(user.orgId, sequenceId);
  if (!seq) return NextResponse.json({ error: 'Sequence not found' }, { status: 404 });

  try {
    const body = await request.json();
    const prospects: Array<{ email: string; name?: string; company?: string }> = body?.prospects || [];
    if (!Array.isArray(prospects) || prospects.length === 0) {
      return NextResponse.json({ error: 'prospects array required' }, { status: 400 });
    }
    if (prospects.length > 100) {
      return NextResponse.json({ error: 'Max 100 prospects per enroll call' }, { status: 400 });
    }

    const created = [];
    for (const p of prospects) {
      if (!p.email || typeof p.email !== 'string') continue;
      const enrollment = await createEnrollment({
        orgId: user.orgId,
        sequenceId,
        prospectEmail: p.email,
        prospectName: p.name,
        prospectCompany: p.company,
        enrolledBy: user.sub,
      });
      created.push(enrollment);
    }
    if (created.length > 0) {
      await bumpSequenceCounter(user.orgId, sequenceId, 'enrolledCount', created.length);
    }
    return NextResponse.json({ enrolledCount: created.length, enrollments: created });
  } catch {
    return NextResponse.json({ error: 'Enroll failed' }, { status: 500 });
  }
}
