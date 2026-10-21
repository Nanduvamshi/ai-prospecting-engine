import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { detectExecChanges } from '@/server/discovery/exec-changes';

export const dynamic = 'force-dynamic';

// POST /api/crm/signals/exec-changes — body: { company: string }
// Returns recent C-level / VP changes at the target company via SerpAPI.
export async function POST(request: NextRequest) {
  const { error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);

  try {
    const body = await request.json();
    const company: string = body?.company;
    if (!company || typeof company !== 'string') {
      return NextResponse.json({ error: 'company required' }, { status: 400 });
    }
    const changes = await detectExecChanges(company);
    return NextResponse.json({ company, changes });
  } catch {
    return NextResponse.json({ error: 'Exec change detection failed' }, { status: 500 });
  }
}
