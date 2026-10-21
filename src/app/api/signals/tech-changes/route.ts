import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { detectTechStackChanges } from '@/server/discovery/tech-stack-changes';

export const dynamic = 'force-dynamic';

// POST /api/crm/signals/tech-changes — body: { domain: string }
// Scans domain, diffs against prior persisted scan, returns added/removed tools.
// Also persists the current scan for future diffs.
export async function POST(request: NextRequest) {
  const { error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);

  try {
    const body = await request.json();
    const domain: string = body?.domain;
    if (!domain || typeof domain !== 'string') {
      return NextResponse.json({ error: 'domain required' }, { status: 400 });
    }
    const result = await detectTechStackChanges(domain);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Tech change detection failed' }, { status: 500 });
  }
}
