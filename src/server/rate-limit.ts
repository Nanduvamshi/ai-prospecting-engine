import 'server-only';

import { sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { integer } from '@/server/env';

/**
 * Rate limiting backed by the database.
 *
 * Counters in a module-level Map would work for exactly one process: with
 * two instances behind a load balancer a caller
 * gets double the intended allowance, and every deploy resets everyone's
 * budget to zero.
 *
 * This matters more here than it would elsewhere, because the endpoint it
 * guards is unauthenticated and every request spends real money — LLM tokens
 * and search API credits. An in-memory limiter on a public, cost-bearing
 * endpoint is a bill waiting to happen.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: Date;
}

/**
 * Consume one unit from a fixed window.
 *
 * The whole check-and-increment is a single upsert, so two concurrent
 * requests cannot both read the same count and both decide there was room.
 * The window advances by resetting the counter when the stored window start
 * has aged out.
 */
export async function consumeRateLimit(
  bucketKey: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const rows = await db.execute<{ count: number; window_start: Date }>(sql`
    insert into tool_rate_limits (bucket_key, window_start, count)
    values (${bucketKey}, now(), 1)
    on conflict (bucket_key) do update
      set count = case
            when tool_rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
              then 1
            else tool_rate_limits.count + 1
          end,
          window_start = case
            when tool_rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
              then now()
            else tool_rate_limits.window_start
          end
    returning count, window_start
  `);

  const row = rows.rows[0];
  const count = row?.count ?? 1;
  const windowStart = row?.window_start ? new Date(row.window_start) : new Date();

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    limit,
    resetAt: new Date(windowStart.getTime() + windowSeconds * 1000),
  };
}

/**
 * The global daily ceiling for the public lead finder.
 *
 * Separate from the per-caller limit and deliberately so: per-IP limiting
 * does nothing against a distributed caller, and this endpoint is a free,
 * unauthenticated way to spend the operator's money. One cap over everyone
 * bounds the worst case.
 */
export async function consumeGlobalDailyCap(feature: string): Promise<RateLimitResult> {
  const cap = integer('LEAD_FINDER_DAILY_CAP', 200);
  return consumeRateLimit(`global:${feature}:${new Date().toISOString().slice(0, 10)}`, cap, 86_400);
}

/** Best-effort caller identity from proxy headers. */
export function callerKey(request: Request, feature: string): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  return `${feature}:${ip}`;
}
