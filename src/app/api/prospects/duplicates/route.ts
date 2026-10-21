import type { NextRequest } from 'next/server';
import { fail, ok, readJson, withAuth } from '@/server/http';
import { checkDuplicates } from '@/server/prospects/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  excludeId?: string;
}

/**
 * POST /api/prospects/duplicates — would this prospect duplicate an existing one?
 *
 * Called before a manual create so the UI can warn rather than let the user
 * discover the collision afterwards.
 */
export const POST = withAuth(async (request: NextRequest, user) => {
  const body = await readJson<Body>(request);
  if (!body) return fail('Request body must be valid JSON');
  if (!body.email && !body.phone && !body.company && !body.name) {
    return fail('Provide at least one of name, email, phone or company');
  }

  const matches = await checkDuplicates(user.orgId, body, body.excludeId);
  return ok({ duplicates: matches, hasDuplicates: matches.length > 0 });
});
