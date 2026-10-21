import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { getSequence, updateSequence, deleteSequence } from '@/server/outreach/sequences/sequence-store';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, ctx: { params: Promise<{ sequenceId: string }> }) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { sequenceId } = await ctx.params;
  const seq = await getSequence(user.orgId, sequenceId);
  if (!seq) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ sequence: seq });
}

export async function PUT(request: NextRequest, ctx: { params: Promise<{ sequenceId: string }> }) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { sequenceId } = await ctx.params;
  try {
    const body = await request.json();
    const updated = await updateSequence(user.orgId, sequenceId, body);
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ sequence: updated });
  } catch {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ sequenceId: string }> }) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { sequenceId } = await ctx.params;
  await deleteSequence(user.orgId, sequenceId);
  return new NextResponse(null, { status: 204 });
}
