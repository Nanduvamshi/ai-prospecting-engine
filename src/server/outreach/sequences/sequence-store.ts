import 'server-only';

import { and, countDistinct, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { sequences, sequenceEnrollments } from '@/server/db/schema';
import type { OutreachSequence, SequenceStep } from './types';

/** Sequence definition persistence. Same exported contract as before. */

function generateId(): string {
  return `seq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

type SequenceRow = typeof sequences.$inferSelect;

function rowToSequence(row: SequenceRow): OutreachSequence {
  return {
    sequenceId: row.sequenceId,
    orgId: row.orgId,
    name: row.name,
    description: row.description ?? undefined,
    steps: row.steps ?? [],
    exitOnReply: row.exitOnReply,
    icpFilter: row.icpFilter ?? undefined,
    createdBy: row.createdBy ?? '',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    enrolledCount: row.enrolledCount,
    completedCount: row.completedCount,
    exitedCount: row.exitedCount,
  };
}

/**
 * List sequences with live enrollment counts.
 *
 * `enrolledCount` is a stored counter, incremented when someone enrols. Any
 * write that bypasses that path — a bulk import, a backfill, seed data —
 * leaves it stale, and the UI then reports "0 enrolled" above a visible list
 * of enrollments. Counting the rows costs almost nothing on an indexed
 * foreign key and cannot drift, so the live value wins where they disagree.
 *
 * The completed and exited counters stay as stored values: those count
 * lifecycle events, and a row that has since been deleted should still be
 * reflected in the total.
 */
export async function listSequences(orgId: string): Promise<OutreachSequence[]> {
  // A LEFT JOIN with GROUP BY rather than a correlated subquery. Writing the
  // subquery inside a raw `sql` template looked fine but rendered its columns
  // unqualified — `where "sequence_id" = "sequence_id"` — so both sides
  // resolved to the inner table and the condition was always true, returning
  // the count of every enrollment for every sequence. The query builder
  // qualifies join conditions itself, so it cannot go wrong the same way.
  const rows = await db
    .select({
      sequence: sequences,
      liveEnrolled: countDistinct(sequenceEnrollments.enrollmentId),
    })
    .from(sequences)
    .leftJoin(sequenceEnrollments, eq(sequenceEnrollments.sequenceId, sequences.sequenceId))
    .where(eq(sequences.orgId, orgId))
    .groupBy(sequences.sequenceId)
    .orderBy(desc(sequences.createdAt));

  return rows.map(({ sequence, liveEnrolled }) => ({
    ...rowToSequence(sequence),
    enrolledCount: Math.max(sequence.enrolledCount, liveEnrolled),
  }));
}

export async function getSequence(
  orgId: string,
  sequenceId: string,
): Promise<OutreachSequence | null> {
  const rows = await db
    .select()
    .from(sequences)
    .where(and(eq(sequences.orgId, orgId), eq(sequences.sequenceId, sequenceId)))
    .limit(1);
  return rows[0] ? rowToSequence(rows[0]) : null;
}

export async function createSequence(opts: {
  orgId: string;
  name: string;
  description?: string;
  steps: SequenceStep[];
  exitOnReply?: boolean;
  icpFilter?: string;
  createdBy: string;
}): Promise<OutreachSequence> {
  const [row] = await db
    .insert(sequences)
    .values({
      sequenceId: generateId(),
      orgId: opts.orgId,
      name: opts.name,
      description: opts.description ?? null,
      steps: opts.steps,
      exitOnReply: opts.exitOnReply ?? true,
      icpFilter: opts.icpFilter ?? null,
      createdBy: opts.createdBy,
    })
    .returning();
  return rowToSequence(row);
}

export async function updateSequence(
  orgId: string,
  sequenceId: string,
  updates: Partial<OutreachSequence>,
): Promise<OutreachSequence | null> {
  const [row] = await db
    .update(sequences)
    .set({
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.description !== undefined ? { description: updates.description } : {}),
      ...(updates.steps !== undefined ? { steps: updates.steps } : {}),
      ...(updates.exitOnReply !== undefined ? { exitOnReply: updates.exitOnReply } : {}),
      ...(updates.icpFilter !== undefined ? { icpFilter: updates.icpFilter } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(sequences.orgId, orgId), eq(sequences.sequenceId, sequenceId)))
    .returning();
  return row ? rowToSequence(row) : null;
}

export async function deleteSequence(orgId: string, sequenceId: string): Promise<void> {
  // Enrollments cascade via the foreign key.
  await db
    .delete(sequences)
    .where(and(eq(sequences.orgId, orgId), eq(sequences.sequenceId, sequenceId)));
}

/**
 * Increment one of the denormalised counters.
 *
 * Non-fatal, as before: a counter that drifts is a cosmetic problem, and it
 * must never take down the runner tick that was trying to record it.
 *
 * The increment happens in SQL rather than read-modify-write, so concurrent
 * runners cannot lose each other's updates.
 */
export async function bumpSequenceCounter(
  orgId: string,
  sequenceId: string,
  field: 'enrolledCount' | 'completedCount' | 'exitedCount',
  by: number = 1,
): Promise<void> {
  const column = {
    enrolledCount: sequences.enrolledCount,
    completedCount: sequences.completedCount,
    exitedCount: sequences.exitedCount,
  }[field];

  try {
    await db
      .update(sequences)
      .set({ [field]: sql`${column} + ${by}`, updatedAt: new Date() })
      .where(and(eq(sequences.orgId, orgId), eq(sequences.sequenceId, sequenceId)));
  } catch {
    /* non-fatal */
  }
}
