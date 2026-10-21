import 'server-only';

import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { db, withTx } from '@/server/db/client';
import { contacts, importBatches, prospects } from '@/server/db/schema';
import { decodeCursor, encodeCursor, sortForQuery, type CursorSort } from '@/server/db/cursor';
import { findDuplicates, type DuplicateMatch } from './duplicate-detection';
import { initialProspectScore, CONVERSION_SCORE_BONUS } from './initial-score';
import {
  generateContactId,
  generateProspectId,
  isValidSource,
  isValidStatus,
  type Contact,
  type Prospect,
  type ProspectSource,
  type ProspectStatus,
} from './types';

/**
 * Prospect persistence.
 *
 * Replaces an AWS Lambda that reached this application through a catch-all
 * proxy route. Two of its behaviours are worth calling out because they
 * changed:
 *
 *  - Listing without a status filter used to query all six statuses
 *    separately (up to 5,000 rows each), concatenate up to 30,000 rows,
 *    sort them in memory and slice by offset — because DynamoDB cannot merge
 *    cursors across partitions. One keyset query replaces it.
 *
 *  - Import de-duplication compared against a 500-row page of the *importing
 *    user's own* prospects, so a duplicate owned by a colleague sailed
 *    through. De-duplication is now org-wide and done in the database.
 */

type ProspectRow = typeof prospects.$inferSelect;

function rowToProspect(row: ProspectRow): Prospect {
  return {
    prospectId: row.prospectId,
    orgId: row.orgId,
    name: row.name,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    company: row.company ?? undefined,
    title: row.title ?? undefined,
    linkedinUrl: row.linkedinUrl ?? undefined,
    website: row.website ?? undefined,
    avatar: row.avatar ?? undefined,
    source: row.source as ProspectSource,
    status: row.status as ProspectStatus,
    score: row.score,
    notes: row.notes ?? undefined,
    tags: row.tags ?? [],
    enrichment: row.enrichment ?? undefined,
    enrichmentSources: row.enrichmentSources ?? undefined,
    lastActivityDate: row.lastActivityDate?.toISOString(),
    contactedAt: row.contactedAt?.toISOString(),
    convertedContactId: row.convertedContactId ?? undefined,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    importBatchId: row.importBatchId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Listing ──────────────────────────────────────────────────────────

export interface ListProspectsOptions {
  status?: string | string[] | null;
  source?: string | null;
  ownerId?: string | null;
  search?: string | null;
  /** Campaign tag. Every prospect carries the campaign that produced it, so
   *  runs months apart stay separable. */
  tag?: string | null;
  limit?: number;
  cursor?: string | null;
}

export interface ListProspectsResult {
  prospects: Prospect[];
  count: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export async function listProspects(
  orgId: string,
  opts: ListProspectsOptions = {},
): Promise<ListProspectsResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const statuses = (Array.isArray(opts.status) ? opts.status : opts.status ? [opts.status] : [])
    .filter(isValidStatus);

  const sort: CursorSort = sortForQuery({ status: statuses.length ? statuses : null });
  const cursor = decodeCursor(opts.cursor, sort);

  const filters: SQL[] = [eq(prospects.orgId, orgId)];

  if (statuses.length > 0) {
    // A single predicate across every selected status. The DynamoDB version
    // needed one query per status because a partition key takes one value.
    filters.push(inArray(prospects.status, statuses));
  }
  if (opts.source && isValidSource(opts.source)) {
    // Filtered in SQL. Previously this ran in application code *after*
    // pagination, so a page could come back short or empty while more
    // matching rows existed further down.
    filters.push(eq(prospects.source, opts.source));
  }
  if (opts.ownerId && opts.ownerId !== 'all') {
    filters.push(eq(prospects.ownerId, opts.ownerId));
  }
  if (opts.tag?.trim()) {
    // Array containment, so it hits the GIN index on tags rather than
    // unnesting every row.
    filters.push(sql`${prospects.tags} @> ARRAY[${opts.tag.trim()}]::text[]`);
  }
  if (opts.search?.trim()) {
    const needle = `%${opts.search.trim().toLowerCase()}%`;
    const match = or(
      sql`lower(${prospects.name}) like ${needle}`,
      sql`lower(coalesce(${prospects.email}, '')) like ${needle}`,
      sql`lower(coalesce(${prospects.company}, '')) like ${needle}`,
      sql`lower(coalesce(${prospects.title}, '')) like ${needle}`,
    );
    if (match) filters.push(match);
  }

  // Keyset predicate. The tie-break on prospectId is what keeps paging stable
  // when many rows share a score or a timestamp.
  if (cursor) {
    if (cursor.s === 'score') {
      const [score, id] = cursor.k;
      filters.push(sql`(${prospects.score}, ${prospects.prospectId}) < (${score}, ${id})`);
    } else {
      const [createdAt, id] = cursor.k;
      filters.push(
        sql`(${prospects.createdAt}, ${prospects.prospectId}) < (${new Date(createdAt)}, ${id})`,
      );
    }
  }

  const orderBy =
    sort === 'score'
      ? [desc(prospects.score), desc(prospects.prospectId)]
      : [desc(prospects.createdAt), desc(prospects.prospectId)];

  // Fetch one extra row to learn whether another page exists, without a
  // second COUNT query.
  const rows = await db
    .select()
    .from(prospects)
    .where(and(...filters))
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  const nextCursor =
    hasMore && last
      ? encodeCursor(
          sort === 'score'
            ? { v: 1, s: 'score', k: [last.score, last.prospectId] }
            : { v: 1, s: 'recent', k: [last.createdAt.toISOString(), last.prospectId] },
        )
      : null;

  return {
    prospects: page.map(rowToProspect),
    count: page.length,
    nextCursor,
    hasMore,
  };
}

export async function getProspect(orgId: string, prospectId: string): Promise<Prospect | null> {
  const rows = await db
    .select()
    .from(prospects)
    .where(and(eq(prospects.orgId, orgId), eq(prospects.prospectId, prospectId)))
    .limit(1);
  return rows[0] ? rowToProspect(rows[0]) : null;
}

/** Counts per status, for the stats header. One grouped query. */
export async function getProspectStats(orgId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: prospects.status, n: sql<number>`count(*)::int` })
    .from(prospects)
    .where(eq(prospects.orgId, orgId))
    .groupBy(prospects.status);

  const stats: Record<string, number> = { total: 0 };
  for (const row of rows) {
    stats[row.status] = row.n;
    stats.total += row.n;
  }
  return stats;
}

/**
 * Campaigns that currently have prospects, newest activity first.
 *
 * Derived from the tags themselves rather than kept in a separate table: a
 * campaign exists exactly as long as prospects carry its name, so deleting
 * the last one removes it from the filter with no cleanup step.
 */
export async function listCampaigns(
  orgId: string,
): Promise<Array<{ name: string; count: number }>> {
  const result = await db.execute<{ name: string; count: number }>(sql`
    select tag as name, count(*)::int as count
    from ${prospects}, unnest(tags) as tag
    where org_id = ${orgId}
    group by tag
    order by max(created_at) desc
  `);
  return result.rows.map((r) => ({ name: r.name, count: Number(r.count) }));
}

// ─── Writing ──────────────────────────────────────────────────────────

export interface CreateProspectInput {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  linkedinUrl?: string;
  website?: string;
  avatar?: string;
  source?: string;
  status?: string;
  notes?: string;
  tags?: string[];
  enrichment?: Record<string, unknown>;
  enrichmentSources?: Record<string, string>;
  /** Score assigned by the pipeline. Wins over the field heuristic. */
  aiScore?: number;
  importBatchId?: string;
}

export async function createProspect(
  orgId: string,
  owner: { userId: string; name: string },
  input: CreateProspectInput,
): Promise<Prospect> {
  const [row] = await db
    .insert(prospects)
    .values({
      prospectId: generateProspectId(),
      orgId,
      name: input.name,
      email: input.email?.trim().toLowerCase() || null,
      phone: input.phone ?? null,
      company: input.company ?? null,
      title: input.title ?? null,
      linkedinUrl: input.linkedinUrl ?? null,
      website: input.website ?? null,
      avatar: input.avatar ?? null,
      source: isValidSource(input.source) ? input.source : 'manual',
      status: isValidStatus(input.status) ? input.status : 'new',
      score: initialProspectScore(input, input.aiScore),
      notes: input.notes ?? null,
      tags: input.tags ?? [],
      enrichment: input.enrichment ?? null,
      enrichmentSources: input.enrichmentSources ?? null,
      ownerId: owner.userId,
      ownerName: owner.name,
      importBatchId: input.importBatchId ?? null,
    })
    .returning();

  return rowToProspect(row);
}

export type UpdateProspectInput = Partial<
  Pick<
    Prospect,
    | 'name' | 'email' | 'phone' | 'company' | 'title' | 'linkedinUrl' | 'website'
    | 'avatar' | 'notes' | 'tags' | 'score' | 'status' | 'source'
    | 'enrichment' | 'enrichmentSources' | 'ownerId' | 'ownerName'
  >
>;

export async function updateProspect(
  orgId: string,
  prospectId: string,
  updates: UpdateProspectInput,
): Promise<Prospect | null> {
  const patch: Partial<typeof prospects.$inferInsert> = { updatedAt: new Date() };

  // Explicit field-by-field rather than a spread: this is a request body, and
  // spreading it would let a caller set columns they have no business setting.
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.email !== undefined) patch.email = updates.email?.trim().toLowerCase() || null;
  if (updates.phone !== undefined) patch.phone = updates.phone ?? null;
  if (updates.company !== undefined) patch.company = updates.company ?? null;
  if (updates.title !== undefined) patch.title = updates.title ?? null;
  if (updates.linkedinUrl !== undefined) patch.linkedinUrl = updates.linkedinUrl ?? null;
  if (updates.website !== undefined) patch.website = updates.website ?? null;
  if (updates.avatar !== undefined) patch.avatar = updates.avatar ?? null;
  if (updates.notes !== undefined) patch.notes = updates.notes ?? null;
  if (updates.tags !== undefined) patch.tags = updates.tags ?? [];
  if (updates.enrichment !== undefined) patch.enrichment = updates.enrichment ?? null;
  if (updates.ownerId !== undefined) patch.ownerId = updates.ownerId;
  if (updates.ownerName !== undefined) patch.ownerName = updates.ownerName;
  if (updates.source !== undefined && isValidSource(updates.source)) patch.source = updates.source;
  if (updates.score !== undefined) {
    patch.score = Math.min(100, Math.max(0, Math.round(updates.score)));
  }

  if (updates.status !== undefined && isValidStatus(updates.status)) {
    patch.status = updates.status;
    // Moving to "contacted" is an activity in its own right, so both
    // timestamps are stamped here; the UI reads them.
    if (updates.status === 'contacted') {
      patch.contactedAt = new Date();
      patch.lastActivityDate = new Date();
    }
  }

  // Merge rather than replace, so enriching one field does not erase the
  // provenance recorded for the others.
  if (updates.enrichmentSources !== undefined) {
    patch.enrichmentSources = sql`coalesce(${prospects.enrichmentSources}, '{}'::jsonb) || ${JSON.stringify(
      updates.enrichmentSources ?? {},
    )}::jsonb` as unknown as Record<string, string>;
  }

  const [row] = await db
    .update(prospects)
    .set(patch)
    .where(and(eq(prospects.orgId, orgId), eq(prospects.prospectId, prospectId)))
    .returning();

  return row ? rowToProspect(row) : null;
}

/**
 * Record which provider populated which field.
 *
 * Merged into the prospect row. This used to be a separate "sister record" in
 * a different table, kept apart only because the prospect itself lived behind
 * an API Gateway proxy that the enrichment code could not write to. That
 * constraint is gone, so the provenance lives on the record it describes.
 *
 * Best-effort: losing a provenance badge must never fail an enrichment that
 * otherwise succeeded.
 */
export async function saveEnrichmentSources(
  orgId: string,
  prospectId: string,
  sources: Record<string, string>,
): Promise<void> {
  if (!sources || Object.keys(sources).length === 0) return;
  await db
    .update(prospects)
    .set({
      enrichmentSources: sql`coalesce(${prospects.enrichmentSources}, '{}'::jsonb) || ${JSON.stringify(sources)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(prospects.orgId, orgId), eq(prospects.prospectId, prospectId)));
}

export async function getEnrichmentSources(
  orgId: string,
  prospectId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ sources: prospects.enrichmentSources })
    .from(prospects)
    .where(and(eq(prospects.orgId, orgId), eq(prospects.prospectId, prospectId)))
    .limit(1);
  return rows[0]?.sources ?? {};
}

/** Apply enriched field values to a prospect, without overwriting what is set. */
export async function applyEnrichment(
  orgId: string,
  prospectId: string,
  fields: Record<string, string>,
  sources?: Record<string, string>,
): Promise<Prospect | null> {
  const allowed = ['email', 'phone', 'title', 'company', 'linkedinUrl', 'website', 'avatar'] as const;
  const patch: Partial<typeof prospects.$inferInsert> = { updatedAt: new Date() };

  for (const key of allowed) {
    const value = fields[key];
    if (!value) continue;
    // coalesce: enrichment fills gaps, it does not overrule a human.
    patch[key] = sql`coalesce(nullif(${prospects[key]}, ''), ${value})` as never;
  }

  if (sources && Object.keys(sources).length > 0) {
    patch.enrichmentSources = sql`coalesce(${prospects.enrichmentSources}, '{}'::jsonb) || ${JSON.stringify(sources)}::jsonb` as never;
  }

  const [row] = await db
    .update(prospects)
    .set(patch)
    .where(and(eq(prospects.orgId, orgId), eq(prospects.prospectId, prospectId)))
    .returning();

  return row ? rowToProspect(row) : null;
}

export async function deleteProspect(orgId: string, prospectId: string): Promise<boolean> {
  const deleted = await db
    .delete(prospects)
    .where(and(eq(prospects.orgId, orgId), eq(prospects.prospectId, prospectId)))
    .returning({ prospectId: prospects.prospectId });
  return deleted.length > 0;
}

export async function bulkUpdateProspects(
  orgId: string,
  prospectIds: string[],
  updates: UpdateProspectInput,
): Promise<number> {
  if (prospectIds.length === 0) return 0;
  const patch: Partial<typeof prospects.$inferInsert> = { updatedAt: new Date() };
  if (updates.status !== undefined && isValidStatus(updates.status)) patch.status = updates.status;
  if (updates.ownerId !== undefined) patch.ownerId = updates.ownerId;
  if (updates.ownerName !== undefined) patch.ownerName = updates.ownerName;
  if (updates.tags !== undefined) patch.tags = updates.tags;

  const updated = await db
    .update(prospects)
    .set(patch)
    .where(and(eq(prospects.orgId, orgId), inArray(prospects.prospectId, prospectIds)))
    .returning({ prospectId: prospects.prospectId });

  return updated.length;
}

export async function bulkDeleteProspects(orgId: string, prospectIds: string[]): Promise<number> {
  if (prospectIds.length === 0) return 0;
  const deleted = await db
    .delete(prospects)
    .where(and(eq(prospects.orgId, orgId), inArray(prospects.prospectId, prospectIds)))
    .returning({ prospectId: prospects.prospectId });
  return deleted.length;
}

// ─── Duplicate detection ──────────────────────────────────────────────

/**
 * Candidate rows a new prospect might duplicate.
 *
 * Narrowed in SQL to rows sharing an email, a phone, or a company — so the
 * fuzzy name comparison in `findDuplicates` runs over a handful of rows
 * rather than a paged slice of the table.
 */
async function duplicateCandidates(
  orgId: string,
  target: { name?: string; email?: string; phone?: string; company?: string },
): Promise<Array<{ prospectId: string; name: string; email?: string; phone?: string; companyName?: string }>> {
  const predicates: SQL[] = [];
  if (target.email) {
    predicates.push(sql`lower(${prospects.email}) = ${target.email.trim().toLowerCase()}`);
  }
  if (target.phone) {
    // Match on the last ten digits, the same normalisation findDuplicates uses.
    const digits = target.phone.replace(/[^\d]/g, '').slice(-10);
    if (digits.length >= 7) {
      predicates.push(sql`right(regexp_replace(coalesce(${prospects.phone}, ''), '[^0-9]', '', 'g'), 10) = ${digits}`);
    }
  }
  if (target.company) {
    predicates.push(sql`lower(coalesce(${prospects.company}, '')) = ${target.company.trim().toLowerCase()}`);
  }
  if (predicates.length === 0) return [];

  const combined = or(...predicates);
  const rows = await db
    .select({
      prospectId: prospects.prospectId,
      name: prospects.name,
      email: prospects.email,
      phone: prospects.phone,
      company: prospects.company,
    })
    .from(prospects)
    .where(combined ? and(eq(prospects.orgId, orgId), combined) : eq(prospects.orgId, orgId))
    .limit(200);

  return rows.map((r) => ({
    prospectId: r.prospectId,
    name: r.name,
    email: r.email ?? undefined,
    phone: r.phone ?? undefined,
    companyName: r.company ?? undefined,
  }));
}

export async function checkDuplicates(
  orgId: string,
  target: { name?: string; email?: string; phone?: string; company?: string },
  excludeId?: string,
): Promise<DuplicateMatch[]> {
  const candidates = await duplicateCandidates(orgId, target);
  return findDuplicates(
    { name: target.name, email: target.email, phone: target.phone, companyName: target.company },
    candidates,
    excludeId,
  );
}

// ─── Conversion ───────────────────────────────────────────────────────

export type ConvertResult =
  | { ok: true; contact: Contact }
  | { ok: false; reason: 'not_found' | 'already_converted' | 'no_email' | 'contact_exists' };

/**
 * Convert a prospect into a contact.
 *
 * Transactional: writing the contact and then updating the prospect in a
 * separate call would let a failure between the two leave an orphaned contact
 * and a prospect that still looked unconverted.
 */
export async function convertProspectToContact(
  orgId: string,
  prospectId: string,
  actor: { userId: string; name: string },
): Promise<ConvertResult> {
  return withTx(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.orgId, orgId), eq(prospects.prospectId, prospectId)))
      .limit(1)
      .for('update');

    const row = rows[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status === 'converted') return { ok: false, reason: 'already_converted' };
    if (!row.email) return { ok: false, reason: 'no_email' };

    const contactId = generateContactId();
    const score = Math.min(row.score + CONVERSION_SCORE_BONUS, 100);

    const inserted = await tx
      .insert(contacts)
      .values({
        contactId,
        orgId,
        name: row.name,
        email: row.email,
        phone: row.phone,
        companyName: row.company,
        jobTitle: row.title,
        website: row.website,
        status: 'lead',
        lifecycle: 'lead',
        score,
        tags: row.tags ?? [],
        convertedFromProspectId: prospectId,
        ownerId: actor.userId,
        ownerName: actor.name,
      })
      // A unique index on (org, lower(email)) means converting two prospects
      // that share an address is a conflict, not a silent duplicate.
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) return { ok: false, reason: 'contact_exists' };

    await tx
      .update(prospects)
      .set({ status: 'converted', convertedContactId: contactId, updatedAt: new Date() })
      .where(and(eq(prospects.orgId, orgId), eq(prospects.prospectId, prospectId)));

    const c = inserted[0];
    return {
      ok: true,
      contact: {
        contactId: c.contactId,
        orgId: c.orgId,
        name: c.name,
        email: c.email,
        phone: c.phone ?? undefined,
        companyName: c.companyName ?? undefined,
        jobTitle: c.jobTitle ?? undefined,
        website: c.website ?? undefined,
        status: c.status,
        lifecycle: c.lifecycle,
        score: c.score,
        tags: c.tags ?? [],
        convertedFromProspectId: c.convertedFromProspectId ?? undefined,
        ownerId: c.ownerId,
        ownerName: c.ownerName,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      },
    };
  });
}

// ─── Bulk import ──────────────────────────────────────────────────────

export interface ImportRow {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  linkedinUrl?: string;
  website?: string;
  avatar?: string;
  notes?: string;
  tags?: string[];
  source?: string;
  status?: string;
  score?: number;
}

export interface ImportOutcome {
  batchId: string;
  created: number;
  failed: number;
  skipped: number;
  errors: string[];
  duplicates: string[];
  prospects: Array<{ prospectId: string; name: string }>;
}

/**
 * Import a batch of prospects.
 *
 * De-duplicates against the whole organisation and within the batch itself,
 * records a batch row so the import can be undone, and reports per-row
 * failures rather than aborting.
 */
export async function importProspects(
  orgId: string,
  actor: { userId: string; name: string },
  rows: ImportRow[],
  opts: {
    filename?: string;
    onProgress?: (done: number, total: number) => void;
    /** Reuse a batch created earlier. The background import path creates the
     *  batch up front so the client has an id to subscribe with before any
     *  work begins; without this it would end up with two. */
    batchId?: string;
  } = {},
): Promise<ImportOutcome> {
  const batchId =
    opts.batchId ??
    (await createImportBatch(orgId, actor, {
      filename: opts.filename,
      totalRows: rows.length,
    }));

  const errors: string[] = [];
  const duplicates: string[] = [];
  const created: Array<{ prospectId: string; name: string }> = [];

  // Accumulates rows accepted so far, so two identical rows inside one file
  // do not both get through.
  const seenInBatch: Array<{
    prospectId: string; name: string; email?: string; phone?: string; companyName?: string;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    if (opts.onProgress && i % 10 === 0) opts.onProgress(i, rows.length);

    if (!row.name?.trim()) {
      errors.push(`Row ${rowNum}: Name is required`);
      continue;
    }

    const existing = await duplicateCandidates(orgId, {
      name: row.name, email: row.email, phone: row.phone, company: row.company,
    });
    const matches = findDuplicates(
      { name: row.name, email: row.email, phone: row.phone, companyName: row.company },
      [...existing, ...seenInBatch],
    );

    if (matches.length > 0) {
      const m = matches[0];
      duplicates.push(
        `Row ${rowNum} (${row.name}): Matches "${m.name}" by ${m.matchType} (${m.confidence}%)`,
      );
      continue;
    }

    try {
      const prospect = await createProspect(orgId, actor, {
        ...row,
        name: row.name,
        source: row.source ?? 'import',
        aiScore: row.score,
        importBatchId: batchId,
      });
      created.push({ prospectId: prospect.prospectId, name: prospect.name });
      seenInBatch.push({
        prospectId: prospect.prospectId,
        name: prospect.name,
        email: prospect.email,
        phone: prospect.phone,
        companyName: prospect.company,
      });
    } catch (err) {
      errors.push(
        `Row ${rowNum} (${row.name}): Failed to save — ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }

  opts.onProgress?.(rows.length, rows.length);

  await completeImportBatch(orgId, batchId, {
    imported: created.length,
    skipped: errors.length,
    duplicates: duplicates.length,
  });

  return {
    batchId,
    created: created.length,
    failed: errors.length,
    skipped: duplicates.length,
    errors,
    duplicates,
    prospects: created,
  };
}

// ─── Import batches ───────────────────────────────────────────────────

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function createImportBatch(
  orgId: string,
  actor: { userId: string; name: string },
  opts: { filename?: string; totalRows: number },
): Promise<string> {
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await db.insert(importBatches).values({
    batchId,
    orgId,
    userId: actor.userId,
    filename: opts.filename ?? null,
    totalRows: opts.totalRows,
    status: 'running',
    progress: { phase: 'starting', processed: 0, total: opts.totalRows },
  });
  return batchId;
}

/**
 * Publish import progress.
 *
 * Written to the row rather than held in memory: the SSE reader and the
 * importer can land on different instances, so in-process state would leave
 * the browser watching a progress bar that never moves.
 */
export async function updateImportProgress(
  orgId: string,
  batchId: string,
  progress: Record<string, unknown>,
): Promise<void> {
  await db
    .update(importBatches)
    .set({ progress })
    .where(and(eq(importBatches.orgId, orgId), eq(importBatches.batchId, batchId)));
}

export async function completeImportBatch(
  orgId: string,
  batchId: string,
  totals: { imported: number; skipped: number; duplicates: number },
): Promise<void> {
  await db
    .update(importBatches)
    .set({
      imported: totals.imported,
      skipped: totals.skipped,
      duplicates: totals.duplicates,
      status: 'completed',
      completedAt: new Date(),
      progress: { phase: 'complete', ...totals },
    })
    .where(and(eq(importBatches.orgId, orgId), eq(importBatches.batchId, batchId)));
}

export async function failImportBatch(
  orgId: string,
  batchId: string,
  message: string,
): Promise<void> {
  await db
    .update(importBatches)
    .set({ status: 'failed', errorMessage: message, completedAt: new Date() })
    .where(and(eq(importBatches.orgId, orgId), eq(importBatches.batchId, batchId)));
}

export async function getImportBatch(orgId: string, batchId: string) {
  const rows = await db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.orgId, orgId), eq(importBatches.batchId, batchId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listImportHistory(orgId: string, limit = 50) {
  const rows = await db
    .select()
    .from(importBatches)
    .where(eq(importBatches.orgId, orgId))
    .orderBy(desc(importBatches.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    batchId: row.batchId,
    timestamp: row.createdAt.toISOString(),
    userId: row.userId,
    filename: row.filename ?? undefined,
    importedCount: row.imported,
    failedCount: row.skipped,
    skippedCount: row.duplicates,
    status: row.status,
    undone: Boolean(row.undoneAt),
    canUndo:
      !row.undoneAt &&
      row.status === 'completed' &&
      row.imported > 0 &&
      Date.now() - row.createdAt.getTime() < UNDO_WINDOW_MS,
  }));
}

export type UndoResult =
  | { ok: true; deleted: number }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_undone' };

/**
 * Undo an import.
 *
 * One statement, because prospects carry the batch id as a foreign key. The
 * original stored an array of ids on the history record and deleted them one
 * at a time, tolerating partial failure.
 *
 * Prospects edited since the import are still removed: the undo reverses the
 * import as an event. Anything else would leave rows that no longer belong to
 * a batch and cannot be undone later.
 */
export async function undoImport(orgId: string, batchId: string): Promise<UndoResult> {
  return withTx(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(importBatches)
      .where(and(eq(importBatches.orgId, orgId), eq(importBatches.batchId, batchId)))
      .limit(1)
      .for('update');

    const batch = rows[0];
    if (!batch) return { ok: false, reason: 'not_found' };
    if (batch.undoneAt) return { ok: false, reason: 'already_undone' };
    if (Date.now() - batch.createdAt.getTime() >= UNDO_WINDOW_MS) {
      return { ok: false, reason: 'expired' };
    }

    const deleted = await tx
      .delete(prospects)
      .where(and(eq(prospects.orgId, orgId), eq(prospects.importBatchId, batchId)))
      .returning({ prospectId: prospects.prospectId });

    await tx
      .update(importBatches)
      .set({ undoneAt: new Date(), status: 'undone' })
      .where(and(eq(importBatches.orgId, orgId), eq(importBatches.batchId, batchId)));

    return { ok: true, deleted: deleted.length };
  });
}

/** Housekeeping for import batches whose writer died mid-run. */
export async function reapStalledImports(olderThanMinutes = 30): Promise<number> {
  const reaped = await db
    .update(importBatches)
    .set({ status: 'failed', errorMessage: 'Import stopped unexpectedly.', completedAt: new Date() })
    .where(
      and(
        eq(importBatches.status, 'running'),
        isNull(importBatches.completedAt),
        lt(importBatches.createdAt, sql`now() - make_interval(mins => ${olderThanMinutes})`),
      ),
    )
    .returning({ batchId: importBatches.batchId });
  return reaped.length;
}
