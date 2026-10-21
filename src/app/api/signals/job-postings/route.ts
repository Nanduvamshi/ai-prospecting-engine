import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { scrapeJobPostings } from '@/server/discovery/job-postings';

export const dynamic = 'force-dynamic';

// POST /api/crm/signals/job-postings — body: { domain: string }
// Scrapes the company's careers page for open roles; flags ICP matches.
export async function POST(request: NextRequest) {
  const { error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);

  try {
    const body = await request.json();
    const domain: string = body?.domain;
    if (!domain || typeof domain !== 'string') {
      return NextResponse.json({ error: 'domain required' }, { status: 400 });
    }
    const result = await scrapeJobPostings(domain);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Job posting scan failed' }, { status: 500 });
  }
}
