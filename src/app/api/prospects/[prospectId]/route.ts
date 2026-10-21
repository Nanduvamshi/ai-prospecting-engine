import type { NextRequest } from 'next/server';
import { fail, ok, readJson, withAuth } from '@/server/http';
import {
  deleteProspect,
  getProspect,
  updateProspect,
  type UpdateProspectInput,
} from '@/server/prospects/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ prospectId: string }> };

export const GET = withAuth<Ctx>(async (_request, user, { params }) => {
  const { prospectId } = await params;
  const prospect = await getProspect(user.orgId, prospectId);
  if (!prospect) return fail('Prospect not found', 404);
  return ok({ prospect });
});

export const PATCH = withAuth<Ctx>(async (request: NextRequest, user, { params }) => {
  const { prospectId } = await params;
  const body = await readJson<UpdateProspectInput>(request);
  if (!body) return fail('Request body must be valid JSON');

  const prospect = await updateProspect(user.orgId, prospectId, body);
  if (!prospect) return fail('Prospect not found', 404);
  return ok({ prospect });
});

// PUT is accepted as an alias for clients that prefer full-replace semantics.
export const PUT = PATCH;

export const DELETE = withAuth<Ctx>(async (_request, user, { params }) => {
  const { prospectId } = await params;
  const deleted = await deleteProspect(user.orgId, prospectId);
  if (!deleted) return fail('Prospect not found', 404);
  return ok({ message: 'Prospect deleted' });
});
