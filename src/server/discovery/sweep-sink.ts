import 'server-only';

import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { sweepItems } from '@/server/db/schema';

/**
 * Sweep sink — persists cron-produced intent signals.
 *
 * The scheduled sweeps (funding announcements, negative reviews, newly issued
 * certificates, social buying intent) generate arrays of events. Without
 * persistence that data evaporates when the request returns, so it lands here
 * as a rolling fourteen-day window for "what happened this week" — not an
 * analytical archive.
 *
 * The DynamoDB version encoded the content hash into the sort key to make
 * re-ingestion idempotent, then chunked writes into batches of 25 to respect
 * BatchWrite limits. Here a unique constraint does the dedupe and the whole
 * batch is a single multi-row insert.
 */

export type SweepType = 'funding' | 'review' | 'domain' | 'social';

/**
 * Stable short hash.
 *
 * Must stay byte-identical across versions: if sweep rows are ever
 * re-imported, the hashes have to line up or every item re-inserts as new.
 */
function hashItem(obj: unknown): string {
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36).slice(0, 8);
}

export { hashItem };

/**
 * Persist a batch of sweep items.
 *
 * Best-effort by design: one bad row should not fail an entire sweep, so
 * errors are logged and counted rather than thrown.
 */
export async function persistSweepItems(
  sweepType: SweepType,
  items: unknown[],
): Promise<{ written: number; failed: number }> {
  if (items.length === 0) return { written: 0, failed: 0 };

  const rows = items.map((item) => ({
    sweepType,
    itemHash: hashItem(item),
    payload: (item && typeof item === 'object' ? item : { value: item }) as Record<string, unknown>,
  }));

  try {
    const inserted = await db
      .insert(sweepItems)
      .values(rows)
      .onConflictDoNothing({ target: [sweepItems.sweepType, sweepItems.itemHash] })
      .returning({ id: sweepItems.id });

    // Items already seen inside the retention window are skipped, not failed —
    // re-ingesting the same funding announcement every hour is expected.
    return { written: inserted.length, failed: 0 };
  } catch (err) {
    console.error('[sweep-sink] insert failed:', err instanceof Error ? err.message : err);
    return { written: 0, failed: rows.length };
  }
}

export interface SweepItemRecord {
  sweepType: SweepType;
  payload: Record<string, unknown>;
  ingestedAt: string;
}

/** Read a sweep's recent items, newest first. */
export async function querySweepItems(
  sweepType: SweepType,
  opts: { since?: Date; limit?: number } = {},
): Promise<SweepItemRecord[]> {
  const rows = await db
    .select()
    .from(sweepItems)
    .where(
      opts.since
        ? and(eq(sweepItems.sweepType, sweepType), gte(sweepItems.ingestedAt, opts.since))
        : eq(sweepItems.sweepType, sweepType),
    )
    .orderBy(desc(sweepItems.ingestedAt))
    .limit(opts.limit ?? 100);

  return rows.map((row) => ({
    sweepType: row.sweepType as SweepType,
    payload: row.payload,
    ingestedAt: row.ingestedAt.toISOString(),
  }));
}

export interface SweepReadOptions {
  /** Epoch seconds. Defaults to seven days ago. */
  sinceEpochSeconds?: number;
  limit?: number;
}

/**
 * Recent items for one sweep type.
 *
 * Timestamps are epoch seconds, which is what the signals route that
 * consumes this expects.
 */
export async function readRecentSweepItems<T = unknown>(
  sweepType: SweepType,
  opts: SweepReadOptions = {},
): Promise<Array<{ payload: T; ingestedAt: string }>> {
  const sinceSeconds = opts.sinceEpochSeconds ?? Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const rows = await querySweepItems(sweepType, {
    since: new Date(sinceSeconds * 1000),
    limit: opts.limit ?? 200,
  });
  return rows.map((row) => ({ payload: row.payload as T, ingestedAt: row.ingestedAt }));
}

/** Everything across all sweep types, newest first. Backs the signals feed. */
export async function queryAllSweepItems(
  opts: { since?: Date; limit?: number } = {},
): Promise<SweepItemRecord[]> {
  const rows = await db
    .select()
    .from(sweepItems)
    .where(opts.since ? gte(sweepItems.ingestedAt, opts.since) : sql`true`)
    .orderBy(desc(sweepItems.ingestedAt))
    .limit(opts.limit ?? 200);

  return rows.map((row) => ({
    sweepType: row.sweepType as SweepType,
    payload: row.payload,
    ingestedAt: row.ingestedAt.toISOString(),
  }));
}

/** TTL sweep, called by the reaper cron. */
export async function deleteExpiredSweepItems(limit = 5000): Promise<number> {
  const deleted = await db.execute(sql`
    delete from sweep_items
    where id in (select id from sweep_items where expires_at < now() limit ${limit})
    returning id
  `);
  return deleted.rowCount ?? 0;
}
