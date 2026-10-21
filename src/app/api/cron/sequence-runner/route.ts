import { NextRequest, NextResponse } from 'next/server';
import { assertCronAuthorized } from '@/server/cron-auth';
import { runSequenceBatch } from '@/server/outreach/sequences/runner';

export const dynamic = 'force-dynamic';

// POST /api/cron/sequence-runner
// Schedule: every 5 minutes (via EventBridge — wire in ProspectingCronStack
// as an additional rule, OR a separate CDK stack later).
// Processes up to 100 due enrollments per run.
export async function POST(request: NextRequest) {
  const reject = assertCronAuthorized(request);
  if (reject) return reject;

  try {
    const stats = await runSequenceBatch({ limit: 100 });
    console.log('[cron/sequence-runner] stats:', stats);
    return NextResponse.json(stats);
  } catch (err) {
    console.error('[cron/sequence-runner] failed:', err);
    return NextResponse.json({ error: 'Sequence runner failed' }, { status: 500 });
  }
}
