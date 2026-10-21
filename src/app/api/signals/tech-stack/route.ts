import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { detectTechStack } from '@/server/discovery/tech-stack';

export const dynamic = 'force-dynamic';

// POST /api/crm/signals/tech-stack — body: { domain: string }
// Returns detected technologies + competitor subset.
export async function POST(request: NextRequest) {
  const { error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);

  try {
    const body = await request.json();
    const domain: string = body?.domain;
    if (!domain || typeof domain !== 'string') {
      return NextResponse.json({ error: 'domain required' }, { status: 400 });
    }
    const result = await detectTechStack(domain);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Tech stack detection failed' }, { status: 500 });
  }
}
