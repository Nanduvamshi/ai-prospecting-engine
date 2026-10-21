import { ok, withAuth } from '@/server/http';
import { getEnrichmentSources } from '@/server/prospects/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ prospectId: string }> };

/**
 * GET /api/prospects/[prospectId]/enrichment-sources
 *
 * Which provider populated which field, for the provenance badges.
 */
export const GET = withAuth<Ctx>(async (_request, user, { params }) => {
  const { prospectId } = await params;
  const sources = await getEnrichmentSources(user.orgId, prospectId);
  return ok({ prospectId, sources });
});
