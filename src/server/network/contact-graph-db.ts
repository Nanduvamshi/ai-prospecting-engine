import 'server-only';

import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, withTx } from '@/server/db/client';
import { cgContacts, cgContributions, cgOrgParticipation, cgVerifications } from '@/server/db/schema';
import { contactHashForEmail } from './dedup';
import { currentConfidence } from './freshness';
import { CONTACT_TTL_SECONDS, INITIAL_CONFIDENCE } from './config';
import type {
  ContactRecord,
  ContactContribution,
  ContactVerification,
  OrgContactGraphParticipation,
  ExtractedSignature,
} from './types';

/**
 * Contact graph storage.
 *
 * The DynamoDB layout faked a one-to-many by prefixing sort keys under a
 * single partition per contact: `META`, `CONTRIB#<org>#<user>`,
 * `VERIFICATION#<timestamp>`. Relationally those are three tables, which is
 * what they are now — and the operation that mattered most gets dramatically
 * better as a result. Erasing a user's contributions was a full-table Scan
 * plus batched deletes; it is now one indexed statement.
 *
 * Privacy is unchanged: the raw email is stored on the contact row because
 * re-verification needs it, but identity is keyed on a SHA-256 hash, so no
 * address ever appears in a primary key.
 */

const ttlDate = () => new Date(Date.now() + CONTACT_TTL_SECONDS * 1000);

// ─── Org participation ───────────────────────────────────────────────

export async function getOrgParticipation(orgId: string): Promise<OrgContactGraphParticipation> {
  const rows = await db
    .select()
    .from(cgOrgParticipation)
    .where(eq(cgOrgParticipation.orgId, orgId))
    .limit(1);

  const row = rows[0];
  // Absence means opted out. The graph is opt-in by design: an org must
  // actively choose to contribute before anything of theirs is shared.
  if (!row) return { orgId, optedIn: false };

  return {
    orgId,
    optedIn: row.optedIn,
    optedInAt: row.optedInAt?.toISOString(),
    optedInBy: row.optedInBy ?? undefined,
    optedOutAt: row.optedOutAt?.toISOString(),
    optedOutBy: row.optedOutBy ?? undefined,
  };
}

export async function setOrgParticipation(opts: {
  orgId: string;
  optedIn: boolean;
  actorUserId: string;
}): Promise<void> {
  const now = new Date();
  const existing = await getOrgParticipation(opts.orgId);

  const values = {
    orgId: opts.orgId,
    optedIn: opts.optedIn,
    optedInAt: opts.optedIn ? now : existing.optedInAt ? new Date(existing.optedInAt) : null,
    optedInBy: opts.optedIn ? opts.actorUserId : (existing.optedInBy ?? null),
    optedOutAt: opts.optedIn ? (existing.optedOutAt ? new Date(existing.optedOutAt) : null) : now,
    optedOutBy: opts.optedIn ? (existing.optedOutBy ?? null) : opts.actorUserId,
  };

  await db
    .insert(cgOrgParticipation)
    .values(values)
    .onConflictDoUpdate({ target: cgOrgParticipation.orgId, set: values });
}

// ─── Contacts ────────────────────────────────────────────────────────

type ContactRow = typeof cgContacts.$inferSelect;

function rowToContact(row: ContactRow): ContactRecord {
  return {
    contactHash: row.contactHash,
    email: row.email,
    name: row.name ?? undefined,
    title: row.title ?? undefined,
    company: row.company ?? undefined,
    companyDomain: row.companyDomain ?? undefined,
    phone: row.phone ?? undefined,
    linkedinUrl: row.linkedinUrl ?? undefined,
    confidenceScore: row.confidenceScore,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt?.toISOString(),
    sightingCount: row.sightingCount,
  };
}

export async function getContact(contactHash: string): Promise<ContactRecord | null> {
  const rows = await db
    .select()
    .from(cgContacts)
    .where(eq(cgContacts.contactHash, contactHash))
    .limit(1);
  return rows[0] ? rowToContact(rows[0]) : null;
}

export async function getContactByEmail(email: string): Promise<ContactRecord | null> {
  return getContact(contactHashForEmail(email));
}

/**
 * Insert or merge a contact.
 *
 * Merge semantics: a newly observed non-null field wins, fields the new
 * sighting did not carry are left alone, the sighting count increments and
 * lastSeenAt moves forward.
 *
 * It is a single statement on purpose. Reading the record, merging in
 * application code and writing it back would let two sightings arriving
 * together each read the same count and both write the same incremented
 * value, losing one. `excluded` plus a SQL-side increment makes that
 * impossible.
 */
export async function upsertContact(extracted: ExtractedSignature): Promise<ContactRecord> {
  const contactHash = contactHashForEmail(extracted.email);
  const now = new Date();

  const [row] = await db
    .insert(cgContacts)
    .values({
      contactHash,
      email: extracted.email,
      name: extracted.name ?? null,
      title: extracted.title ?? null,
      company: extracted.company ?? null,
      phone: extracted.phone ?? null,
      linkedinUrl: extracted.linkedinUrl ?? null,
      confidenceScore: INITIAL_CONFIDENCE,
      sightingCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      expiresAt: ttlDate(),
    })
    .onConflictDoUpdate({
      target: cgContacts.contactHash,
      set: {
        name: sql`coalesce(excluded.name, ${cgContacts.name})`,
        title: sql`coalesce(excluded.title, ${cgContacts.title})`,
        company: sql`coalesce(excluded.company, ${cgContacts.company})`,
        phone: sql`coalesce(excluded.phone, ${cgContacts.phone})`,
        linkedinUrl: sql`coalesce(excluded.linkedin_url, ${cgContacts.linkedinUrl})`,
        lastSeenAt: now,
        sightingCount: sql`${cgContacts.sightingCount} + 1`,
        expiresAt: ttlDate(),
      },
    })
    .returning();

  return rowToContact(row);
}

// ─── Contributions ───────────────────────────────────────────────────

export async function recordContribution(
  contribution: Omit<ContactContribution, 'firstSeenAt' | 'lastSeenAt'>,
): Promise<void> {
  const now = new Date();
  await db
    .insert(cgContributions)
    .values({
      contactHash: contribution.contactHash,
      orgId: contribution.orgId,
      userId: contribution.userId,
      source: contribution.source,
      sourceRef: contribution.sourceRef ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [cgContributions.contactHash, cgContributions.orgId, cgContributions.userId],
      // A repeat sighting refreshes recency but must never rewrite firstSeenAt.
      set: { lastSeenAt: now, sourceRef: contribution.sourceRef ?? null },
    });
}

function rowToContribution(row: typeof cgContributions.$inferSelect): ContactContribution {
  return {
    contactHash: row.contactHash,
    orgId: row.orgId,
    userId: row.userId,
    source: row.source as ContactContribution['source'],
    sourceRef: row.sourceRef ?? undefined,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

export async function getContributors(contactHash: string): Promise<ContactContribution[]> {
  const rows = await db
    .select()
    .from(cgContributions)
    .where(eq(cgContributions.contactHash, contactHash));
  return rows.map(rowToContribution);
}

/**
 * How many distinct contributors have seen this contact.
 *
 * A real aggregate rather than a denormalised counter on the record — a
 * counter that can drift is worse than a cheap COUNT.
 */
export async function countContributors(contactHash: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(cgContributions)
    .where(eq(cgContributions.contactHash, contactHash));
  return rows[0]?.n ?? 0;
}

/** Whether the calling org contributed this contact — gates reciprocal access. */
export async function callerContributed(contactHash: string, orgId: string): Promise<boolean> {
  const rows = await db
    .select({ orgId: cgContributions.orgId })
    .from(cgContributions)
    .where(and(eq(cgContributions.contactHash, contactHash), eq(cgContributions.orgId, orgId)))
    .limit(1);
  return rows.length > 0;
}

// ─── Verifications ───────────────────────────────────────────────────

export async function recordVerification(v: ContactVerification): Promise<void> {
  const verifiedAt = new Date(v.verifiedAt);
  await withTx(null, async (tx) => {
    await tx
      .insert(cgVerifications)
      .values({
        contactHash: v.contactHash,
        verifiedAt,
        result: v.result,
        markForDeletion: v.markForDeletion ?? false,
      })
      .onConflictDoNothing();

    await tx
      .update(cgContacts)
      .set({ lastVerifiedAt: verifiedAt })
      .where(eq(cgContacts.contactHash, v.contactHash));
  });
}

// ─── Erasure and export ──────────────────────────────────────────────

export async function deleteUserContribution(
  contactHash: string,
  orgId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(cgContributions)
    .where(
      and(
        eq(cgContributions.contactHash, contactHash),
        eq(cgContributions.orgId, orgId),
        eq(cgContributions.userId, userId),
      ),
    );
}

/**
 * Erase everything a user contributed (GDPR right to erasure).
 *
 * A single indexed DELETE, fast enough to serve inline rather than as a
 * background job, followed by a sweep of any contact nobody
 * vouches for any more.
 */
export async function deleteAllForUser(orgId: string, userId: string): Promise<number> {
  return withTx(orgId, async (tx) => {
    const deleted = await tx
      .delete(cgContributions)
      .where(and(eq(cgContributions.orgId, orgId), eq(cgContributions.userId, userId)))
      .returning({ contactHash: cgContributions.contactHash });

    if (deleted.length === 0) return 0;

    // A contact with no remaining contributors has no basis to exist — the
    // record was only ever other people's sightings.
    const touched = Array.from(new Set(deleted.map((d) => d.contactHash)));
    const survivors = await tx
      .select({ contactHash: cgContributions.contactHash })
      .from(cgContributions)
      .where(inArray(cgContributions.contactHash, touched));

    const stillReferenced = new Set(survivors.map((s) => s.contactHash));
    const orphaned = touched.filter((h) => !stillReferenced.has(h));
    if (orphaned.length > 0) {
      // Verifications cascade via the foreign key.
      await tx.delete(cgContacts).where(inArray(cgContacts.contactHash, orphaned));
    }

    return deleted.length;
  });
}

/** Everything a user contributed (GDPR right of access). */
export async function exportUserData(
  orgId: string,
  userId: string,
): Promise<{ contributions: ContactContribution[]; contacts: ContactRecord[] }> {
  const contributionRows = await db
    .select()
    .from(cgContributions)
    .where(and(eq(cgContributions.orgId, orgId), eq(cgContributions.userId, userId)))
    .orderBy(desc(cgContributions.lastSeenAt));

  const contributions = contributionRows.map(rowToContribution);
  if (contributions.length === 0) return { contributions: [], contacts: [] };

  const hashes = Array.from(new Set(contributions.map((c) => c.contactHash)));
  const contactRows = await db
    .select()
    .from(cgContacts)
    .where(inArray(cgContacts.contactHash, hashes));

  return { contributions, contacts: contactRows.map(rowToContact) };
}

/** Confidence with time decay applied. Behaviour unchanged. */
export function liveConfidence(
  contact: ContactRecord,
  contributorCount: number,
  now: Date = new Date(),
): number {
  return currentConfidence(
    {
      lastVerifiedAt: contact.lastVerifiedAt,
      firstSeenAt: contact.firstSeenAt,
      lastSeenAt: contact.lastSeenAt,
      sightingCount: contact.sightingCount,
      contributorCount,
    },
    now,
  );
}
