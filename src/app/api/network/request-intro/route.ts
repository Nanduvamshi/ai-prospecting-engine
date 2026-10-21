import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { createIntroRequest } from '@/server/network/intro-requests';
import { getContactByEmail, getOrgParticipation } from '@/server/network/contact-graph-db';
import { isContactGraphEnabled } from '@/server/network/config';

export const dynamic = 'force-dynamic';

// POST /api/contact-graph/request-intro
// Body: { email: string, message: string }
// Creates a warm-intro request routed to the oldest contributor (the person
// most likely to have a real relationship with the prospect).
export async function POST(request: NextRequest) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isContactGraphEnabled()) {
    return NextResponse.json({ error: 'Contact graph feature not enabled' }, { status: 503 });
  }

  // Requester's org must be a participating contributor
  const participation = await getOrgParticipation(user.orgId);
  if (!participation.optedIn) {
    return NextResponse.json(
      { error: 'Your org must opt in to the contact graph to request intros' },
      { status: 403 },
    );
  }

  try {
    const body = await request.json();
    const email: string = body?.email;
    const message: string = body?.message || '';
    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'email required' }, { status: 400 });
    }

    const contact = await getContactByEmail(email);
    if (!contact) {
      return NextResponse.json({ error: 'No graph record exists for this contact' }, { status: 404 });
    }

    const introRequest = await createIntroRequest({
      contactHash: contact.contactHash,
      requesterOrgId: user.orgId,
      requesterUserId: user.sub,
      message,
    });

    if (!introRequest) {
      return NextResponse.json({
        error: 'No eligible contributor found (you may be the only contributor for this contact)',
      }, { status: 409 });
    }

    // TODO post-legal-signoff: fire a notification to introRequest.targetUserId
    // via the existing notifications / workflow-engine. For MVP we only write
    // the record; a background worker can poll + fan out notifications.

    return NextResponse.json({
      introRequest: {
        status: introRequest.status,
        createdAt: introRequest.createdAt,
        // Deliberately not returning targetUserId — that's an internal routing detail
      },
    });
  } catch {
    return NextResponse.json({ error: 'Intro request failed' }, { status: 500 });
  }
}
