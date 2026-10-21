import 'server-only';

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, withTx } from '@/server/db/client';
import { findLeadsJobs, findLeadsJobLeads } from '@/server/db/schema';
import type {
  FindLeadsErrorCode,
  FindLeadsJob,
  FindLeadsJobRequest,
  FindLeadsJobStatus,
  PartialLead,
} from './types';

export type {
  FindLeadsErrorCode,
  FindLeadsJob,
  FindLeadsJobRequest,
  FindLeadsJobStatus,
  PartialLead,
};

/**
 * Find-leads job persistence.
 *
 * Every exported signature here is identical to the DynamoDB version this
 * replaces. That is the whole point: the pipeline runner is 925 lines of
 * working, load-bearing logic, and keeping these contracts meant it could be
 * copied across with a six-line diff instead of being rewritten.
 *
 * The one structural change is invisible to callers: the partial-leads blob
 * lives in its own table. A run performs roughly eight phase heartbeats and
 * six lead writes, and keeping the (potentially few-hundred-KB) blob out of
 * the row that the heartbeats touch avoids rewriting it fourteen times.
 */

// Skips redundant writes. Several of the six per-run lead writes are
// no-ops when an enrichment phase self-skips for a missing API key, which is
// the normal configuration in development.
const lastWritten = new Map<string, string>();

function rowToJob(
  job: typeof findLeadsJobs.$inferSelect,
  leads: PartialLead[],
  opts: { includeAuthToken: boolean },
): FindLeadsJob {
  const result: FindLeadsJob = {
    jobId: job.jobId,
    orgId: job.orgId,
    userId: job.userId,
    status: job.status as FindLeadsJobStatus,
    phase: job.phase,
    phaseLabel: job.phaseLabel,
    percentComplete: job.percentComplete,
    partialLeads: leads,
    searchesRun: job.searchesRun ?? [],
    summary: job.summary ?? undefined,
    request: job.request as FindLeadsJobRequest,
    estimatedSeconds: job.estimatedSeconds,
    metadata: job.metadata ?? undefined,
    errorCode: (job.errorCode as FindLeadsErrorCode | null) ?? undefined,
    errorMessage: job.errorMessage ?? undefined,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    completedAt: job.completedAt?.toISOString(),
  };
  if (opts.includeAuthToken && job.authToken) {
    (result as FindLeadsJob & { authToken?: string }).authToken = job.authToken;
  }
  return result;
}

export async function createFindLeadsJob(job: FindLeadsJob): Promise<void> {
  await withTx(job.orgId, async (tx) => {
    await tx.insert(findLeadsJobs).values({
      jobId: job.jobId,
      orgId: job.orgId,
      userId: job.userId,
      status: job.status,
      phase: job.phase,
      phaseLabel: job.phaseLabel,
      percentComplete: job.percentComplete,
      searchesRun: job.searchesRun ?? [],
      request: job.request,
      estimatedSeconds: job.estimatedSeconds,
      authToken: (job as FindLeadsJob & { authToken?: string }).authToken ?? null,
    });
    await tx.insert(findLeadsJobLeads).values({
      jobId: job.jobId,
      partialLeads: job.partialLeads ?? [],
    });
  });
}

async function loadJob(
  orgId: string,
  jobId: string,
  includeAuthToken: boolean,
): Promise<FindLeadsJob | null> {
  const rows = await db
    .select({ job: findLeadsJobs, leads: findLeadsJobLeads.partialLeads })
    .from(findLeadsJobs)
    .leftJoin(findLeadsJobLeads, eq(findLeadsJobLeads.jobId, findLeadsJobs.jobId))
    .where(and(eq(findLeadsJobs.jobId, jobId), eq(findLeadsJobs.orgId, orgId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return rowToJob(row.job, row.leads ?? [], { includeAuthToken });
}

/**
 * Client-facing read. Strips the auth token.
 *
 * The distinction between this and the internal variant is a security
 * boundary, not a convenience — this result is serialized straight into an
 * HTTP response.
 */
export async function getFindLeadsJob(orgId: string, jobId: string): Promise<FindLeadsJob | null> {
  return loadJob(orgId, jobId, false);
}

/** Runner-only read that preserves the auth token needed to settle billing. */
export async function getFindLeadsJobInternal(
  orgId: string,
  jobId: string,
): Promise<FindLeadsJob | null> {
  return loadJob(orgId, jobId, true);
}

export async function updateFindLeadsJobPhase(
  orgId: string,
  jobId: string,
  update: {
    status?: FindLeadsJobStatus;
    phase: number;
    phaseLabel: string;
    percentComplete: number;
    searchesRun?: string[];
  },
): Promise<void> {
  await db
    .update(findLeadsJobs)
    .set({
      phase: update.phase,
      phaseLabel: update.phaseLabel,
      percentComplete: update.percentComplete,
      updatedAt: new Date(),
      ...(update.status ? { status: update.status } : {}),
      ...(update.searchesRun ? { searchesRun: update.searchesRun } : {}),
    })
    .where(and(eq(findLeadsJobs.jobId, jobId), eq(findLeadsJobs.orgId, orgId)));
}

/**
 * Replace the whole leads array.
 *
 * Wholesale replacement rather than append: each phase
 * writes its complete current view so enrichment overwrites entries in place.
 */
export async function setPartialLeads(
  orgId: string,
  jobId: string,
  leads: PartialLead[],
): Promise<void> {
  const serialized = JSON.stringify(leads);
  if (lastWritten.get(jobId) === serialized) return;
  lastWritten.set(jobId, serialized);

  await db
    .insert(findLeadsJobLeads)
    .values({ jobId, partialLeads: leads })
    .onConflictDoUpdate({
      target: findLeadsJobLeads.jobId,
      set: { partialLeads: leads, updatedAt: new Date() },
    });

  // Keep the parent's updatedAt moving so the stalled-job reaper can tell an
  // enrichment phase that is working slowly from one that has died.
  await db
    .update(findLeadsJobs)
    .set({ updatedAt: new Date() })
    .where(and(eq(findLeadsJobs.jobId, jobId), eq(findLeadsJobs.orgId, orgId)));
}

export async function markJobCompleted(
  orgId: string,
  jobId: string,
  data: { partialLeads: PartialLead[]; summary?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  const now = new Date();
  await withTx(orgId, async (tx) => {
    await tx
      .insert(findLeadsJobLeads)
      .values({ jobId, partialLeads: data.partialLeads })
      .onConflictDoUpdate({
        target: findLeadsJobLeads.jobId,
        set: { partialLeads: data.partialLeads, updatedAt: now },
      });

    await tx
      .update(findLeadsJobs)
      .set({
        status: 'completed',
        phase: 8,
        phaseLabel: 'Done',
        percentComplete: 100,
        summary: data.summary ?? '',
        metadata: data.metadata ?? {},
        completedAt: now,
        updatedAt: now,
        // The run is over; nothing will need to authenticate on its behalf again.
        authToken: null,
      })
      .where(and(eq(findLeadsJobs.jobId, jobId), eq(findLeadsJobs.orgId, orgId)));
  });
  lastWritten.delete(jobId);
}

export async function markJobFailed(
  orgId: string,
  jobId: string,
  errorCode: FindLeadsErrorCode,
  errorMessage: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(findLeadsJobs)
    .set({
      status: 'failed',
      errorCode,
      errorMessage,
      completedAt: now,
      updatedAt: now,
      authToken: null,
    })
    .where(and(eq(findLeadsJobs.jobId, jobId), eq(findLeadsJobs.orgId, orgId)));
  lastWritten.delete(jobId);
}

/**
 * Cancel a job that has not already finished.
 *
 * The DynamoDB version used a conditional write and threw
 * ConditionalCheckFailedException when the job was already final; the route
 * caught that and reported success so repeated clicks did not surface an
 * error. Here the same idempotence comes from the row count, and the boolean
 * says which happened.
 *
 * Returns false when there was nothing left to cancel.
 */
export async function cancelJob(orgId: string, jobId: string): Promise<boolean> {
  const updated = await db
    .update(findLeadsJobs)
    .set({ status: 'cancelled', updatedAt: new Date(), authToken: null })
    .where(
      and(
        eq(findLeadsJobs.jobId, jobId),
        eq(findLeadsJobs.orgId, orgId),
        inArray(findLeadsJobs.status, ['queued', 'running']),
      ),
    )
    .returning({ jobId: findLeadsJobs.jobId });

  lastWritten.delete(jobId);
  return updated.length > 0;
}

/**
 * Fail jobs whose runner vanished.
 *
 * A run is an unawaited promise living in a request handler. If the instance
 * is recycled mid-flight — a deploy, a scale-in — nothing ever writes a
 * terminal state and the job sits at "running" forever while the UI polls it.
 * The reaper cron calls this to close that gap.
 */
export async function reapStalledJobs(olderThanMinutes = 5): Promise<number> {
  const reaped = await db
    .update(findLeadsJobs)
    .set({
      status: 'failed',
      errorCode: 'internal',
      errorMessage:
        'This search stopped unexpectedly and no credits were charged. Please try again.',
      completedAt: new Date(),
      updatedAt: new Date(),
      authToken: null,
    })
    .where(
      and(
        inArray(findLeadsJobs.status, ['queued', 'running']),
        lt(findLeadsJobs.updatedAt, sql`now() - make_interval(mins => ${olderThanMinutes})`),
      ),
    )
    .returning({ jobId: findLeadsJobs.jobId });

  return reaped.length;
}

/** TTL sweep. Cascades to the leads table via the foreign key. */
export async function deleteExpiredJobs(limit = 5000): Promise<number> {
  const deleted = await db.execute(sql`
    delete from find_leads_jobs
    where job_id in (
      select job_id from find_leads_jobs where expires_at < now() limit ${limit}
    )
    returning job_id
  `);
  return deleted.rowCount ?? 0;
}

/** Recent jobs for an org, newest first. */
export async function listRecentJobs(orgId: string, limit = 20): Promise<FindLeadsJob[]> {
  const rows = await db
    .select({ job: findLeadsJobs, leads: findLeadsJobLeads.partialLeads })
    .from(findLeadsJobs)
    .leftJoin(findLeadsJobLeads, eq(findLeadsJobLeads.jobId, findLeadsJobs.jobId))
    .where(eq(findLeadsJobs.orgId, orgId))
    .orderBy(sql`${findLeadsJobs.createdAt} desc`)
    .limit(limit);

  return rows.map((row) => rowToJob(row.job, row.leads ?? [], { includeAuthToken: false }));
}
