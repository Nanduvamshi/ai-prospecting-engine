import 'server-only';

/**
 * Public-role registry.
 *
 * Companion to the email-keyed contact graph: records that a named person
 * holds a given title at a given company, pulled from public sources.
 * Enrichment consults it when it knows the company and the target title but
 * has no email, so it can pair a real name with a pattern match rather than
 * guessing blind.
 *
 * Rows expire after 180 days — public records go stale as people move.
 *
 * One capability note: the DynamoDB version partitioned on the company slug
 * and documented that reverse lookups ("where does this person work now")
 * were unsupported without adding a GSI. An ordinary index serves both
 * directions here, so `lookupPersonRoles` exists.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { publicRoles } from '@/server/db/schema';
import type { PublicContactRecord, PublicSource } from './types';

const TTL_MS = 180 * 24 * 60 * 60 * 1000;

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function rowToRecord(row: typeof publicRoles.$inferSelect): PublicContactRecord {
  return {
    company: row.company ?? '',
    name: row.name,
    title: row.title,
    source: (row.source ?? 'job-postings') as PublicSource,
    sourceUrl: row.sourceUrl ?? '',
    sourceKind: row.sourceKind ?? undefined,
    foundAt: row.ingestedAt.toISOString(),
    confidence: row.confidence ?? 0,
  };
}

export async function savePublicRoles(records: PublicContactRecord[]): Promise<number> {
  if (records.length === 0) return 0;

  const now = new Date();
  const expiresAt = new Date(Date.now() + TTL_MS);

  // Deduplicate within the batch first. Postgres refuses an INSERT that hits
  // the same conflict target twice in one statement, and public sources
  // genuinely do repeat the same person across filings.
  const byKey = new Map<string, typeof publicRoles.$inferInsert>();
  for (const rec of records) {
    const row = {
      companySlug: slug(rec.company || 'unknown'),
      titleSlug: slug(rec.title || 'unknown'),
      nameSlug: slug(rec.name || 'anon'),
      company: rec.company ?? null,
      name: rec.name ?? null,
      title: rec.title ?? null,
      source: rec.source ?? null,
      sourceUrl: rec.sourceUrl ?? null,
      sourceKind: rec.sourceKind ?? null,
      confidence: rec.confidence ?? 0,
      ingestedAt: now,
      expiresAt,
    };
    byKey.set(`${row.companySlug}|${row.titleSlug}|${row.nameSlug}`, row);
  }

  try {
    // One statement, no client-side batching.
    const saved = await db
      .insert(publicRoles)
      .values(Array.from(byKey.values()))
      .onConflictDoUpdate({
        target: [publicRoles.companySlug, publicRoles.titleSlug, publicRoles.nameSlug],
        set: {
          company: sql`excluded.company`,
          name: sql`excluded.name`,
          title: sql`excluded.title`,
          source: sql`excluded.source`,
          sourceUrl: sql`excluded.source_url`,
          sourceKind: sql`excluded.source_kind`,
          confidence: sql`excluded.confidence`,
          ingestedAt: sql`excluded.ingested_at`,
          expiresAt: sql`excluded.expires_at`,
        },
      })
      .returning({ companySlug: publicRoles.companySlug });

    return saved.length;
  } catch (err) {
    // Ingestion runs on a schedule and is best-effort: one bad batch must not
    // abort the whole sync.
    console.error('[public-roles] save failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}

/** Known public roles at a company, optionally narrowed by title prefix. */
export async function lookupPublicRoles(
  company: string,
  opts: { titlePrefix?: string; limit?: number } = {},
): Promise<PublicContactRecord[]> {
  try {
    const companySlug = slug(company);
    const rows = await db
      .select()
      .from(publicRoles)
      .where(
        opts.titlePrefix
          ? and(
              eq(publicRoles.companySlug, companySlug),
              sql`${publicRoles.titleSlug} like ${`${slug(opts.titlePrefix)}%`}`,
            )
          : eq(publicRoles.companySlug, companySlug),
      )
      .orderBy(desc(publicRoles.confidence))
      .limit(opts.limit ?? 20);

    return rows.map(rowToRecord);
  } catch {
    // Enrichment treats an empty result as "nothing known", which is the
    // right degradation for a supplementary source.
    return [];
  }
}

/** Where a person is known to hold a role — the reverse lookup. */
export async function lookupPersonRoles(name: string, limit = 10): Promise<PublicContactRecord[]> {
  try {
    const rows = await db
      .select()
      .from(publicRoles)
      .where(eq(publicRoles.nameSlug, slug(name)))
      .orderBy(desc(publicRoles.ingestedAt))
      .limit(limit);
    return rows.map(rowToRecord);
  } catch {
    return [];
  }
}

/** TTL sweep, called by the reaper cron. */
export async function deleteExpiredPublicRoles(limit = 5000): Promise<number> {
  const deleted = await db.execute(sql`
    delete from public_roles
    where (company_slug, title_slug, name_slug) in (
      select company_slug, title_slug, name_slug
      from public_roles where expires_at < now() limit ${limit}
    )
    returning company_slug
  `);
  return deleted.rowCount ?? 0;
}
