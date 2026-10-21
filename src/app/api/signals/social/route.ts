import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { searchBuyingIntent, runBuyingIntentSweep } from '@/server/discovery/social-listening';

export const dynamic = 'force-dynamic';

// POST /api/crm/signals/social
// Body options:
//   { query: "looking for CRM" }   → single search
//   { sweep: true }                → default query set across Reddit + HN
export async function POST(request: NextRequest) {
  const { error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);

  try {
    const body = await request.json();

    if (body?.sweep === true) {
      const signals = await runBuyingIntentSweep();
      return NextResponse.json({ signals });
    }

    const query: string = body?.query;
    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'query required' }, { status: 400 });
    }
    const result = await searchBuyingIntent(query);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Social listening failed' }, { status: 500 });
  }
}
