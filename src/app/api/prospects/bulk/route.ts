import type { NextRequest } from 'next/server';
import { fail, ok, readJson, withAuth } from '@/server/http';
import { bulkDeleteProspects, bulkUpdateProspects, type UpdateProspectInput } from '@/server/prospects/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_IDS = 1000;

interface Body {
  prospectIds?: string[];
  updates?: UpdateProspectInput;
}

/** PATCH /api/prospects/bulk — apply one change to many prospects. */
export const PATCH = withAuth(async (request: NextRequest, user) => {
  const body = await readJson<Body>(request);
  if (!Array.isArray(body?.prospectIds) || body.prospectIds.length === 0) {
    return fail('Provide a non-empty "prospectIds" array');
  }
  if (body.prospectIds.length > MAX_IDS) {
    return fail(`Bulk operations are limited to ${MAX_IDS} prospects at a time`, 413);
  }
  if (!body.updates || Object.keys(body.updates).length === 0) {
    return fail('Provide an "updates" object');
  }

  const updated = await bulkUpdateProspects(user.orgId, body.prospectIds, body.updates);
  return ok({ updated, message: `Updated ${updated} prospects` });
});

/** DELETE /api/prospects/bulk — delete many prospects. */
export const DELETE = withAuth(async (request: NextRequest, user) => {
  const body = await readJson<Body>(request);
  if (!Array.isArray(body?.prospectIds) || body.prospectIds.length === 0) {
    return fail('Provide a non-empty "prospectIds" array');
  }
  if (body.prospectIds.length > MAX_IDS) {
    return fail(`Bulk operations are limited to ${MAX_IDS} prospects at a time`, 413);
  }

  const deleted = await bulkDeleteProspects(user.orgId, body.prospectIds);
  return ok({ deleted, message: `Deleted ${deleted} prospects` });
});
