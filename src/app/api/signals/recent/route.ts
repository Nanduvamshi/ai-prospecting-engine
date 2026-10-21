import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { readRecentSweepItems, type SweepType } from '@/server/discovery/sweep-sink';

export const dynamic = 'force-dynamic';

const VALID_TYPES: SweepType[] = ['funding', 'review', 'domain', 'social'];

// GET /api/crm/signals/recent?type=funding&days=7&limit=100
// Returns persisted sweep items from the last N days.
export async function GET(request: NextRequest) {
  const { error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);

  const type = request.nextUrl.searchParams.get('type') as SweepType | null;
  if (!type || !VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: 'type required', valid: VALID_TYPES }, { status: 400 });
  }

  const daysRaw = request.nextUrl.searchParams.get('days');
  const days = daysRaw ? Math.max(1, Math.min(14, parseInt(daysRaw, 10) || 7)) : 7;
  const limitRaw = request.nextUrl.searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10) || 100)) : 100;

  try {
    const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    const items = await readRecentSweepItems(type, { sinceEpochSeconds: since, limit });
    return NextResponse.json({ type, days, count: items.length, items });
  } catch {
    return NextResponse.json({ error: 'Sweep read failed' }, { status: 500 });
  }
}
