import { randomUUID } from 'crypto';
import type { NextRequest } from 'next/server';
import { fail, ok, readJson, withAuth } from '@/server/http';
import { billingErrorResponse, getBillingProvider } from '@/server/billing';
import { createFindLeadsJob } from '@/server/pipeline/jobs';
import { runFindLeadsJob } from '@/server/pipeline/find-leads-runner';
import type { FindLeadsJobRequest } from '@/server/pipeline/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/prospects/find-leads
 *
 * Creates a job and returns immediately; the eight-phase pipeline runs as a
 * background task. A deep run takes two to three minutes, which is longer
 * than the platform request timeout, so the client polls
 * /api/prospects/find-leads/[jobId] for phase progress and partial results.
 */

function estimateSeconds(depth: 'quick' | 'deep'): number {
  return depth === 'deep' ? 150 : 60;
}

export const POST = withAuth(async (request: NextRequest, user) => {
  const body = await readJson<FindLeadsJobRequest>(request);
  if (!body) return fail('Request body must be valid JSON');
  if (!body.mode || !['filters', 'ai'].includes(body.mode)) {
    return fail('Invalid mode. Use "filters" or "ai".');
  }
  if (body.mode === 'ai' && !body.prompt?.trim()) {
    return fail('A prompt is required in AI mode');
  }

  const billing = getBillingProvider();
  const ctx = {
    orgId: user.orgId,
    userId: user.sub,
    authToken: request.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
  };

  // Check before spending anything. The actual charge lands after the run
  // succeeds, so a failed pipeline costs the user nothing.
  const gate = await billing.preCheck(ctx, 1);
  if (!gate.ok) return billingErrorResponse(gate);

  const searchDepth = (body.searchDepth ?? 'quick') as 'quick' | 'deep';
  const jobId = randomUUID();
  const now = new Date().toISOString();

  await createFindLeadsJob({
    jobId,
    orgId: user.orgId,
    userId: user.sub,
    // Only persisted when the active provider actually needs it to settle
    // later — storing a bearer token at rest for a no-op provider is pure
    // liability.
    ...(billing.requiresAuthToken ? { authToken: ctx.authToken } : {}),
    status: 'queued',
    phase: 0,
    phaseLabel: 'Getting ready…',
    percentComplete: 0,
    partialLeads: [],
    searchesRun: [],
    request: body,
    estimatedSeconds: estimateSeconds(searchDepth),
    createdAt: now,
    updatedAt: now,
  });

  // Fire and forget. Errors are captured inside the runner and written to the
  // job record, never thrown — the catch here is only for a crash outside its
  // own try block.
  void runFindLeadsJob({
    jobId,
    orgId: user.orgId,
    userId: user.sub,
    authToken: ctx.authToken ?? '',
    creditBalance: gate.balance,
    request: body,
  }).catch((err) => {
    console.error('[find-leads] runner crashed outside its handler', { jobId, err });
  });

  return ok({ jobId, status: 'queued', estimatedSeconds: estimateSeconds(searchDepth) });
});
