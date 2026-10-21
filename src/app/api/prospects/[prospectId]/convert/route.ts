import { actorOf, fail, ok, withAuth } from '@/server/http';
import { convertProspectToContact } from '@/server/prospects/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ prospectId: string }> };

/** POST /api/prospects/[prospectId]/convert — promote a prospect to a contact. */
export const POST = withAuth<Ctx>(async (_request, user, { params }) => {
  const { prospectId } = await params;
  const result = await convertProspectToContact(user.orgId, prospectId, actorOf(user));

  if (!result.ok) {
    // Each reason gets its own message: "couldn't convert" with no explanation
    // is the kind of error that generates a support ticket.
    switch (result.reason) {
      case 'not_found':
        return fail('Prospect not found', 404);
      case 'already_converted':
        return fail('This prospect has already been converted', 409);
      case 'no_email':
        return fail('A prospect needs an email address before it can be converted', 422);
      case 'contact_exists':
        return fail('A contact with this email address already exists', 409);
    }
  }

  return ok({ message: 'Prospect converted', contact: result.contact }, { status: 201 });
});
