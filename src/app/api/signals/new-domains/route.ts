import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { findNewDomains, runDomainKeywordSweep, DEFAULT_ICP_KEYWORDS } from '@/server/discovery/domain-monitor';

export const dynamic = 'force-dynamic';

// GET /api/crm/signals/new-domains?keyword=crm&days=30  → single keyword
// GET /api/crm/signals/new-domains?sweep=true           → default ICP keyword list
export async function GET(request: NextRequest) {
  const { error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);

  try {
    const sweep = request.nextUrl.searchParams.get('sweep');
    const daysRaw = request.nextUrl.searchParams.get('days');
    const days = daysRaw ? Math.max(1, Math.min(90, parseInt(daysRaw, 10) || 30)) : 30;

    if (sweep === 'true') {
      const matches = await runDomainKeywordSweep(DEFAULT_ICP_KEYWORDS, { sinceDays: days });
      return NextResponse.json({ matches });
    }

    const keyword = request.nextUrl.searchParams.get('keyword');
    if (!keyword) {
      return NextResponse.json({ error: 'keyword required (or sweep=true)' }, { status: 400 });
    }
    const result = await findNewDomains(keyword, { sinceDays: days });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Domain monitor failed' }, { status: 500 });
  }
}
