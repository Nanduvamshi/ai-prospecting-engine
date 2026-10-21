import type { NextRequest } from 'next/server';
import { requireAuth } from '@/server/auth/require-auth';
import { getImportBatch } from '@/server/prospects/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const POLL_MS = 500;
/** Stop after five minutes. A stream nobody is reading still holds a
 *  connection, and imports that long have their own reaper. */
const MAX_DURATION_MS = 5 * 60 * 1000;

type Ctx = { params: Promise<{ batchId: string }> };

/**
 * GET /api/prospects/import/[batchId]/stream — server-sent import progress.
 *
 * Replaces a WebSocket path that ran through API Gateway and a Lambda-side
 * emitter: roughly 900 lines across a connection-fallback cascade
 * (WebSocket → SSE → long-poll), a progress emitter and a connections table.
 *
 * The progress source is the batch row rather than an in-memory emitter,
 * which matters once more than one instance is running — the browser opening
 * this stream will often reach a different instance than the one importing.
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  const { user, error } = await requireAuth(request);
  if (error || !user) {
    return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
      status: error?.status ?? 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { batchId } = await params;
  const batch = await getImportBatch(user.orgId, batchId);
  if (!batch) {
    return new Response(JSON.stringify({ success: false, error: 'Import batch not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const finish = (reason: string) => {
        if (closed) return;
        send('end', { reason });
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // The client aborting is the normal way this ends — a user closing the
      // import modal. Without this the interval would run until the timeout.
      request.signal.addEventListener('abort', () => finish('aborted'));

      const tick = async () => {
        if (closed) return;
        if (Date.now() - startedAt > MAX_DURATION_MS) return finish('timeout');

        try {
          const current = await getImportBatch(user.orgId, batchId);
          if (!current) return finish('missing');

          send('progress', {
            batchId,
            status: current.status,
            totalRows: current.totalRows,
            imported: current.imported,
            skipped: current.skipped,
            duplicates: current.duplicates,
            progress: current.progress ?? null,
          });

          if (current.status !== 'running') finish(current.status);
        } catch (err) {
          console.error('[import stream] poll failed', err);
          finish('error');
        }
      };

      const timer = setInterval(() => void tick(), POLL_MS);
      await tick();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer would defeat the point of streaming.
      'x-accel-buffering': 'no',
    },
  });
}
