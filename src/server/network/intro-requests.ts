import 'server-only';

/**
 * Contact graph — warm-intro request flow.
 *
 * When someone discovers that a user at another org has contributed contact
 * details for a prospect, they can ask for a warm introduction rather than
 * being handed the details outright.
 *
 * Flow:
 *  1. Requester posts a contactHash plus a message.
 *  2. The earliest contributor — the person who has known the contact
 *     longest, and so most likely has a real relationship — is chosen.
 *  3. A request record is written and a notification fires to them.
 *  4. They accept, which reveals their details to the requester, or decline.
 *
 * This module is the data layer only. Notification delivery belongs to the
 * calling route.
 */

import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { cgIntroRequests } from '@/server/db/schema';
import { getContributors } from './contact-graph-db';

export type IntroStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface IntroRequest {
  contactHash: string;
  requesterOrgId: string;
  requesterUserId: string;
  /** The contributor this request was routed to. */
  targetOrgId: string;
  targetUserId: string;
  message: string;
  status: IntroStatus;
  createdAt: string;
  resolvedAt?: string;
}

function generateId(): string {
  return `intro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function rowToRequest(row: typeof cgIntroRequests.$inferSelect): IntroRequest {
  return {
    contactHash: row.contactHash,
    requesterOrgId: row.requesterOrgId,
    requesterUserId: row.requesterUserId,
    targetOrgId: row.targetOrgId,
    targetUserId: row.targetUserId,
    message: row.message ?? '',
    status: row.status as IntroStatus,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.respondedAt?.toISOString(),
  };
}

/**
 * Choose who to route an intro request to.
 *
 * Oldest firstSeenAt wins, and the requester's own org is excluded — there is
 * no point asking yourself for an introduction.
 */
async function pickTargetContributor(
  contactHash: string,
  requesterOrgId: string,
): Promise<{ orgId: string; userId: string } | null> {
  const contributors = await getContributors(contactHash);
  const eligible = contributors.filter((c) => c.orgId !== requesterOrgId);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => (a.firstSeenAt || '').localeCompare(b.firstSeenAt || ''));
  return { orgId: eligible[0].orgId, userId: eligible[0].userId };
}

/**
 * Create an intro request.
 *
 * Returns null when nobody eligible exists — either the requester's org is
 * the only contributor, or nobody else knows this contact.
 */
export async function createIntroRequest(opts: {
  contactHash: string;
  requesterOrgId: string;
  requesterUserId: string;
  message: string;
}): Promise<IntroRequest | null> {
  const target = await pickTargetContributor(opts.contactHash, opts.requesterOrgId);
  if (!target) return null;

  const [row] = await db
    .insert(cgIntroRequests)
    .values({
      requestId: generateId(),
      contactHash: opts.contactHash,
      requesterOrgId: opts.requesterOrgId,
      requesterUserId: opts.requesterUserId,
      targetOrgId: target.orgId,
      targetUserId: target.userId,
      message: opts.message,
      status: 'pending',
    })
    .returning();

  return rowToRequest(row);
}

/**
 * A contributor's pending intro requests.
 *
 * An ordinary index lookup on the target user, cheap enough that the inbox
 * can be shown to anyone.
 */
export async function listPendingIntroRequestsForUser(
  targetUserId: string,
): Promise<IntroRequest[]> {
  const rows = await db
    .select()
    .from(cgIntroRequests)
    .where(
      and(eq(cgIntroRequests.targetUserId, targetUserId), eq(cgIntroRequests.status, 'pending')),
    )
    .orderBy(desc(cgIntroRequests.createdAt))
    .limit(100);

  return rows.map(rowToRequest);
}

export async function respondToIntroRequest(opts: {
  contactHash: string;
  requestCreatedAt: string;
  requesterUserId: string;
  responderUserId: string;
  accept: boolean;
}): Promise<void> {
  await db
    .update(cgIntroRequests)
    .set({
      status: opts.accept ? 'accepted' : 'declined',
      respondedAt: new Date(),
    })
    .where(
      and(
        eq(cgIntroRequests.contactHash, opts.contactHash),
        eq(cgIntroRequests.requesterUserId, opts.requesterUserId),
        eq(cgIntroRequests.createdAt, new Date(opts.requestCreatedAt)),
        // Only the routed contributor may answer, and only while it is open.
        eq(cgIntroRequests.targetUserId, opts.responderUserId),
        eq(cgIntroRequests.status, 'pending'),
      ),
    );
}

/** Current status of a requester's request for a contact, if any. */
export async function getIntroRequestStatus(
  contactHash: string,
  requesterUserId: string,
): Promise<IntroStatus | null> {
  const rows = await db
    .select({ status: cgIntroRequests.status })
    .from(cgIntroRequests)
    .where(
      and(
        eq(cgIntroRequests.contactHash, contactHash),
        eq(cgIntroRequests.requesterUserId, requesterUserId),
      ),
    )
    .orderBy(desc(cgIntroRequests.createdAt))
    .limit(1);

  return (rows[0]?.status as IntroStatus) ?? null;
}
