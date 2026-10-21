import type { NextRequest } from 'next/server';
import { fail, ok, readInt, readJson, withAuth } from '@/server/http';
import { listImportHistory, undoImport } from '@/server/prospects/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/prospects/import-history — recent import batches. */
export const GET = withAuth(async (request: NextRequest, user) => {
  const history = await listImportHistory(user.orgId, readInt(request, 'limit', 50));
  return ok({ history });
});

/** POST /api/prospects/import-history — undo a batch. */
export const POST = withAuth(async (request: NextRequest, user) => {
  const body = await readJson<{ batchId?: string; action?: string }>(request);
  if (!body?.batchId) return fail('batchId is required');

  const result = await undoImport(user.orgId, body.batchId);
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return fail('Import batch not found', 404);
      case 'already_undone':
        return fail('This import has already been undone', 409);
      case 'expired':
        return fail('Imports can only be undone within 24 hours', 422);
    }
  }
  return ok({ message: `Removed ${result.deleted} imported prospects`, deleted: result.deleted });
});
