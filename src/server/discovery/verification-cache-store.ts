import 'server-only';

import { createHash } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { emailVerificationCache } from '@/server/db/schema';
import type { DetailedResult, DetailedStatus } from './email-verification';

/**
 * Shared verification-result cache.
 *
 * Every definitive verification result, across all orgs, lands here so the
 * same address is not re-probed inside the TTL window. That is both a cost
 * saving on paid verification calls and a reputation win — fewer SMTP probes
 * hitting the same mail exchanger.
 *
 * The email is SHA-256 hashed before storage. Bounding key size is part of
 * it, but mainly it means the cache never holds a readable address.
 */

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Lowercase, trim, SHA-256 hex. Unchanged — hashes must stay comparable. */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export interface CachedVerification {
  status: DetailedStatus;
  reason: string;
  mxUsed?: string;
  source: 'bouncer' | 'fleet' | 'in-process';
  cachedAt: string;
  emailHash: string;
}

/**
 * Which results are stable enough to cache.
 *
 * Transient unknowns — greylisting, rate limits, transport errors — are
 * deliberately excluded so the next caller gets a live probe instead of a
 * cached shrug.
 */
const STABLE_UNKNOWN_REASONS = new Set(['bad_format', 'mx_none', 'disposable', 'big_provider']);

export function isCacheableResult(result: DetailedResult): boolean {
  if (result.status === 'verified' || result.status === 'invalid' || result.status === 'catch-all') {
    return true;
  }
  if (result.status === 'unknown') return STABLE_UNKNOWN_REASONS.has(result.reason);
  return false;
}

export async function getCachedVerification(email: string): Promise<CachedVerification | null> {
  if (process.env.VERIFICATION_CACHE_DISABLED === 'true') return null;

  const h = hashEmail(email);
  try {
    const rows = await db
      .select()
      .from(emailVerificationCache)
      .where(eq(emailVerificationCache.emailHash, h))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    // Expired but not yet reaped counts as a miss. The reaper runs daily, so
    // rows can outlive their TTL by up to a day.
    if (row.expiresAt.getTime() < Date.now()) return null;

    return {
      status: row.status as DetailedStatus,
      reason: row.reason,
      mxUsed: row.mxUsed ?? undefined,
      source: row.source as CachedVerification['source'],
      cachedAt: row.cachedAt.toISOString(),
      emailHash: row.emailHash,
    };
  } catch {
    // Best-effort: a cache failure must never fail a verification.
    return null;
  }
}

export async function saveCachedVerification(
  email: string,
  result: DetailedResult,
  source: CachedVerification['source'],
): Promise<void> {
  if (!isCacheableResult(result)) return;
  if (process.env.VERIFICATION_CACHE_DISABLED === 'true') return;

  const h = hashEmail(email);
  const now = new Date();
  try {
    await db
      .insert(emailVerificationCache)
      .values({
        emailHash: h,
        status: result.status,
        reason: result.reason,
        mxUsed: result.mxUsed ?? null,
        source,
        cachedAt: now,
        expiresAt: new Date(now.getTime() + TTL_MS),
      })
      .onConflictDoUpdate({
        target: emailVerificationCache.emailHash,
        set: {
          status: result.status,
          reason: result.reason,
          mxUsed: result.mxUsed ?? null,
          source,
          cachedAt: now,
          expiresAt: new Date(now.getTime() + TTL_MS),
        },
      });
  } catch {
    // Swallow — same reasoning as the read path.
  }
}

/** TTL sweep, called by the reaper cron. */
export async function deleteExpiredVerifications(limit = 5000): Promise<number> {
  const deleted = await db.execute(sql`
    delete from email_verification_cache
    where email_hash in (
      select email_hash from email_verification_cache where expires_at < now() limit ${limit}
    )
    returning email_hash
  `);
  return deleted.rowCount ?? 0;
}
