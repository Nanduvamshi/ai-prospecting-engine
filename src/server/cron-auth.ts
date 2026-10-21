import { NextRequest, NextResponse } from 'next/server';

/**
 * Gate for /api/cron/* endpoints.
 * Expects: header `x-cron-secret: <value of CRON_SECRET env var>`
 * Returns null if authorized, or a NextResponse if the request should be rejected.
 */
export function assertCronAuthorized(request: NextRequest): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed if CRON_SECRET isn't set — don't allow unauthenticated access.
    return NextResponse.json({ error: 'Cron not configured' }, { status: 503 });
  }
  const provided = request.headers.get('x-cron-secret');
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
