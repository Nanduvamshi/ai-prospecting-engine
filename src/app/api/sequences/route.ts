import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { listSequences, createSequence } from '@/server/outreach/sequences/sequence-store';
import type { SequenceStep } from '@/server/outreach/sequences/types';

export const dynamic = 'force-dynamic';

const VALID_STEP_TYPES: Array<SequenceStep['type']> = ['send_email', 'send_whatsapp', 'send_linkedin', 'wait'];

function validateSteps(raw: unknown): SequenceStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) return null;
  const steps: SequenceStep[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object') return null;
    const type = r.type as SequenceStep['type'];
    if (!VALID_STEP_TYPES.includes(type)) return null;
    const delayDays = typeof r.delayDays === 'number' ? Math.max(0, Math.min(60, r.delayDays)) : 0;
    steps.push({
      id: typeof r.id === 'string' ? r.id : `step_${Date.now()}_${steps.length}`,
      type,
      delayDays,
      subject: typeof r.subject === 'string' ? r.subject.slice(0, 200) : undefined,
      body: typeof r.body === 'string' ? r.body.slice(0, 5000) : undefined,
    });
  }
  return steps;
}

export async function GET(request: NextRequest) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sequences = await listSequences(user.orgId);
  return NextResponse.json({ sequences });
}

export async function POST(request: NextRequest) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    const steps = validateSteps(body?.steps);
    if (!steps) return NextResponse.json({ error: 'steps must be a non-empty array of valid steps' }, { status: 400 });

    const seq = await createSequence({
      orgId: user.orgId,
      createdBy: user.sub,
      name,
      description: typeof body?.description === 'string' ? body.description.slice(0, 500) : undefined,
      steps,
      exitOnReply: body?.exitOnReply !== false,
    });
    return NextResponse.json({ sequence: seq });
  } catch {
    return NextResponse.json({ error: 'Create failed' }, { status: 500 });
  }
}
