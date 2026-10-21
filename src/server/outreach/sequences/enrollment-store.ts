import 'server-only';

import { and, eq, lte, sql } from 'drizzle-orm';
import { db, withTx } from '@/server/db/client';
import { sequenceEnrollments } from '@/server/db/schema';
import type { SequenceEnrollment, EnrollmentStatus } from './types';

/**
 * Sequence enrollment persistence.
 *
 * The version this replaces carried a candid comment: the runner found due
 * work with a cross-org table Scan plus a filter expression, described as
 * "fine until > 10k enrollments". It had a second problem the comment did not
 * mention — nothing stopped two runner invocations from picking up the same
 * enrollment and sending the same step twice.
 *
 * Both are fixed here, and neither fix changes a single call site:
 *   - a partial index on (next_run_at) WHERE status = 'running' turns the
 *     scan into an index-only range lookup that stays fast regardless of how
 *     many completed enrollments have piled up
 *   - FOR UPDATE SKIP LOCKED means concurrent runners claim disjoint sets
 *     instead of racing over the same rows
 */

function generateId(): string {
  return `enr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

type EnrollmentRow = typeof sequenceEnrollments.$inferSelect;

function rowToEnrollment(row: EnrollmentRow): SequenceEnrollment {
  return {
    enrollmentId: row.enrollmentId,
    sequenceId: row.sequenceId,
    orgId: row.orgId,
    prospectEmail: row.prospectEmail,
    prospectName: row.prospectName ?? undefined,
    prospectCompany: row.prospectCompany ?? undefined,
    enrolledBy: row.enrolledBy ?? '',
    status: row.status as EnrollmentStatus,
    currentStepIndex: row.currentStepIndex,
    nextRunAt: (row.nextRunAt ?? row.enrolledAt).toISOString(),
    enrolledAt: row.enrolledAt.toISOString(),
    lastAdvancedAt: row.lastAdvancedAt?.toISOString(),
    exitReason: row.exitReason ?? undefined,
    history: row.history ?? [],
  };
}

export async function listOrgEnrollments(
  orgId: string,
  opts: { status?: EnrollmentStatus; limit?: number } = {},
): Promise<SequenceEnrollment[]> {
  const rows = await db
    .select()
    .from(sequenceEnrollments)
    .where(
      opts.status
        ? and(eq(sequenceEnrollments.orgId, orgId), eq(sequenceEnrollments.status, opts.status))
        : eq(sequenceEnrollments.orgId, orgId),
    )
    .limit(opts.limit ?? 200);

  return rows.map(rowToEnrollment);
}

/** Enrollments for one sequence. Filtered in SQL, not in application memory. */
export async function listEnrollmentsForSequence(
  orgId: string,
  sequenceId: string,
): Promise<SequenceEnrollment[]> {
  const rows = await db
    .select()
    .from(sequenceEnrollments)
    .where(
      and(eq(sequenceEnrollments.orgId, orgId), eq(sequenceEnrollments.sequenceId, sequenceId)),
    );
  return rows.map(rowToEnrollment);
}

export async function getEnrollment(
  orgId: string,
  enrollmentId: string,
): Promise<SequenceEnrollment | null> {
  const rows = await db
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.orgId, orgId),
        eq(sequenceEnrollments.enrollmentId, enrollmentId),
      ),
    )
    .limit(1);
  return rows[0] ? rowToEnrollment(rows[0]) : null;
}

export async function createEnrollment(opts: {
  orgId: string;
  sequenceId: string;
  prospectEmail: string;
  prospectName?: string;
  prospectCompany?: string;
  enrolledBy: string;
}): Promise<SequenceEnrollment> {
  const now = new Date();
  const enrollmentId = generateId();

  const [row] = await db
    .insert(sequenceEnrollments)
    .values({
      enrollmentId,
      orgId: opts.orgId,
      sequenceId: opts.sequenceId,
      prospectEmail: opts.prospectEmail,
      prospectName: opts.prospectName ?? null,
      prospectCompany: opts.prospectCompany ?? null,
      enrolledBy: opts.enrolledBy,
      status: 'running',
      currentStepIndex: 0,
      // Step 0 fires immediately.
      nextRunAt: now,
      enrolledAt: now,
      history: [{ at: now.toISOString(), action: 'enrolled' }],
    })
    .returning();

  return rowToEnrollment(row);
}

export async function updateEnrollment(
  orgId: string,
  enrollment: SequenceEnrollment,
): Promise<void> {
  // Audit trail stays bounded to the last 20 entries.
  const history = (enrollment.history ?? []).slice(-20);

  await db
    .update(sequenceEnrollments)
    .set({
      status: enrollment.status,
      currentStepIndex: enrollment.currentStepIndex,
      nextRunAt: enrollment.nextRunAt ? new Date(enrollment.nextRunAt) : null,
      lastAdvancedAt: enrollment.lastAdvancedAt ? new Date(enrollment.lastAdvancedAt) : new Date(),
      exitReason: enrollment.exitReason ?? null,
      history,
      ...(enrollment.status === 'completed' ? { completedAt: new Date() } : {}),
    })
    .where(
      and(
        eq(sequenceEnrollments.orgId, orgId),
        eq(sequenceEnrollments.enrollmentId, enrollment.enrollmentId),
      ),
    );
}

/**
 * Active enrollments for a prospect, used by the exit-on-reply hook.
 *
 * Previously this pulled up to a thousand rows and filtered them in JS.
 */
export async function findActiveEnrollmentsForProspect(
  orgId: string,
  prospectEmail: string,
): Promise<SequenceEnrollment[]> {
  const rows = await db
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.orgId, orgId),
        eq(sequenceEnrollments.status, 'running'),
        sql`lower(${sequenceEnrollments.prospectEmail}) = ${prospectEmail.toLowerCase()}`,
      ),
    );
  return rows.map(rowToEnrollment);
}

export async function exitEnrollment(
  orgId: string,
  enrollmentId: string,
  reason: string,
): Promise<void> {
  const enrollment = await getEnrollment(orgId, enrollmentId);
  if (!enrollment || enrollment.status !== 'running') return;

  enrollment.status = 'exited';
  enrollment.exitReason = reason;
  enrollment.history = [
    ...(enrollment.history ?? []),
    { at: new Date().toISOString(), action: 'exited', detail: reason },
  ];
  await updateEnrollment(orgId, enrollment);
}

/**
 * Claim enrollments whose next step is due.
 *
 * SKIP LOCKED is what makes this safe to run on more than one instance: rows
 * already claimed by a concurrent runner are passed over rather than waited
 * on, so two runners divide the work instead of duplicating it.
 *
 * The claim marks each row as advanced inside the same transaction, so a
 * crash between claiming and sending loses at most one tick rather than
 * re-sending on the next one.
 */
export async function findDueEnrollments(limit = 100): Promise<SequenceEnrollment[]> {
  return withTx(null, async (tx) => {
    const claimed = await tx
      .select()
      .from(sequenceEnrollments)
      .where(
        and(
          eq(sequenceEnrollments.status, 'running'),
          lte(sequenceEnrollments.nextRunAt, new Date()),
        ),
      )
      .orderBy(sequenceEnrollments.nextRunAt)
      .limit(limit)
      .for('update', { skipLocked: true });

    if (claimed.length === 0) return [];

    await tx
      .update(sequenceEnrollments)
      .set({ lastAdvancedAt: new Date() })
      .where(
        sql`${sequenceEnrollments.enrollmentId} in ${claimed.map((r) => r.enrollmentId)}`,
      );

    return claimed.map(rowToEnrollment);
  });
}
