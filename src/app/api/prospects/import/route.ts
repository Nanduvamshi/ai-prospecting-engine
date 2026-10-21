import type { NextRequest } from 'next/server';
import { actorOf, fail, ok, readJson, withAuth } from '@/server/http';
import {
  completeImportBatch,
  createImportBatch,
  failImportBatch,
  importProspects,
  updateImportProgress,
  type ImportRow,
} from '@/server/prospects/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Above this many rows the import runs in the background and the client
 *  follows along on the SSE stream. Below it, waiting is faster than
 *  subscribing. */
const ASYNC_THRESHOLD = 50;
const MAX_ROWS = 10_000;

interface ImportBody {
  prospects?: ImportRow[];
  filename?: string;
  /** Force the background path regardless of size. */
  async?: boolean;
}

/**
 * POST /api/prospects/import
 *
 * Small batches complete inline. Large ones return a batchId immediately and
 * report progress through /api/prospects/import/[batchId]/stream.
 *
 * Progress is written to the batch row rather than pushed over a WebSocket,
 * which keeps working when the reader and writer are on different instances.
 */
export const POST = withAuth(async (request: NextRequest, user) => {
  const body = await readJson<ImportBody>(request);
  if (!body) return fail('Request body must be valid JSON');

  const rows = body.prospects;
  if (!Array.isArray(rows) || rows.length === 0) {
    return fail('Provide a non-empty "prospects" array');
  }
  if (rows.length > MAX_ROWS) {
    return fail(`Imports are limited to ${MAX_ROWS.toLocaleString()} rows per batch`, 413);
  }

  const actor = actorOf(user);
  const runAsync = body.async === true || rows.length > ASYNC_THRESHOLD;

  if (!runAsync) {
    const result = await importProspects(user.orgId, actor, rows, { filename: body.filename });
    const status = result.created > 0 ? 201 : result.errors.length === rows.length ? 400 : 207;
    return ok(
      {
        message:
          result.created === 0
            ? 'No prospects were imported. See the errors below.'
            : result.created === rows.length
              ? `Imported all ${result.created} prospects`
              : `Imported ${result.created} of ${rows.length} prospects`,
        ...result,
      },
      { status },
    );
  }

  // Background path. The batch row is created here so the client has an id to
  // subscribe with before any work starts.
  const batchId = await createImportBatch(user.orgId, actor, {
    filename: body.filename,
    totalRows: rows.length,
  });

  void (async () => {
    try {
      const result = await importProspects(user.orgId, actor, rows, {
        batchId,
        filename: body.filename,
        onProgress: (done, total) => {
          void updateImportProgress(user.orgId, batchId, {
            phase: 'saving',
            processed: done,
            total,
          });
        },
      });
      await updateImportProgress(user.orgId, batchId, {
        phase: 'complete',
        processed: rows.length,
        total: rows.length,
        imported: result.created,
        skipped: result.errors.length,
        duplicates: result.duplicates.length,
        errors: result.errors.slice(0, 50),
      });
      await completeImportBatch(user.orgId, batchId, {
        imported: result.created,
        skipped: result.errors.length,
        duplicates: result.duplicates.length,
      });
    } catch (err) {
      console.error('[prospects/import] background run failed', err);
      await failImportBatch(
        user.orgId,
        batchId,
        err instanceof Error ? err.message : 'Import failed',
      ).catch(() => {});
    }
  })();

  return ok(
    { batchId, status: 'running', totalRows: rows.length },
    { status: 202 },
  );
});
