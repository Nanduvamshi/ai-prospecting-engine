import type { NextRequest } from 'next/server';
import { fail, ok, readJson, withAuth } from '@/server/http';
import { cancelJob, getFindLeadsJob } from '@/server/pipeline/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ jobId: string }> };

/**
 * GET   /api/prospects/find-leads/[jobId] — phase, progress and partial leads
 * PATCH /api/prospects/find-leads/[jobId] — { action: 'cancel' }
 *
 * The client polls GET while a run is in flight. Partial leads are populated
 * from phase 4 onward, so cards appear and then fill in rather than the user
 * watching a spinner for two minutes.
 */

export const GET = withAuth<Ctx>(async (_request, user, { params }) => {
  const { jobId } = await params;
  const job = await getFindLeadsJob(user.orgId, jobId);
  if (!job) return fail('Job not found', 404);

  // Org scoping is handled by the query; this additionally keeps one user
  // from watching a colleague's search.
  if (job.userId !== user.sub) return fail('Forbidden', 403);

  return ok({ job });
});

export const PATCH = withAuth<Ctx>(async (request: NextRequest, user, { params }) => {
  const { jobId } = await params;
  const body = await readJson<{ action?: string }>(request);
  if (body?.action !== 'cancel') return fail('Unsupported action');

  const job = await getFindLeadsJob(user.orgId, jobId);
  if (!job) return fail('Job not found', 404);
  if (job.userId !== user.sub) return fail('Forbidden', 403);

  // False means the run had already finished. Reporting that as success keeps
  // a double-click from flashing an error at the user; `alreadyFinal` lets the
  // UI tell the difference if it cares.
  const cancelled = await cancelJob(user.orgId, jobId);
  return ok({ cancelled, alreadyFinal: !cancelled });
});

/** The UI also issues DELETE to cancel. Same semantics. */
export const DELETE = withAuth<Ctx>(async (_request, user, { params }) => {
  const { jobId } = await params;
  const job = await getFindLeadsJob(user.orgId, jobId);
  if (!job) return fail('Job not found', 404);
  if (job.userId !== user.sub) return fail('Forbidden', 403);

  const cancelled = await cancelJob(user.orgId, jobId);
  return ok({ cancelled, alreadyFinal: !cancelled });
});
