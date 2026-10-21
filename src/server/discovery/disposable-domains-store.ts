import 'server-only';

import { eq, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { disposableDomains } from '@/server/db/schema';

/**
 * Disposable-domain blocklist.
 *
 * Populated daily from the upstream disposable-email-domains list, read
 * lazily by the email verifier on first use and refreshed every few hours.
 *
 * Stored as a single row holding the whole array, behind a plain `string[]`
 * interface. The upstream list runs to roughly a hundred thousand domains —
 * well past what many key-value stores allow in one item. Postgres has
 * no such limit, so the same shape is now actually correct.
 */

const SINGLETON_ID = 1;

export interface DisposableDomainsRecord {
  domains: string[];
  updatedAt: string;
  source: string;
}

export async function getDisposableDomainsRecord(): Promise<DisposableDomainsRecord | null> {
  try {
    const rows = await db
      .select()
      .from(disposableDomains)
      .where(eq(disposableDomains.id, SINGLETON_ID))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      domains: row.domains ?? [],
      updatedAt: row.updatedAt.toISOString(),
      source: row.source,
    };
  } catch (err) {
    // The verifier treats a null here as "no blocklist available" and falls
    // back to its built-in list, so a database hiccup degrades rather than
    // breaks verification.
    console.error(
      '[disposable-domains] read failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function saveDisposableDomainsRecord(
  domains: string[],
  source = 'github',
): Promise<number> {
  const clean = Array.from(
    new Set(domains.map((d) => d.toLowerCase().trim()).filter(Boolean)),
  );

  await db
    .insert(disposableDomains)
    .values({ id: SINGLETON_ID, domains: clean, count: clean.length, source, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: disposableDomains.id,
      set: {
        domains: clean,
        count: clean.length,
        source,
        updatedAt: new Date(),
      },
    });

  return clean.length;
}

/** Row count without transferring the whole list. */
export async function getDisposableDomainsCount(): Promise<number> {
  const rows = await db
    .select({ count: disposableDomains.count })
    .from(disposableDomains)
    .where(eq(disposableDomains.id, SINGLETON_ID))
    .limit(1);
  return rows[0]?.count ?? 0;
}

/** Membership test that avoids pulling the array into the app. */
export async function isDisposableDomain(domain: string): Promise<boolean> {
  const needle = domain.toLowerCase().trim();
  if (!needle) return false;
  const result = await db.execute(sql`
    select 1 from disposable_domains
    where id = ${SINGLETON_ID} and domains @> ${JSON.stringify([needle])}::jsonb
    limit 1
  `);
  return (result.rowCount ?? 0) > 0;
}
