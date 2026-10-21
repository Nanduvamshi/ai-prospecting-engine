import { NextRequest, NextResponse } from 'next/server';
import { assertCronAuthorized } from '@/server/cron-auth';
import { saveDisposableDomainsRecord } from '@/server/discovery/disposable-domains-store';
import { setDisposableDomains } from '@/server/discovery/email-verification';

export const dynamic = 'force-dynamic';

/**
 * POST /api/cron/sync-disposable-domains
 *
 * Pulls the upstream `disposable-email-domains/disposable-email-domains`
 * GitHub list and persists it to the `disposable_domains` table. The email
 * verifier lazily re-reads this record every 6h on each App Runner
 * instance.
 *
 * Schedule: daily (wired in ProspectingCronStack).
 */
const UPSTREAM_URL = 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf';

export async function POST(request: NextRequest) {
  const reject = assertCronAuthorized(request);
  if (reject) return reject;

  try {
    const res = await fetch(UPSTREAM_URL, {
      headers: { 'User-Agent': 'prospecting-disposable-sync/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
    }
    const text = await res.text();
    const domains = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('//'))
      .map(l => l.toLowerCase());

    if (domains.length === 0) {
      return NextResponse.json({ error: 'upstream returned empty list' }, { status: 502 });
    }

    const count = await saveDisposableDomainsRecord(domains, 'github:disposable-email-domains');
    // Update in-memory cache on THIS instance right away. Other App Runner
    // instances pick up the change within 6h via lazy refresh.
    setDisposableDomains(domains);

    console.log(`[cron/sync-disposable-domains] synced count=${count}`);
    return NextResponse.json({ count });
  } catch (err) {
    console.error('[cron/sync-disposable-domains] failed:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'sync failed' }, { status: 500 });
  }
}
