import type { NextRequest } from 'next/server';
import { actorOf, fail, ok, readInt, readList, readParam, readJson, withAuth } from '@/server/http';
import {
  createProspect,
  getProspectStats,
  listCampaigns,
  listProspects,
  type CreateProspectInput,
} from '@/server/prospects/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET  /api/prospects   — list, filter and paginate
 * POST /api/prospects   — create one
 *
 * Replaces a catch-all proxy that forwarded to an AWS Lambda.
 */
export const GET = withAuth(async (request: NextRequest, user) => {
  const result = await listProspects(user.orgId, {
    status: readList(request, 'status'),
    source: readParam(request, 'source'),
    ownerId: readParam(request, 'ownerId'),
    search: readParam(request, 'search'),
    tag: readParam(request, 'tag'),
    limit: readInt(request, 'limit', 50),
    cursor: readParam(request, 'cursor'),
  });

  // Only computed when asked for: it is a grouped aggregate over the whole
  // org, and the list itself is paginated and much cheaper.
  const wantsMeta = readParam(request, 'stats') === 'true';
  const [stats, campaigns] = wantsMeta
    ? await Promise.all([getProspectStats(user.orgId), listCampaigns(user.orgId)])
    : [undefined, undefined];

  return ok({ ...result, ...(stats ? { stats, campaigns } : {}) });
});

export const POST = withAuth(async (request: NextRequest, user) => {
  const body = await readJson<CreateProspectInput>(request);
  if (!body) return fail('Request body must be valid JSON');
  if (!body.name?.trim()) return fail('Name is required');

  const prospect = await createProspect(user.orgId, actorOf(user), body);
  return ok({ prospect }, { status: 201 });
});
